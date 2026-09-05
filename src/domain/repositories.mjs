// Repositories — the only code that writes tables. The admission pipeline and
// the API both go through here so that every status change emits an EventLog
// entry and passes the state machine, with no second path around either.
import { randomUUID } from "node:crypto";
import {
  Status,
  ExecutionStatus,
  assertTransition,
  isExecutionTerminal,
} from "./state-machine.mjs";
import { PROFILES } from "./brains.mjs";
import { nullLogger } from "./logger.mjs";

/**
 * Validates a workspace path before it can ever reach an agent.
 *
 * The mount contract is that host and container paths are identical, so a
 * relative path produces an agent that works nowhere, and `..` lets someone
 * aim an agent outside the canonical tree entirely. Both were accepted before
 * this check existed. `SEMANGGI_WORKSPACE_ROOT` optionally pins an allowed
 * prefix; without it the structural rules still apply.
 */
export function assertWorkspacePath(path, { root = process.env.SEMANGGI_WORKSPACE_ROOT ?? null } = {}) {
  if (typeof path !== "string" || path.length === 0) throw new Error("workspacePath is required");
  if (!path.startsWith("/")) throw new Error(`workspacePath must be absolute, got "${path}"`);
  if (path.split("/").includes("..")) {
    throw new Error(`workspacePath must not traverse with "..", got "${path}"`);
  }
  if (path.includes("\\0")) throw new Error("workspacePath must not contain a null byte");
  if (root && !(path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`))) {
    throw new Error(`workspacePath must live under ${root}, got "${path}"`);
  }
  return path;
}
import { EventKind } from "./events.mjs";

const json = (v, fallback) => {
  try {
    return v === null || v === undefined ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};

export function shortId(prefix) {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

const hydrateTask = (r) =>
  r && {
    ...r,
    model_policy: json(r.model_policy, {}),
    expedite_until: r.expedite_until ?? null,
  };

const hydrateWorker = (r) =>
  r && {
    ...r,
    skills: json(r.skills, []),
    model_policy: json(r.model_policy, {}),
    subagent_policy: json(r.subagent_policy, {}),
    project_access: json(r.project_access, []),
  };

const hydrateResource = (r) => r && { ...r, quota_policy: json(r.quota_policy, {}) };

export function createRepositories(store, events, { now = () => Date.now(), log = nullLogger } = {}) {
  const projects = {
    async create({
      id = shortId("PRJ"),
      name,
      weight = 1,
      workspacePath,
      status = "ACTIVE",
      template = "software",
      profile = "balanced",
    }) {
      assertWorkspacePath(workspacePath);
      if (!PROFILES.includes(profile)) {
        throw new Error(`profile must be one of ${PROFILES.join("/")}, got "${profile}"`);
      }
      await store.run(
        `INSERT INTO projects (id, name, weight, status, workspace_path, template, profile, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, weight, status, workspacePath, String(template ?? "software").toLowerCase(), profile, now()],
      );
      return projects.get(id);
    },
    get: (id) => store.get(`SELECT * FROM projects WHERE id = ?`, [id]),
    list: () => store.all(`SELECT * FROM projects ORDER BY name`),

    /**
     * Project-level settings a team shares, not an individual operator's
     * per-request choice (D37). Deliberately narrow: `template` and `profile`
     * are the only fields exposed here. Renaming a project or moving its
     * workspace are different, riskier operations (the latter would strand
     * every task's recorded `workspace_path`) and get their own path if they
     * are ever needed.
     */
    async update(id, { template, profile, actor = "operator" } = {}) {
      const project = await projects.get(id);
      if (!project) throw new Error(`unknown project ${id}`);

      const sets = [];
      const params = [];
      if (template !== undefined) {
        const next = String(template ?? "").trim().toLowerCase();
        if (!next) throw new Error("template must not be empty");
        sets.push("template = ?");
        params.push(next);
      }
      if (profile !== undefined) {
        if (!PROFILES.includes(profile)) {
          throw new Error(`profile must be one of ${PROFILES.join("/")}, got "${profile}"`);
        }
        sets.push("profile = ?");
        params.push(profile);
      }
      if (sets.length === 0) return project;

      params.push(id);
      await store.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, params);
      const after = await projects.get(id);
      await events.append({
        kind: "project.settings-changed",
        subjectType: "project",
        subjectId: id,
        actor,
        payload: {
          from: { template: project.template, profile: project.profile },
          to: { template: after.template, profile: after.profile },
        },
      });
      log.info("project.settings-changed", { project: id, actor, template: after.template, profile: after.profile });
      return after;
    },

    /**
     * Hapus project dan seluruh konfigurasinya (role levels, workers access).
     * Task yang sudah dibuat TIDAK dihapus (event log append-only) — mereka
     * tetap ada di history tapi tidak lagi terikat ke project yang aktif.
     * Workspace di NFS juga tidak dihapus (operator yang memutuskan).
     */
    async delete(id, { actor = "operator" } = {}) {
      const project = await projects.get(id);
      if (!project) throw new Error(`unknown project ${id}`);

      await store.run(`DELETE FROM project_role_levels WHERE project_id = ?`, [id]);
      await store.run(`DELETE FROM projects WHERE id = ?`, [id]);

      await events.append({
        kind: "project.deleted",
        subjectType: "project",
        subjectId: id,
        actor,
        payload: { name: project.name, workspacePath: project.workspacePath },
      });
      log.info("project.deleted", { project: id, name: project.name, actor });
      return { deleted: true, projectId: id };
    },

    /**
     * Pemetaan role -> level MILIK SATU PROJECT (bukan role_levels global).
     *
     * Ditulis sebagai satu snapshot penuh (`replace`), bukan upsert per baris:
     * begitu operator menyimpan modal Project Role Level, project itu punya
     * pemetaannya sendiri secara utuh, dan tidak lagi otomatis mengikuti
     * role_levels global kalau global berubah kemudian. Role di luar kosakata
     * template diterima — project nyata kadang mendaftarkan role tambahan.
     */
    roleLevels: {
      list: (projectId) =>
        store.all(`SELECT role, level FROM project_role_levels WHERE project_id = ? ORDER BY role`, [projectId]),

      async replace(projectId, entries, { actor = "operator" } = {}) {
        const project = await projects.get(projectId);
        if (!project) throw new Error(`unknown project ${projectId}`);
        const rows = (entries ?? []).filter((e) => e && e.role && e.level);
        for (const { level } of rows) {
          if (!["low", "normal", "critical"].includes(level)) {
            throw new Error(`invalid level "${level}"`);
          }
        }
        await store.run(`DELETE FROM project_role_levels WHERE project_id = ?`, [projectId]);
        for (const { role, level } of rows) {
          await store.run(
            `INSERT INTO project_role_levels (project_id, role, level, actor, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [projectId, String(role).toLowerCase(), level, actor, now()],
          );
        }
        await events.append({
          kind: "project.role-levels-changed",
          subjectType: "project",
          subjectId: projectId,
          actor,
          payload: { roleLevels: rows },
        });
        log.info("project.role-levels-changed", { project: projectId, actor, count: rows.length });
        return projects.roleLevels.list(projectId);
      },
    },

    // Fairness input: dispatches per project inside a rolling window. Derived
    // from the execution table rather than an in-memory counter so a restarted
    // controller resumes the same fairness position (P4-04 + P4-11). The window
    // keeps ancient history from permanently penalising a busy project.
    async dispatchCounts({ windowMs = 24 * 60 * 60 * 1000 } = {}) {
      const since = now() - windowMs;
      const rows = await store.all(
        `SELECT t.project_id AS project_id, COUNT(*) AS n
           FROM executions e JOIN tasks t ON t.id = e.task_id
          WHERE e.created_at >= ?
          GROUP BY t.project_id`,
        [since],
      );
      return new Map(rows.map((r) => [r.project_id, r.n]));
    },
  };

  const workers = {
    async create({
      id = shortId("WRK"),
      role,
      agentRef,
      skills = [],
      modelPolicy = {},
      subagentPolicy = {},
      projectAccess = [],
      maxConcurrent = 1,
      status = "ACTIVE",
    }) {
      await store.run(
        `INSERT INTO workers (id, role, agent_ref, skills, model_policy, subagent_policy,
                              project_access, max_concurrent, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          role,
          agentRef,
          JSON.stringify(skills),
          JSON.stringify(modelPolicy),
          JSON.stringify(subagentPolicy),
          JSON.stringify(projectAccess),
          maxConcurrent,
          status,
          now(),
        ],
      );
      return workers.get(id);
    },
    async get(id) {
      return hydrateWorker(await store.get(`SELECT * FROM workers WHERE id = ?`, [id]));
    },
    async list() {
      return (await store.all(`SELECT * FROM workers ORDER BY id`)).map(hydrateWorker);
    },
    // Occupancy is counted from live executions rather than a counter column,
    // so a crashed controller cannot leave a stale reservation behind (P4-11).
    async activeCount(workerId) {
      const row = await store.get(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE worker_id = ? AND status IN (?, ?)`,
        [workerId, Status.DISPATCHED, Status.RUNNING],
      );
      return row?.n ?? 0;
    },

    /**
     * D43: the least-loaded ACTIVE worker that may take this project — and
     * matches the role when one is asked for. Lifted out of Slack's pickWorker
     * (D29) so every task-creating surface matches the same way: spec induk
     * §2.4 binds such surfaces to assign a worker or refuse to create, while
     * admission only ever validates the assignment, never makes it.
     *
     * Least-loaded rather than first-found: otherwise one worker carries every
     * task while the others idle, and the queue looks busy for a reason that
     * isn't real. Ties break on id so the choice is reproducible in tests and
     * in the log.
     */
    async match({ projectId, role = null } = {}) {
      const eligible = [];
      for (const w of await workers.list()) {
        if (w.status !== "ACTIVE") continue;
        if (w.project_access.length > 0 && !w.project_access.includes(projectId)) continue;
        if (role !== null && String(w.role ?? "").toLowerCase() !== String(role).toLowerCase()) continue;
        eligible.push({ worker: w, active: await workers.activeCount(w.id) });
      }
      if (!eligible.length) return null;
      eligible.sort((a, b) => a.active - b.active || String(a.worker.id).localeCompare(String(b.worker.id)));
      return eligible[0].worker;
    },
  };

  const tasks = {
    async create({
      id = shortId("TASK"),
      projectId,
      parentTaskId = null,
      title,
      description = "",
      priority = 2,
      qualityClass = "L2",
      workerId = null,
      sessionPolicy = "FRESH",
      modelPolicy = {},
      approvalLevel = "L0",
      workspacePath = null,
      // 'write' takes an exclusive workspace lease; 'read' shares with other
      // readers. Defaults to 'write' so a task never becomes shareable by
      // omission — sharing has to be asked for.
      workspaceMode = "write",
      dependsOn = [],
    }) {
      // An instruction is sent to a provider verbatim and billed by the token.
      // Without a bound, one oversized description is a denial-of-wallet: a 2MB
      // body was accepted before this check existed. The limit is generous —
      // real instructions are kilobytes — and refusing beats truncating, which
      // would silently send a half-instruction and bill for it.
      const MAX_INSTRUCTION = Number(process.env.SEMANGGI_MAX_INSTRUCTION_BYTES ?? 64 * 1024);
      const size = Buffer.byteLength(String(description ?? ""), "utf8");
      if (size > MAX_INSTRUCTION) {
        throw new Error(
          `task description is ${size} bytes, over the ${MAX_INSTRUCTION} byte limit; ` +
            `split the work or raise SEMANGGI_MAX_INSTRUCTION_BYTES deliberately`,
        );
      }

      if (workspacePath !== null && workspacePath !== undefined) assertWorkspacePath(workspacePath);

      const ts = now();
      await store.tx(async () => {
        await store.run(
          `INSERT INTO tasks (id, project_id, parent_task_id, title, description, priority,
                              quality_class, status, worker_id, session_policy, model_policy,
                              approval_level, workspace_path, workspace_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            projectId,
            parentTaskId,
            title,
            description,
            priority,
            qualityClass,
            Status.CREATED,
            workerId,
            sessionPolicy,
            JSON.stringify(modelPolicy),
            approvalLevel,
            workspacePath,
            workspaceMode === "read" ? "read" : "write",
            ts,
            ts,
          ],
        );
        for (const dep of dependsOn) {
          await store.run(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`,
            [id, dep],
          );
        }
        await events.append({
          kind: EventKind.TASK_CREATED,
          subjectType: "task",
          subjectId: id,
          payload: { projectId, title, priority, qualityClass, approvalLevel, dependsOn },
        });
      });
      return tasks.get(id);
    },

    async get(id) {
      return hydrateTask(await store.get(`SELECT * FROM tasks WHERE id = ?`, [id]));
    },

    async list({ status, projectId, limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (status) (where.push("status = ?"), params.push(status));
      if (projectId) (where.push("project_id = ?"), params.push(projectId));
      const rows = await store.all(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at ASC LIMIT ?`,
        [...params, limit],
      );
      return rows.map(hydrateTask);
    },

    async dependencies(taskId) {
      return store.all(
        `SELECT d.depends_on_task_id AS id, t.status
           FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
          WHERE d.task_id = ?`,
        [taskId],
      );
    },

    async setStatus(taskId, next, { reason = null, waitDetail = null, actor = "controller" } = {}) {
      return store.tx(async () => {
        const task = await tasks.get(taskId);
        if (!task) throw new Error(`unknown task ${taskId}`);
        if (task.status === next && task.wait_reason === waitDetail) return task;
        assertTransition(task.status, next, { reason });
        await store.run(`UPDATE tasks SET status = ?, wait_reason = ?, updated_at = ? WHERE id = ?`, [
          next,
          waitDetail,
          now(),
          taskId,
        ]);
        // Backoff is for AUTOMATIC retries. Something that deliberately puts a
        // task back in the queue — a revision, an approval decision, an
        // operator — is new information, and making it wait out a backoff it
        // had no part in would feel broken to whoever just acted.
        if (next === Status.QUEUED && actor !== "controller") {
          await store.run(`UPDATE tasks SET next_retry_at = NULL WHERE id = ?`, [taskId]);
        }

        await events.append({
          kind: EventKind.TASK_STATUS,
          subjectType: "task",
          subjectId: taskId,
          actor,
          payload: { from: task.status, to: next, reason, waitDetail },
        });
        // Every status change, including the boring ones. A queue that "does
        // nothing" is almost always doing something once per pass, and this is
        // the line that shows it.
        log.info("task.status", {
          task: taskId, from: task.status, to: next, actor,
          reason: reason ?? null, project: task.project_id, worker: task.worker_id ?? null,
        });
        return tasks.get(taskId);
      });
    },

    async assign(taskId, workerId) {
      await store.run(`UPDATE tasks SET worker_id = ?, updated_at = ? WHERE id = ?`, [
        workerId,
        now(),
        taskId,
      ]);
      return tasks.get(taskId);
    },

    // A revision does not mutate history (spec induk §5.2): the previous
    // Execution rows stay frozen and the task is re-queued carrying only the
    // new session mode and instruction.
    async createRevision(taskId, { sessionMode, instruction, modelPolicy, actor = "operator" }) {
      return store.tx(async () => {
        const task = await tasks.get(taskId);
        if (!task) throw new Error(`unknown task ${taskId}`);
        if (!["CONTINUE", "FORK", "FRESH"].includes(sessionMode)) {
          throw new Error(`invalid session mode "${sessionMode}"`);
        }
        // A revision may also change the routing. "Run that again, but on the
        // stronger model" is one of the most common things an operator wants,
        // and making it two calls invites the second one being forgotten.
        if (modelPolicy !== undefined) {
          await store.run(`UPDATE tasks SET model_policy = ? WHERE id = ?`, [
            JSON.stringify(modelPolicy ?? {}),
            taskId,
          ]);
        }
        await store.run(
          `UPDATE tasks SET session_policy = ?, pending_instruction = ?, updated_at = ? WHERE id = ?`,
          [sessionMode, instruction, now(), taskId],
        );
        // BLOCKED cannot go straight back to QUEUED — the state machine routes
        // a paused task through RESUMABLE on purpose, so "this was stopped and
        // is being picked up again" stays visible in the history rather than
        // looking like it never stopped.
        const current = await tasks.get(taskId);
        if (current.status === Status.BLOCKED) {
          await tasks.setStatus(taskId, Status.RESUMABLE, { reason: "revision", actor });
        }
        await tasks.setStatus(taskId, Status.QUEUED, { reason: "revision", actor });
        return tasks.get(taskId);
      });
    },

    async consumePendingInstruction(taskId) {
      const task = await tasks.get(taskId);
      await store.run(`UPDATE tasks SET pending_instruction = NULL WHERE id = ?`, [taskId]);
      return task?.pending_instruction ?? null;
    },

    // Recorded at dispatch so lease release and queue introspection do not have
    // to re-derive the path and risk disagreeing with the lease holder.
    async setWorkspacePath(taskId, path) {
      await store.run(`UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?`, [
        path,
        now(),
        taskId,
      ]);
    },

    /**
     * Operator edits to a task that has not been dispatched yet, or has stopped.
     *
     * The point is to be able to stock work, then change the model or effort and
     * run it again — without re-typing the instruction or losing the history.
     * Refused while the task is actively running: changing the routing of a run
     * already in flight would make the record disagree with what actually ran,
     * and the execution row is immutable for exactly that reason.
     */
    /**
     * Change the plan of a task that is not currently running.
     *
     * `workspacePath` and `workerId` were added after three tasks parked
     * permanently on the cluster for reasons no endpoint could fix:
     *
     *   WAIT_RESOURCE  a per-task workspace with no agent bound to it
     *   WAIT_WORKER    a worker without access to the task's project
     *
     * Both are plan mistakes, not failures, and both were previously
     * unreachable — leaving `UPDATE tasks SET …` by hand as the only way out.
     * That would be the wrong fix in a system whose audit trail is an
     * append-only log: a hand-edited row makes the log describe a history that
     * did not happen.
     */
    async updatePlan(
      taskId,
      { modelPolicy, priority, qualityClass, workspaceMode, workspacePath, workerId, actor = "operator" } = {},
    ) {
      const task = await tasks.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      if ([Status.DISPATCHED, Status.RUNNING].includes(task.status)) {
        throw new Error(
          `task ${taskId} is ${task.status}; cancel it or wait for the run to end before changing its plan`,
        );
      }

      const sets = [];
      const params = [];
      if (modelPolicy !== undefined) {
        sets.push("model_policy = ?");
        params.push(JSON.stringify(modelPolicy ?? {}));
      }
      if (priority !== undefined) {
        if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
          throw new Error(`priority must be an integer P0..P4, got ${priority}`);
        }
        sets.push("priority = ?");
        params.push(priority);
      }
      if (qualityClass !== undefined) {
        sets.push("quality_class = ?");
        params.push(qualityClass);
      }
      if (workspaceMode !== undefined) {
        if (!["read", "write"].includes(workspaceMode)) {
          throw new Error(`workspaceMode must be "read" or "write", got "${workspaceMode}"`);
        }
        sets.push("workspace_mode = ?");
        params.push(workspaceMode);
      }
      if (workspacePath !== undefined) {
        // null clears the override so the task falls back to its project's
        // workspace — which is the fix for a task stranded in a per-task
        // directory that has no agent bound to it.
        if (workspacePath !== null) assertWorkspacePath(workspacePath);
        sets.push("workspace_path = ?");
        params.push(workspacePath);
      }
      if (workerId !== undefined) {
        if (workerId !== null) {
          const worker = await workers.get(workerId);
          if (!worker) throw new Error(`unknown worker ${workerId}`);
          if (worker.status !== "ACTIVE") throw new Error(`worker ${workerId} is ${worker.status}, not ACTIVE`);
          // Refuse now rather than let admission park the task on WAIT_WORKER
          // for the same reason later. The operator is standing here; telling
          // them immediately is cheaper than a silent wait they have to
          // diagnose.
          if (worker.project_access.length > 0 && !worker.project_access.includes(task.project_id)) {
            throw new Error(
              `worker ${workerId} has no access to ${task.project_id}; ` +
                `grant it access or pick a worker that has it`,
            );
          }
        }
        sets.push("worker_id = ?");
        params.push(workerId);
      }
      if (sets.length === 0) return task;

      // A plan change voids the retry backoff.
      //
      // The backoff exists to stop the scheduler hammering a task whose
      // situation has not changed (D24). A human editing the plan is precisely
      // the situation changing — so keeping the timer would make the fix look
      // like it did nothing for up to fifteen minutes. Measured on the cluster:
      // a task whose stranded workspace had just been cleared still sat with
      // 819 seconds on the clock and the old wait_reason still displayed.
      //
      // The stale reason goes too. It describes a decision taken under a plan
      // that no longer exists, and leaving it on screen is a small lie the
      // operator has no way to distinguish from a real one.
      sets.push("next_retry_at = NULL", "wait_reason = NULL");

      sets.push("updated_at = ?");
      params.push(now(), taskId);
      await store.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, params);

      const after = await tasks.get(taskId);
      await events.append({
        kind: EventKind.TASK_STATUS,
        subjectType: "task",
        subjectId: taskId,
        actor,
        payload: {
          change: "plan",
          from: {
            modelPolicy: task.model_policy, priority: task.priority, qualityClass: task.quality_class,
            workspaceMode: task.workspace_mode, workspacePath: task.workspace_path, workerId: task.worker_id,
          },
          to: {
            modelPolicy: after.model_policy, priority: after.priority, qualityClass: after.quality_class,
            workspaceMode: after.workspace_mode, workspacePath: after.workspace_path, workerId: after.worker_id,
          },
        },
      });
      log.info("task.plan-changed", {
        task: taskId, actor,
        modelPolicy: after.model_policy, priority: after.priority,
        qualityClass: after.quality_class, workspaceMode: after.workspace_mode,
        workspacePath: after.workspace_path, worker: after.worker_id,
      });
      return after;
    },

    async setRetryAt(taskId, at) {
      await store.run(`UPDATE tasks SET next_retry_at = ?, updated_at = ? WHERE id = ?`, [
        at,
        now(),
        taskId,
      ]);
    },

    // Expedite is a TTL boost, never a permanent priority rewrite (P4-05): the
    // stored priority is left alone and only the selector reads expedite_until.
    async expedite(taskId, { ttlMs, actor = "operator" }) {
      const until = now() + ttlMs;
      await store.run(`UPDATE tasks SET expedite_until = ?, updated_at = ? WHERE id = ?`, [
        until,
        now(),
        taskId,
      ]);
      await events.append({
        kind: EventKind.TASK_EXPEDITED,
        subjectType: "task",
        subjectId: taskId,
        actor,
        payload: { until, ttlMs },
      });
      return tasks.get(taskId);
    },

    async cancel(taskId, { actor = "operator", note = null } = {}) {
      const task = await tasks.setStatus(taskId, Status.CANCELLED, { reason: "cancelled", actor });
      await events.append({
        kind: EventKind.TASK_CANCELLED,
        subjectType: "task",
        subjectId: taskId,
        actor,
        payload: { note },
      });
      return task;
    },
  };

  const executions = {
    async create({
      taskId,
      sessionMode = "FRESH",
      instruction = "",
      modelProvider = null,
      modelId = null,
      mode = "interactive",
      sessionRef = null,
    }) {
      return store.tx(async () => {
        const last = await store.get(
          `SELECT MAX(revision_no) AS n FROM executions WHERE task_id = ?`,
          [taskId],
        );
        const revisionNo = (last?.n ?? 0) + 1;

        // CONTINUE resumes the previous conversation. FORK does NOT inherit the
        // ref, and that is deliberate rather than an oversight: on this gateway
        // the conversation is addressed only by sessionKey, and there is no API
        // to clone a session. Inheriting the ref would make FORK reuse the very
        // same key — which is exactly what happened live, where four revisions
        // came back sharing one session id. So FORK starts a new conversation
        // and records its parent, and the fact that history is not carried over
        // is stated plainly rather than implied by the name (see sessionKeyFor).
        // CONTINUE needs the harness session to resume from; FRESH
        // deliberately does not. Inheriting here rather than at the call site
        // means every dispatch path gets it right without remembering to.
        if (!sessionRef && sessionMode === "CONTINUE") {
          const previous = await store.get(
            `SELECT session_ref FROM executions
              WHERE task_id = ? AND session_ref IS NOT NULL
              ORDER BY revision_no DESC LIMIT 1`,
            [taskId],
          );
          sessionRef = previous?.session_ref ?? null;
        }
        const id = `${taskId}#${revisionNo}`;
        await store.run(
          `INSERT INTO executions (id, task_id, revision_no, session_mode, session_ref,
                                   model_provider, model_id, mode, status, instruction, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            taskId,
            revisionNo,
            sessionMode,
            sessionRef,
            modelProvider,
            modelId,
            mode,
            ExecutionStatus.PENDING,
            instruction,
            now(),
          ],
        );
        await events.append({
          kind: EventKind.REVISION_CREATED,
          subjectType: "task",
          subjectId: taskId,
          payload: { executionId: id, revisionNo, sessionMode, modelProvider, modelId },
        });
        return executions.get(id);
      });
    },

    get: (id) => store.get(`SELECT * FROM executions WHERE id = ?`, [id]),

    /**
     * Executions that were handed to a runtime and then went quiet.
     *
     * D20: since D15 a terminal status arrives on the gateway's lifecycle
     * `end` event. A run that never really started — rejected after accept, or
     * lost when the gateway restarted — never emits one, so its execution sits
     * DISPATCHED forever holding a workspace lease. With one workspace per
     * project that freezes the whole project.
     *
     * `created_at` is the clock, not `started_at`: a run that never started has
     * no start time, and that is exactly the case being caught.
     */
    /** How many attempts for this task failed recently — the backoff input. */
    recentFailures: async (taskId, since) => {
      const row = await store.get(
        `SELECT COUNT(*) AS n FROM executions
          WHERE task_id = ? AND status IN ('FAILED','CANCELLED','BLOCKED') AND created_at >= ?`,
        [taskId, since],
      );
      return row?.n ?? 0;
    },

    stalled: (cutoff) =>
      store.all(
        `SELECT * FROM executions
          WHERE status IN ('DISPATCHED','RUNNING')
            AND finalized_at IS NULL
            AND created_at <= ?
          ORDER BY created_at ASC`,
        [cutoff],
      ),

    listByTask: (taskId) =>
      store.all(`SELECT * FROM executions WHERE task_id = ? ORDER BY revision_no ASC`, [taskId]),

    latest: (taskId) =>
      store.get(`SELECT * FROM executions WHERE task_id = ? ORDER BY revision_no DESC LIMIT 1`, [
        taskId,
      ]),

    async update(id, patch) {
      const allowed = [
        "session_ref",
        "session_key",
        "runtime_ref",
        "sandbox_ref",
        "model_provider",
        "model_id",
        "mode",
        "tokens_input",
        "tokens_output",
        "tokens_cache_read",
        "tokens_cache_creation",
        "cost",
        "cost_unit",
        "result",
        "started_at",
        "ended_at",
      ];
      const keys = Object.keys(patch).filter((k) => allowed.includes(k));
      if (keys.length === 0) return executions.get(id);
      await store.run(
        `UPDATE executions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
        [...keys.map((k) => patch[k]), id],
      );
      return executions.get(id);
    },

    /**
     * Records provider usage against an execution.
     *
     * Accepts both shapes POC-3 observed, because the two dispatch paths report
     * differently and normalising at the edge keeps the rest of the system from
     * caring which one ran:
     *   batch  `claude -p --output-format json` → usage.{input_tokens, output_tokens,
     *          cache_read_input_tokens, cache_creation_input_tokens}
     *   ACP    session/update usage_update      → {used, size, cost:{amount}}
     */
    async recordUsage(id, usage = {}, { costUnit } = {}) {
      // An unrecognised shape used to be written through as zeros — the exact
      // failure that hid D17 for a whole cycle, because "0 tokens" reads as a
      // fact rather than as "nobody told us". Refusing is louder and cheaper.
      const KNOWN = [
        "used", "input", "output", "cacheRead", "cacheWrite", "cost", "totalTokens",
        "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
        "inputTokens", "outputTokens", "prompt_tokens", "completion_tokens",
        "cacheReadInputTokens", "cacheCreationInputTokens",
      ];
      const keys = Object.keys(usage ?? {});
      if (keys.length > 0 && !keys.some((k) => KNOWN.includes(k))) {
        throw new Error(
          `unrecognised usage shape [${keys.join(", ")}]; recording it would silently store zeros`,
        );
      }
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const isAcp = usage.used !== undefined && usage.input_tokens === undefined;
      const patch = isAcp
        ? {
            // The ACP stream reports a running context total rather than a
            // per-turn split; storing it as input keeps one comparable number.
            tokens_input: n(usage.used),
            cost: n(usage.cost?.amount),
          }
        : {
            // Two producers, two spellings, both real: the batch path reports
            // `input_tokens`/`cache_read_input_tokens` (POC-3 E8) while the
            // gateway reports `input`/`cacheRead` (D17). Understanding both here
            // means a caller cannot accidentally store zeros by passing the
            // shape the other producer uses.
            tokens_input: n(usage.input_tokens ?? usage.input),
            tokens_output: n(usage.output_tokens ?? usage.output),
            tokens_cache_read: n(usage.cache_read_input_tokens ?? usage.cacheRead),
            tokens_cache_creation: n(usage.cache_creation_input_tokens ?? usage.cacheWrite),
            // A caller that already knows the money figure (a metered provider
            // reporting cost.total) passes it through; otherwise cost falls back
            // to billable tokens below.
            ...(usage.cost !== undefined ? { cost: n(usage.cost) } : {}),
          };
      // POC-3 E8 settled the unit: on a subscription plan the CLI's
      // `total_cost_usd` corresponds to no invoice — it is an API price
      // estimate. What actually binds is tokens against the plan window. So
      // unless a caller supplies a real metered amount, cost IS the billable
      // token count, cache reads included.
      //
      // Without this the batch path left cost at 0 — the exact path E8
      // measured, where 92,663 cache reads sat against 8 fresh input tokens.
      if (patch.cost === undefined) {
        const merged = { ...(await executions.get(id)), ...patch };
        patch.cost = executions.billableTokens(merged);
        patch.cost_unit = costUnit ?? "tokens";
      } else if (costUnit) {
        patch.cost_unit = costUnit;
      }
      return executions.update(id, patch);
    },

    /**
     * Total tokens actually consumed. Cache reads are included deliberately:
     * they dominate real usage (POC-3 E8) and excluding them makes every
     * forecast wrong.
     */
    billableTokens(execution) {
      return (
        (execution?.tokens_input ?? 0) +
        (execution?.tokens_output ?? 0) +
        (execution?.tokens_cache_read ?? 0) +
        (execution?.tokens_cache_creation ?? 0)
      );
    },

    // Reaching a terminal status stamps finalized_at, and the DB trigger makes
    // every later write to that row fail. Immutability is therefore a property
    // of the schema, not a convention callers have to remember.
    async setStatus(id, next, { result = null } = {}) {
      return store.tx(async () => {
        const exec = await executions.get(id);
        if (!exec) throw new Error(`unknown execution ${id}`);
        const terminal = isExecutionTerminal(next);
        await store.run(
          `UPDATE executions
              SET status = ?, result = COALESCE(?, result),
                  started_at = COALESCE(started_at, ?),
                  ended_at = ?, finalized_at = ?
            WHERE id = ?`,
          [
            next,
            result,
            next === ExecutionStatus.RUNNING ? now() : exec.started_at,
            terminal ? now() : exec.ended_at,
            terminal ? now() : null,
            id,
          ],
        );
        await events.append({
          kind: EventKind.EXECUTION_STATUS,
          subjectType: "execution",
          subjectId: id,
          payload: { from: exec.status, to: next, result },
        });
        return executions.get(id);
      });
    },
  };

  const resources = {
    async upsert({
      provider,
      model,
      concurrencyLimit = 1,
      quotaPolicy = {},
      availability = "AVAILABLE",
      creditClass = "metered",
      nextAvailableAt = null,
      windowKind = null,
    }) {
      await store.run(
        `INSERT INTO resources (provider, model, concurrency_limit, quota_policy, availability,
                                credit_class, next_available_at, window_kind, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           concurrency_limit = excluded.concurrency_limit,
           quota_policy = excluded.quota_policy,
           availability = excluded.availability,
           credit_class = excluded.credit_class,
           next_available_at = excluded.next_available_at,
           window_kind = excluded.window_kind,
           updated_at = excluded.updated_at`,
        [
          provider,
          model,
          concurrencyLimit,
          JSON.stringify(quotaPolicy),
          availability,
          creditClass,
          nextAvailableAt,
          windowKind,
          now(),
        ],
      );
      return resources.get(provider, model);
    },

    async get(provider, model) {
      return hydrateResource(
        await store.get(`SELECT * FROM resources WHERE provider = ? AND model = ?`, [provider, model]),
      );
    },

    async list() {
      return (await store.all(`SELECT * FROM resources ORDER BY provider, model`)).map(hydrateResource);
    },

    async setAvailability(
      provider,
      model,
      availability,
      { nextAvailableAt = null, source = "controller", windowKind = null, signal = null } = {},
    ) {
      await store.run(
        `UPDATE resources SET availability = ?, next_available_at = ?, window_kind = ?,
                              last_quota_signal = ?, updated_at = ?
          WHERE provider = ? AND model = ?`,
        [availability, nextAvailableAt, windowKind, signal, now(), provider, model],
      );
      await events.append({
        kind: EventKind.RESOURCE_AVAILABILITY,
        subjectType: "resource",
        subjectId: `${provider}/${model}`,
        actor: source,
        payload: { availability, nextAvailableAt, windowKind, signal },
      });
      return resources.get(provider, model);
    },

    /**
     * Turns a provider refusal into a scheduling fact.
     *
     * POC-3 measured exactly what a Claude Pro exhaustion looks like:
     *   {"is_error":true,"api_error_status":429,
     *    "result":"You've hit your session limit · resets 9:40am (UTC)"}
     * and the ACP stream carries {rateLimitType:"five_hour", resetsAt:<epoch>}.
     * The reset is an absolute timestamp from the provider, so WAIT_QUOTA can
     * carry a real ETA instead of a guess.
     */
    async applyQuotaSignal(provider, model, { status, resetsAt = null, rateLimitType = null, message = null, retryAfterSeconds = null }) {
      const is429 = status === 429 || /rate limit|too many requests|session limit|usage limit/i.test(message ?? "");
      if (!is429) return resources.get(provider, model);
      const at = resetsAt
        ? resetsAt < 1e12
          ? resetsAt * 1000 // provider sends epoch seconds
          : resetsAt
        : retryAfterSeconds
          ? now() + retryAfterSeconds * 1000
          : null;
      return resources.setAvailability(provider, model, "QUOTA_EXHAUSTED", {
        nextAvailableAt: at,
        windowKind: rateLimitType,
        signal: message ? String(message).slice(0, 300) : null,
        source: "provider",
      });
    },

    async activeCount(provider, model) {
      const row = await store.get(
        `SELECT COUNT(*) AS n FROM executions
          WHERE model_provider = ? AND model_id = ? AND status IN (?, ?)`,
        [provider, model, ExecutionStatus.DISPATCHED, ExecutionStatus.RUNNING],
      );
      return row?.n ?? 0;
    },
  };

  const leases = {
    /** The first live holder, if any. Kept for callers that just ask "is it taken". */
    async get(path) {
      return store.get(`SELECT * FROM leases WHERE workspace_path = ? ORDER BY acquired_at ASC`, [path]);
    },

    /** Every holder of a path — several, when they are all readers. */
    async holders(path) {
      return store.all(`SELECT * FROM leases WHERE workspace_path = ? ORDER BY acquired_at ASC`, [path]);
    },

    list: () => store.all(`SELECT * FROM leases ORDER BY workspace_path, acquired_at`),

    // Read/write, not plain mutual exclusion:
    //   write — exclusive; refused while any live lease exists
    //   read  — shared; refused only while a live WRITER holds the path
    //
    // Acquisition happens inside a transaction, so two candidates racing for
    // one path cannot both win an exclusive lease (P4-07).
    async acquire({ workspacePath, executionId, owner, ttlMs, mode = "write" }) {
      return store.tx(async () => {
        const ts = now();
        const all = await leases.holders(workspacePath);

        // Expired holders are reclaimed first: an expired lease is not a claim,
        // and leaving it in place would deny live work on a dead one.
        for (const existing of all) {
          if (existing.expires_at > ts) continue;
          await store.run(`DELETE FROM leases WHERE workspace_path = ? AND execution_id = ?`, [
            workspacePath,
            existing.execution_id,
          ]);
          const stale = await executions.get(existing.execution_id);
          if (stale && !isExecutionTerminal(stale.status)) {
            await executions.setStatus(existing.execution_id, ExecutionStatus.BLOCKED, {
              result: "workspace lease expired; reclaimed by scheduler",
            });
          }
          await events.append({
            kind: EventKind.LEASE_RECLAIMED,
            subjectType: "lease",
            subjectId: workspacePath,
            payload: { previousOwner: existing.owner, previousExecution: existing.execution_id },
          });
        }

        const live = (await leases.holders(workspacePath)).filter((l) => l.expires_at > ts);
        const mine = live.find((l) => l.execution_id === executionId);
        if (mine) return { ok: true, lease: mine, reentrant: true };

        const blocker =
          mode === "write"
            ? live[0]
            : live.find((l) => l.mode === "write");
        if (blocker) return { ok: false, holder: blocker, mode };

        const existing = null;
        if (existing) {
          if (existing.expires_at > ts) {
            return { ok: false, holder: existing };
          }
          // Expired: reclaim and mark the previous owner's execution BLOCKED
          // rather than silently stealing the path (POC-4 §5.5).
          await store.run(`DELETE FROM leases WHERE workspace_path = ?`, [workspacePath]);
          const stale = await executions.get(existing.execution_id);
          if (stale && !isExecutionTerminal(stale.status)) {
            await executions.setStatus(existing.execution_id, ExecutionStatus.BLOCKED, {
              result: "workspace lease expired; reclaimed by scheduler",
            });
          }
          await events.append({
            kind: EventKind.LEASE_RECLAIMED,
            subjectType: "lease",
            subjectId: workspacePath,
            payload: { previousOwner: existing.owner, previousExecution: existing.execution_id },
          });
        }
        await store.run(
          `INSERT INTO leases (workspace_path, execution_id, owner, mode, acquired_at, expires_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [workspacePath, executionId, owner, mode, ts, ts + ttlMs, ts],
        );
        await events.append({
          kind: EventKind.LEASE_ACQUIRED,
          subjectType: "lease",
          subjectId: workspacePath,
          payload: { executionId, owner, expiresAt: ts + ttlMs },
        });
        return { ok: true, lease: await leases.get(workspacePath) };
      });
    },

    /**
     * Extends ONE holder's lease.
     *
     * Per execution, not per path: with shared readers, renewing by path alone
     * would extend leases belonging to work that has already stopped.
     */
    async heartbeat(workspacePath, { executionId, ttlMs }) {
      const ts = now();
      await store.run(
        `UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE workspace_path = ? AND execution_id = ?`,
        [ts, ts + ttlMs, workspacePath, executionId],
      );
      return store.get(`SELECT * FROM leases WHERE workspace_path = ? AND execution_id = ?`, [
        workspacePath,
        executionId,
      ]);
    },

    /**
     * Releases ONE holder's lease.
     *
     * `executionId` is effectively required now that a path can be held by
     * several readers: dropping every row would evict work that never finished.
     * It stays optional only so an operator sweep can clear a path deliberately,
     * and that case is loud rather than implicit.
     */
    async release(workspacePath, { executionId = null, actor = "controller", all = false } = {}) {
      const holders = await leases.holders(workspacePath);
      if (holders.length === 0) return false;

      const targets = executionId
        ? holders.filter((l) => l.execution_id === executionId)
        : all
          ? holders
          : holders.length === 1
            ? holders
            : [];

      if (targets.length === 0) {
        // Several holders and no id: refusing beats guessing which one to evict.
        return false;
      }

      for (const t of targets) {
        await store.run(`DELETE FROM leases WHERE workspace_path = ? AND execution_id = ?`, [
          workspacePath,
          t.execution_id,
        ]);
        // A freed workspace is exactly the news a WAIT_WORKSPACE task was
        // waiting for, so its backoff no longer applies.
        await store.run(
          `UPDATE tasks SET next_retry_at = NULL WHERE workspace_path = ? AND status = ?`,
          [workspacePath, Status.WAIT_WORKSPACE],
        );
        await events.append({
          kind: EventKind.LEASE_RELEASED,
          subjectType: "lease",
          subjectId: workspacePath,
          actor,
          payload: { executionId: t.execution_id, mode: t.mode },
        });
      }
      return true;
    },
  };

  const approvals = {
    async create({
      id = shortId("APV"),
      taskId,
      executionId = null,
      level,
      question,
      options = ["APPROVE", "REJECT", "MODIFY", "COMMENT"],
    }) {
      await store.run(
        `INSERT INTO approvals (id, task_id, execution_id, level, question, options, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, taskId, executionId, level, question, JSON.stringify(options), now()],
      );
      await events.append({
        kind: EventKind.APPROVAL_REQUESTED,
        subjectType: "approval",
        subjectId: id,
        payload: { taskId, executionId, level, question, options },
      });
      return approvals.get(id);
    },

    async get(id) {
      const row = await store.get(`SELECT * FROM approvals WHERE id = ?`, [id]);
      return row && { ...row, options: json(row.options, []) };
    },

    async decidedForTask(taskId) {
      const rows = await store.all(
        `SELECT * FROM approvals WHERE task_id = ? AND decision IS NOT NULL ORDER BY decided_at ASC`,
        [taskId],
      );
      return rows.map((r) => ({ ...r, options: json(r.options, []) }));
    },

    async listForTask(taskId) {
      const rows = await store.all(
        `SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC`,
        [taskId],
      );
      return rows.map((r) => ({ ...r, options: json(r.options, []) }));
    },

    async pendingForTask(taskId) {
      const rows = await store.all(
        `SELECT * FROM approvals WHERE task_id = ? AND decision IS NULL ORDER BY created_at ASC`,
        [taskId],
      );
      return rows.map((r) => ({ ...r, options: json(r.options, []) }));
    },

    // COMMENT is not a decision: an operator note leaves the approval open, so
    // a task never resumes just because somebody typed something.
    async comment(id, { note, by }) {
      const approval = await approvals.get(id);
      if (!approval) throw new Error(`unknown approval ${id}`);
      await events.append({
        kind: EventKind.APPROVAL_DECIDED,
        subjectType: "approval",
        subjectId: id,
        actor: by,
        payload: { taskId: approval.task_id, decision: "COMMENT", note, closes: false },
      });
      return approval;
    },

    async decide(id, { decision, note = null, decidedBy }) {
      const approval = await approvals.get(id);
      if (!approval) throw new Error(`unknown approval ${id}`);
      if (approval.decision) throw new Error(`approval ${id} already decided`);
      if (decision === "COMMENT") {
        throw new Error("COMMENT does not close an approval; use the comment endpoint");
      }
      if (!approval.options.includes(decision)) {
        throw new Error(`decision "${decision}" is not one of ${approval.options.join("/")}`);
      }
      if (!decidedBy) throw new Error("decidedBy is required: approvals must be attributable");
      await store.run(
        `UPDATE approvals SET decision = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
        [decision, note, decidedBy, now(), id],
      );
      // A human just decided something, so any automatic backoff the task had
      // accumulated is stale. Clearing it here rather than at the API means it
      // holds for every caller, including the interposer bridge.
      await store.run(`UPDATE tasks SET next_retry_at = NULL WHERE id = ?`, [approval.task_id]);

      await events.append({
        kind: EventKind.APPROVAL_DECIDED,
        subjectType: "approval",
        subjectId: id,
        actor: decidedBy,
        payload: { taskId: approval.task_id, decision, note },
      });
      return approvals.get(id);
    },
  };

  /**
   * The model's side of the conversation.
   *
   * Correlated by session, not by run id — `session.message` carries no runId
   * at all, which is the same trap that made token accounting record zero for
   * days (D17). The session ref is what both sides share.
   */
  const MAX_MESSAGE_BYTES = Number(process.env.SEMANGGI_MAX_MESSAGE_BYTES ?? 32 * 1024);

  const messages = {
    /** Flattens the gateway's block array into displayable text. */
    flatten(content) {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((b) => {
          if (b?.type === "text") return b.text ?? "";
          // Tool calls are part of what happened and belong in the transcript,
          // but the raw arguments blob is not something a person reads.
          if (b?.type === "toolCall") return `[tool: ${b.name ?? "?"}]`;
          // What a tool printed — flattened to its output so searches and
          // clients without block support still see it (D48).
          if (b?.type === "toolResult") return b.text ?? "";
          // Reasoning is kept in `blocks`, not inlined: it is often longer than
          // the answer and reads as noise in a conversation view.
          if (b?.type === "thinking") return "";
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    },

    /**
     * Records one turn. Re-recording the same turn is a no-op rather than an
     * error: the subscription can redeliver, and a duplicate must not break
     * the sink that is also applying the run's completion.
     */
    async append(executionId, { seq, role, content, at }) {
      const text = messages.flatten(content);
      const clip = (s) => (Buffer.byteLength(s, "utf8") > MAX_MESSAGE_BYTES ? `${s.slice(0, MAX_MESSAGE_BYTES)}…` : s);
      const blocks = Array.isArray(content) ? clip(JSON.stringify(content)) : null;
      await store.run(
        `INSERT OR IGNORE INTO execution_messages (execution_id, seq, role, content, blocks, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [executionId, Number(seq ?? 0), String(role ?? "assistant"), clip(text), blocks, Number(at ?? now())],
      );
    },

    async listByExecution(executionId) {
      return store.all(
        `SELECT seq, role, content, blocks, at FROM execution_messages
          WHERE execution_id = ? ORDER BY seq`,
        [executionId],
      );
    },

    /** Finds the execution a session belongs to, by either naming scheme. */
    async executionForSession(ref) {
      if (!ref) return null;
      const row = await store.get(
        `SELECT id FROM executions WHERE session_ref = ? ORDER BY revision_no DESC LIMIT 1`,
        [ref],
      );
      return row?.id ?? null;
    },

    /**
     * Finds the execution a dispatched session key belongs to (D48).
     *
     * The key, not session_ref, is what `session.message` events carry: a
     * CONTINUE revision sends a composite key derived from its inherited ref
     * (`…:s<ref>`), so matching on session_ref misses every mid-run message.
     * Revisions share one key by design (one continuing conversation), so
     * the live execution wins — the one not yet finalized — and only when
     * none is live does the newest revision take the message.
     */
    async executionForSessionKey(key) {
      if (!key) return null;
      const live = await store.get(
        `SELECT id FROM executions WHERE session_key = ? AND finalized_at IS NULL ORDER BY revision_no DESC LIMIT 1`,
        [key],
      );
      if (live?.id) return live.id;
      const row = await store.get(
        `SELECT id FROM executions WHERE session_key = ? ORDER BY revision_no DESC LIMIT 1`,
        [key],
      );
      return row?.id ?? null;
    },
  };

  return { projects, workers, tasks, executions, resources, leases, approvals, messages };
}
