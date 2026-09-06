// Private HTTP API — POC-4 §7.1.
//
// Deliberately dependency-free: node:http plus a small pattern router. The
// controller is a single-replica internal service behind the edge proxy, so a
// framework would add supply chain surface for no capability we need.
import { createServer } from "node:http";
import { nullLogger } from "../domain/logger.mjs";
import { verifySlackRequest, parseSlackBody } from "../interface/slack-verify.mjs";
import { timingSafeEqual } from "node:crypto";
import { Status, canTransition } from "../domain/state-machine.mjs";
import { DELETABLE_STATUSES } from "../domain/repositories.mjs";
import { TASK_FOR_EXECUTION } from "../runtime/reconciler.mjs";
import { isExpedited, effectivePriority } from "../scheduler/selection.mjs";
import { WakeReason } from "../scheduler/scheduler.mjs";
import { buildAgentInventory, summariseInventory } from "../runtime/agent-inventory.mjs";
import {
  DEFAULT_ROLE_LEVELS,
  PROFILE_TO_LEVEL,
  ROLES_NOT_IN_AGENTOS,
  PROFILES,
  rolesForTemplate,
  Level,
  resolveLevel,
} from "../domain/brains.mjs";
import { DEFAULT_BRAIN_MAP } from "../domain/brain-map.mjs";
import { buildPlan, ROLE_CATEGORY } from "../domain/decompose.mjs";
import { EventKind } from "../domain/events.mjs";
import { classify, Intent, Action } from "../interface/intent.mjs";
import { markRegistered, parseTasksMd, wantsImmediateRun } from "../interface/tasks-md.mjs";
import { isPreambleWrapped } from "../runtime/instruction.mjs";
import { createPrepareTask } from "../domain/prepare.mjs";
import { QUOTA_RETRY_LIMIT, describeWindow, isRetryableWindow } from "../domain/quota-windows.mjs";
import { probeThinkingLevels } from "../domain/thinking-probe.mjs";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

/** Urutan kekuatan level — dipakai untuk menandai pemaku Brain yang basi. */
const LEVEL_RANK = Object.freeze({ [Level.LOW]: 0, [Level.NORMAL]: 1, [Level.CRITICAL]: 2 });

const CONTROL_HELP =
  "Tulis pekerjaan yang ingin dikerjakan dan saya pecah menjadi task, " +
  "awali dengan `/prepare` untuk satu task penyusun docs/plans.md + docs/tasks.md, " +
  "awali dengan `/task` untuk satu task langsung, " +
  "atau beri perintah pada task yang ada (status/stop/run/cancel/model TASK-XXXX, " +
  "run dan cancel menerima beberapa id sekaligus).";

/**
 * Satu langkah rencana, siap ditampilkan.
 *
 * `brainSource` dan `brainNote` ikut dibawa karena keduanya menjelaskan hal
 * yang tidak terlihat dari nama Brain saja: apakah ia dipilih operator atau
 * jatuh dari level, dan kalau pemaku operator diabaikan — kenapa.
 */
const presentPlanStep = (s) => ({
  role: s.role,
  label: s.label,
  level: s.level,
  category: s.category,
  qualityClass: s.qualityClass,
  workspaceMode: s.workspaceMode,
  deliverable: s.deliverable,
  title: s.title,
  brain: s.brain?.name ?? null,
  brainSource: s.brainSource ?? null,
  brainNote: s.brainNote ?? null,
  after: s.after,
});

/**
 * The agent list as AgentOS sees it: straight from `openclaw.json`.
 *
 * Read fresh every call rather than cached. AgentOS writes this file directly
 * and the whole point of the endpoint is to show drift, so a cached copy would
 * hide exactly what it exists to reveal. Missing or unreadable is not an error:
 * the controller does not own this file and may not be given it.
 */
function readAgentConfig(path = process.env.OPENCLAW_CONFIG_PATH ?? null) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = parsed?.agents?.list;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

class HttpError extends Error {
  constructor(status, message, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const badRequest = (msg, detail) => new HttpError(400, msg, detail);
const notFound = (msg) => new HttpError(404, msg);
const forbidden = (msg) => new HttpError(403, msg);

/** A thinking-level probe's in-memory progress entry, shaped for the wire. */
function presentProbeStatus(status) {
  return {
    running: status.running,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    error: status.error,
    reason: status.reason ?? null,
    message: status.message ?? null,
    samples: status.samples,
  };
}

/** An operator, minus the one field that must never leave the database. */
const presentOperator = (o) => ({
  id: o.id,
  name: o.name,
  slackUserId: o.slack_user_id,
  role: o.role,
  active: Boolean(o.active),
  createdAt: o.created_at,
  lastSeenAt: o.last_seen_at,
});

/** Constant-time compare so the token cannot be probed byte by byte. */
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// --- presenters -------------------------------------------------------------
// Responses are built field by field rather than spreading rows, so a column
// added later cannot leak into the API by accident (P4-13).

const presentTask = (t, now) => ({
  id: t.id,
  projectId: t.project_id,
  parentTaskId: t.parent_task_id,
  title: t.title,
  description: t.description,
  priority: t.priority,
  effectivePriority: effectivePriority(t, now),
  expedited: isExpedited(t, now),
  expediteUntil: t.expedite_until,
  qualityClass: t.quality_class,
  status: t.status,
  waitReason: t.wait_reason,
  workerId: t.worker_id,
  sessionPolicy: t.session_policy,
  approvalLevel: t.approval_level,
  workspacePath: t.workspace_path,
  workspaceMode: t.workspace_mode,
  modelPolicy: t.model_policy,
  nextRetryAt: t.next_retry_at,
  deletedAt: t.deleted_at ?? null,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

const presentExecution = (e) => ({
  id: e.id,
  taskId: e.task_id,
  revisionNo: e.revision_no,
  sessionMode: e.session_mode,
  sessionRef: e.session_ref,
  runtimeRef: e.runtime_ref,
  sandboxRef: e.sandbox_ref,
  model: e.model_provider && e.model_id ? `${e.model_provider}/${e.model_id}` : null,
  mode: e.mode,
  tokensInput: e.tokens_input,
  tokensOutput: e.tokens_output,
  tokensCacheRead: e.tokens_cache_read,
  tokensCacheCreation: e.tokens_cache_creation,
  // Cache reads dominate real consumption (POC-3 E8), so the total is reported
  // alongside the split rather than leaving callers to add it up and forget.
  tokensBillable:
    (e.tokens_input ?? 0) + (e.tokens_output ?? 0) + (e.tokens_cache_read ?? 0) + (e.tokens_cache_creation ?? 0),
  cost: e.cost,
  costUnit: e.cost_unit,
  status: e.status,
  result: e.result,
  startedAt: e.started_at,
  endedAt: e.ended_at,
  finalized: e.finalized_at != null,
});

const presentApproval = (a) => ({
  id: a.id,
  taskId: a.task_id,
  executionId: a.execution_id,
  level: a.level,
  question: a.question,
  options: a.options,
  decision: a.decision,
  note: a.note,
  decidedBy: a.decided_by,
  decidedAt: a.decided_at,
  createdAt: a.created_at,
});

const presentResource = (r) => ({
  provider: r.provider,
  model: r.model,
  concurrencyLimit: r.concurrency_limit,
  quotaPolicy: r.quota_policy,
  availability: r.availability,
  creditClass: r.credit_class,
  nextAvailableAt: r.next_available_at,
  windowKind: r.window_kind,
  lastQuotaSignal: r.last_quota_signal,
});

export function createApi(controller, { token, slackSigningSecret = process.env.SLACK_SIGNING_SECRET ?? null } = {}) {
  const { repos, admission, scheduler, now } = controller;
  const log = (controller.log ?? nullLogger).child({ component: "api" });

  const routes = [];
  // In-memory only, keyed by `${provider}/${model}`.toLowerCase(). A probe's
  // progress does not need to survive a controller restart — it needs to
  // survive the request/response boundary, since the probe itself runs far
  // longer than any one HTTP call should block for (see the probe route
  // below). One entry per model pair also doubles as the "already running"
  // guard, so a second click of Refresh Levels while one is in flight can't
  // start a duplicate sweep of the same model.
  const thinkingProbes = new Map();
  const route = (method, pattern, handler, { auth = true, slack = false } = {}) => {
    const names = [];
    const regex = new RegExp(
      `^${pattern.replace(/\{(\w+)\}/g, (_, name) => {
        names.push(name);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, regex, names, handler, auth: slack ? false : auth, slack });
  };

  // --- health (unauthenticated by design: the Swarm healthcheck runs before
  // any secret is available to it, and the payload carries no state) ---------
  route("GET", "/api/work/health", async () => ({ status: "ok" }), { auth: false });

  // --- projects / workers ---------------------------------------------------
  route("GET", "/api/work/projects", async () => ({
    projects: (await repos.projects.list()).map((p) => ({
      id: p.id,
      name: p.name,
      weight: p.weight,
      status: p.status,
      workspacePath: p.workspace_path,
      template: p.template,
      profile: p.profile,
    })),
  }));

  route("POST", "/api/work/projects", async (_p, body) => {
    if (!body.name || !body.workspacePath) throw badRequest("name and workspacePath are required");
    const project = await repos.projects.create(body);
    log.info("project.created", {
      project: project.id, name: body.name, weight: body.weight ?? 1,
      workspace: body.workspacePath, template: project.template, profile: project.profile,
    });
    return {
      project: {
        id: project.id, name: project.name, weight: project.weight,
        template: project.template, profile: project.profile,
      },
    };
  });

  // Project-level settings (D37): template and profile move here from a
  // per-request Control page parameter, so every operator's WORK request
  // uses the same baseline without re-typing it. Any team member may change
  // this — the shared-token attribution (§8.4) already means every action
  // from this UI is one identity, so there is no per-role gate to add.
  route("PATCH", "/api/work/projects/{id}", async ({ id }, body, _q, actor) => {
    if (body.template === undefined && body.profile === undefined) {
      throw badRequest("nothing to update: provide template and/or profile");
    }
    const by = actor?.kind === "operator" ? actor.name : "agentos-ui";
    try {
      const project = await repos.projects.update(id, {
        template: body.template,
        profile: body.profile,
        actor: by,
      });
      return {
        project: {
          id: project.id, name: project.name, weight: project.weight,
          status: project.status, workspacePath: project.workspace_path,
          template: project.template, profile: project.profile,
        },
      };
    } catch (err) {
      if (String(err.message).startsWith("unknown project")) throw notFound(err.message);
      throw badRequest(err.message);
    }
  });

  route("DELETE", "/api/work/projects/{id}", async ({ id }, _b, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may delete projects");
    const by = actor?.kind === "operator" ? actor.name : "agentos-ui";
    try {
      const result = await repos.projects.delete(id, { actor: by });
      return result;
    } catch (err) {
      if (String(err.message).startsWith("unknown project")) throw notFound(err.message);
      throw badRequest(err.message);
    }
  });

  // --- workspace documents (Command Center readiness checklist) --------------
  //
  // First job of a new project is getting it READY to run tasks, and
  // readiness is legible as documents: brief/architecture in docs/,
  // blueprint/decisions in memory/ (the two-tier bootstrap's pointer targets,
  // spec §9), and the operator's plans/tasks pair. The controller is the one
  // component that holds the workspace path, so the checklist is reported
  // here rather than guessed in the UI.
  //
  // Names are whitelisted and directories are constants — workspace_path is
  // validated at creation (assertWorkspacePath), so no request input ever
  // reaches a path segment and nothing outside the two doc directories can
  // be read.
  const DOC_DIRS = Object.freeze({
    brief: "docs",
    architecture: "docs",
    "migration-plan": "docs",
    blueprint: "memory",
    decisions: "memory",
    plans: "docs",
    tasks: "docs",
  });
  // research/content never build software architecture — their pipelines
  // (researcher → writer → reviewer → analyst) have no architect phase, so
  // demanding architecture.md would make every research project permanently
  // "not ready" for a document nothing reads.
  const TEMPLATE_DOCS = Object.freeze({
    software: ["brief", "architecture", "blueprint", "decisions", "plans", "tasks"],
    frontend: ["brief", "architecture", "blueprint", "decisions", "plans", "tasks"],
    backend: ["brief", "architecture", "blueprint", "decisions", "plans", "tasks"],
    research: ["brief", "blueprint", "decisions", "plans", "tasks"],
    content: ["brief", "blueprint", "decisions", "plans", "tasks"],
  });

  route("GET", "/api/work/projects/{id}/docs", async ({ id }) => {
    const project = await repos.projects.get(id);
    if (!project) throw notFound(`unknown project ${id}`);
    const template = String(project.template ?? "software").toLowerCase();
    const names = TEMPLATE_DOCS[template] ?? TEMPLATE_DOCS.software;
    const root = project.workspace_path;
    const docs = [];
    for (const name of names) {
      const dir = DOC_DIRS[name];
      const filePath = root ? `${root}/${dir}/${name}.md` : null;
      let exists = false;
      let size = 0;
      let updatedAt = null;
      if (filePath) {
        try {
          const info = await stat(filePath);
          exists = true;
          size = info.size;
          updatedAt = info.mtimeMs;
        } catch {
          // absent is the normal state for a fresh project — reported, not thrown
        }
      }
      docs.push({ name, dir, exists, size, updatedAt });
    }
    return { projectId: id, template, workspacePath: root, docs };
  });

  route("GET", "/api/work/projects/{id}/docs/{name}", async ({ id, name }) => {
    const project = await repos.projects.get(id);
    if (!project) throw notFound(`unknown project ${id}`);
    const dir = DOC_DIRS[String(name ?? "").toLowerCase()];
    if (!dir) throw badRequest(`unknown document "${name}"`);
    const root = project.workspace_path;
    if (!root) return { name, dir, exists: false, content: null };
    try {
      const content = await readFile(`${root}/${dir}/${name}.md`, "utf8");
      return { name, dir, exists: true, content };
    } catch {
      return { name, dir, exists: false, content: null };
    }
  });

  // Menyimpan suntingan dokumen dari modal Command Center (tombol Edit/Save).
  // D58 (membatalkan pembatasan D55): SEMUA dokumen whitelist — docs/ maupun
  // memory/ (blueprint, decisions) — bisa disunting operator dari sini.
  // memory/ memang wilayah bootstrap dua-tingkat agen (spec §9), tetapi agen
  // hanya MEMBACANYA; keputusan operator tentang isi dokumen itu lebih
  // berwenang daripada keengganan controller menulisnya. Yang tetap dijaga:
  // whitelist nama sama persis dengan GET (tidak ada segmen path dari
  // request yang sampai ke filesystem), controller hanya menulis atas PUT
  // eksplisit operator — tak pernah atas inisiatif sendiri — dan setiap
  // penyimpanan tercatat di event_log.
  route("PUT", "/api/work/projects/{id}/docs/{name}", async ({ id, name }, body, _q, actor) => {
    const project = await repos.projects.get(id);
    if (!project) throw notFound(`unknown project ${id}`);
    const doc = String(name ?? "").toLowerCase();
    const dir = DOC_DIRS[doc];
    if (!dir) throw badRequest(`unknown document "${name}"`);
    if (typeof body?.content !== "string") throw badRequest("content is required");
    const root = project.workspace_path;
    if (!root) throw badRequest("Project belum punya workspace — dokumen tidak bisa disimpan.");
    const by = actor?.kind === "operator" ? actor.name : String(body.user ?? "agentos-ui");
    await mkdir(`${root}/${dir}`, { recursive: true });
    await writeFile(`${root}/${dir}/${doc}.md`, body.content, "utf8");
    // Perubahan dokumen direncanakan adalah keputusan operator — dicatat ke
    // event log agar "siapa yang mengubah tasks.md" bisa dijawab dari jejak
    // audit, bukan dari memori orang.
    await controller.events.append({
      kind: "project.doc-updated",
      subjectType: "project",
      subjectId: id,
      actor: by,
      payload: { document: `${dir}/${doc}.md`, size: body.content.length },
    });
    log.info("project.doc-updated", { project: id, doc: `${dir}/${doc}.md`, size: body.content.length, by });
    return { name: doc, dir, exists: true, size: body.content.length };
  });

  // Project-level Role Level overrides (Settings → Project → Edit modal).
  //
  // Distinct from PATCH above (deliberately narrow to template/profile) and
  // from PUT /api/work/role-levels (global, admin-wide): this is the
  // per-project snapshot that, once saved, wins over both. See
  // project_role_levels in schema.sql and resolveLevel()'s resolution order.
  //
  // Role list = roles actually REGISTERED for this project: template roles ∪
  // roles of workers with access ∪ roles already saved — a real project may
  // register roles beyond its template's vocabulary.
  route("GET", "/api/work/projects/{id}/role-levels", async ({ id }, _b, query) => {
    const project = await repos.projects.get(id);
    if (!project) throw notFound(`unknown project ${id}`);
    const profile = String(query.get("profile") ?? project.profile ?? "balanced").toLowerCase();
    const template = String(project.template ?? "software").toLowerCase();

    const globalRows = await controller.store.all(
      `SELECT role, level FROM role_levels WHERE template = ? AND profile = ?`,
      [template, profile],
    );
    const globalOverrides = Object.fromEntries(globalRows.map((r) => [r.role, r.level]));

    const projectRows = await repos.projects.roleLevels.list(id);
    const projectOverrides = Object.fromEntries(projectRows.map((r) => [r.role, r.level]));

    const workerRoles = (await repos.workers.list())
      .filter((w) => w.project_access.length === 0 || w.project_access.includes(id))
      .map((w) => String(w.role ?? "").toLowerCase())
      .filter(Boolean);

    const roles = [...new Set([...rolesForTemplate(template), ...workerRoles, ...Object.keys(projectOverrides)])].sort();

    const rolesOut = [];
    for (const role of roles) {
      // What this project would use right now, resolved the same way dispatch
      // resolves it — project override > global override > builtin
      // (template, profile) default > the project's own profile level.
      const level = resolveLevel({ template, role, profile, overrides: globalOverrides, projectOverrides });
      const pick = await controller.brainMap.resolve({
        template,
        role,
        level,
        brains: controller.brains,
      });
      rolesOut.push({
        role,
        level,
        roleMapDefault: resolveLevel({ template, role, profile, overrides: globalOverrides }),
        projectOverride: projectOverrides[role] ?? null,
        brain: pick.brain ? { id: pick.brain.id, name: pick.brain.name } : null,
        brainSource: pick.source,
        brainNote: pick.reason,
      });
    }
    return {
      projectId: id,
      template,
      profile,
      profiles: PROFILES,
      hasOwnMapping: projectRows.length > 0,
      roles: rolesOut,
    };
  });

  route("PUT", "/api/work/projects/{id}/role-levels", async ({ id }, body, _q, actor) => {
    const project = await repos.projects.get(id);
    if (!project) throw notFound(`unknown project ${id}`);
    const roleLevels = Array.isArray(body.roleLevels) ? body.roleLevels : null;
    if (!roleLevels) throw badRequest("roleLevels (array of {role, level}) is required");
    const by = actor?.kind === "operator" ? actor.name : "agentos-ui";

    if (body.profile !== undefined && body.profile !== project.profile) {
      await repos.projects.update(id, { profile: body.profile, actor: by });
    }

    try {
      const saved = await repos.projects.roleLevels.replace(id, roleLevels, { actor: by });
      return { projectId: id, roleLevels: saved.map((r) => ({ role: r.role, level: r.level })) };
    } catch (err) {
      if (String(err.message).startsWith("unknown project")) throw notFound(err.message);
      throw badRequest(err.message);
    }
  });

  route("GET", "/api/work/workers", async () => ({
    workers: (await repos.workers.list()).map((w) => ({
      id: w.id,
      role: w.role,
      agentRef: w.agent_ref,
      skills: w.skills,
      projectAccess: w.project_access,
      maxConcurrent: w.max_concurrent,
      status: w.status,
    })),
  }));

  route("POST", "/api/work/workers", async (_p, body) => {
    if (!body.role || !body.agentRef) throw badRequest("role and agentRef are required");
    const worker = await repos.workers.create(body);
    return { worker: { id: worker.id, role: worker.role, agentRef: worker.agent_ref } };
  });

  // --- tasks ----------------------------------------------------------------
  route("POST", "/api/work/tasks", async (_p, body) => {
    if (!body.projectId || !body.title) throw badRequest("projectId and title are required");
    if (!(await repos.projects.get(body.projectId))) throw badRequest(`unknown project ${body.projectId}`);
    const task = await repos.tasks.create(body);
    log.info("task.created", {
      task: task.id, project: body.projectId, title: body.title,
      priority: body.priority ?? 2, qualityClass: body.qualityClass ?? "L2",
      sessionPolicy: body.sessionPolicy ?? "FRESH",
      workspaceMode: body.workspaceMode ?? "write",
      workspacePath: body.workspacePath ?? null,
      modelPolicy: body.modelPolicy ?? {},
      worker: body.workerId ?? null,
    });
    // `hold: true` stocks the work without starting it, so the model and effort
    // can be decided later. Without this a task is queued the moment it is
    // created and the scheduler often dispatches it before an operator can
    // change anything — which is exactly what happened the first time this
    // workflow was tried on the cluster.
    if (body.hold === true) {
      log.info("task.held", { task: task.id, project: body.projectId });
      return { task: presentTask(await repos.tasks.get(task.id), now()) };
    }
    await repos.tasks.setStatus(task.id, Status.QUEUED);
    await scheduler.notify(WakeReason.TASK_CREATED);
    return { task: presentTask(await repos.tasks.get(task.id), now()) };
  });

  route("GET", "/api/work/tasks", async (_p, _b, query) => ({
    tasks: (await repos.tasks.list({ status: query.get("status"), projectId: query.get("project") })).map(
      (t) => presentTask(t, now()),
    ),
  }));

  route("GET", "/api/work/tasks/{id}", async ({ id }) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    return {
      task: presentTask(task, now()),
      executions: (await repos.executions.listByTask(id)).map(presentExecution),
      approvals: (await repos.approvals.listForTask(id)).map(presentApproval),
      dependencies: await repos.tasks.dependencies(id),
    };
  });

  route("POST", "/api/work/tasks/{id}/revisions", async ({ id }, body) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    const mode = body.session_mode ?? body.sessionMode;
    if (!mode) throw badRequest("session_mode is required (CONTINUE|FORK|FRESH)");
    let updated;
    try {
      updated = await repos.tasks.createRevision(id, {
        sessionMode: mode,
        instruction: body.instruction ?? "",
        modelPolicy: body.modelPolicy,
        actor: body.actor ?? "operator",
      });
    } catch (err) {
      throw badRequest(err.message);
    }
    await scheduler.notify(WakeReason.MANUAL);
    return { task: presentTask(await repos.tasks.get(updated.id), now()) };
  });

  // Change the plan of a task that is queued, waiting, or finished — then run
  // it again with the revisions endpoint. This is what makes "stock the work,
  // decide the model later" possible.
  route("PATCH", "/api/work/tasks/{id}", async ({ id }, body) => {
    try {
      const task = await repos.tasks.updatePlan(id, {
        modelPolicy: body.modelPolicy,
        priority: body.priority,
        qualityClass: body.qualityClass,
        workspaceMode: body.workspaceMode,
        // Both accept null: clearing the workspace falls back to the project's,
        // clearing the worker unassigns. Sending `null` deliberately has to be
        // distinguishable from omitting the field, so `undefined` means "leave
        // it alone" all the way down.
        workspacePath: body.workspacePath,
        workerId: body.workerId,
        actor: body.actor ?? "operator",
      });
      // Wake the scheduler: the operator is standing here waiting to see
      // whether their fix worked, and the next tick may be a minute away.
      await scheduler.notify(WakeReason.MANUAL);
      return { task: presentTask(task, now()) };
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  /**
   * Stop a task that is running or queued, so its plan can be changed.
   *
   * NOT cancel. `CANCELLED` is deliberately a dead end in the state machine —
   * nothing comes back from it — which is right for "abandon this", and wrong
   * for "pause, change the model, run it again". That second thing is what an
   * operator actually asks for most often, and it had no path at all: `PATCH`
   * refuses a running task, and a revision cannot follow a cancel.
   *
   * So this aborts the live run at the gateway and parks the task on BLOCKED,
   * which the state machine already routes back through RESUMABLE → QUEUED.
   */
  route("POST", "/api/work/tasks/{id}/stop", async ({ id }, body) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    if ([Status.COMPLETE, Status.CANCELLED].includes(task.status)) {
      throw badRequest(`task ${id} is already ${task.status}`);
    }

    const execution = await repos.executions.latest(id);
    const live = execution && ["PENDING", "DISPATCHED", "RUNNING"].includes(execution.status);
    let aborted = { ok: true, aborted: false, status: "nothing-running" };

    if (live) {
      // ORDER MATTERS, and getting it wrong cost a run to discover.
      //
      // Aborting first meant the gateway's own lifecycle `end` — carrying
      // `aborted: true` — raced back before we could park the task. The session
      // sink correctly reads an abort as a cancellation and moved the task to
      // CANCELLED, which is a dead end, and the stop handler then failed trying
      // to park an already-dead task.
      //
      // So the execution is finalised FIRST. The sink skips any execution that
      // is already final, so the abort event it triggers lands harmlessly and
      // the operator's intent — pause, not abandon — is the one that survives.
      await repos.executions.setStatus(execution.id, "CANCELLED", {
        result: `stopped by ${body.actor ?? "operator"}`,
      });

      // Then ask the gateway to stop the turn. "Stopped it" and "there was
      // nothing to stop" are recorded separately rather than flattened: a task
      // marked stopped while its run continues would be a lie an operator acts
      // on.
      if (execution.session_ref && controller.runtime?.abortRun) {
        aborted = await controller.runtime.abortRun({ sessionKey: execution.session_ref });
      }
      if (task.workspace_path) {
        await repos.leases.release(task.workspace_path, {
          executionId: execution.id,
          actor: body.actor ?? "operator",
        });
      }
    }

    await repos.tasks.setStatus(id, Status.BLOCKED, {
      reason: body.reason ?? "stopped by operator",
      actor: body.actor ?? "operator",
    });
    log.info("task.stopped", {
      task: id, exec: execution?.id ?? null, wasLive: Boolean(live),
      abortedAtGateway: aborted.aborted, gatewayStatus: aborted.status ?? null,
      by: body.actor ?? "operator",
    });

    return {
      task: presentTask(await repos.tasks.get(id), now()),
      stopped: { wasLive: Boolean(live), abortedAtGateway: aborted.aborted, gatewayStatus: aborted.status ?? null },
    };
  });

  // --- operators -----------------------------------------------------------
  //
  // Only an admin may mint or revoke an identity. Letting an ordinary operator
  // create operators would make the audit trail circular: anyone could invent a
  // name to act under.
  route("POST", "/api/work/operators", async (_p, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may create operators");
    if (!body.name) throw badRequest("name is required");
    try {
      const { operator, token } = await controller.operators.create({
        name: body.name,
        slackUserId: body.slackUserId ?? null,
        role: body.role ?? "operator",
      });
      log.info("operator.created", { operator: operator.id, name: operator.name, role: operator.role, by: actor.name });
      // Shown exactly once. There is no endpoint that reads it back, because
      // the database only ever holds the hash.
      return { operator: presentOperator(operator), token };
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  route("GET", "/api/work/operators", async (_p, _b, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may list operators");
    return { operators: (await controller.operators.list()).map(presentOperator) };
  });

  route("POST", "/api/work/operators/{id}/rotate", async ({ id }, _b, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may rotate a token");
    try {
      const { operator, token } = await controller.operators.rotate(id);
      log.info("operator.rotated", { operator: id, by: actor.name });
      return { operator: presentOperator(operator), token };
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  route("POST", "/api/work/operators/{id}/deactivate", async ({ id }, _b, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may deactivate an operator");
    const operator = await controller.operators.deactivate(id, { actor: actor.name });
    log.info("operator.deactivated", { operator: id, by: actor.name });
    return { operator: presentOperator(operator) };
  });

  // Who am I? Useful for a surface to show the acting identity honestly.
  route("GET", "/api/work/whoami", async (_p, _b, _q, actor) => ({ actor }));

  // Release a held task into the queue.
  route("POST", "/api/work/tasks/{id}/start", async ({ id }, body) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    if (task.status !== Status.CREATED) {
      throw badRequest(`task ${id} is ${task.status}, not held`);
    }
    await repos.tasks.setStatus(id, Status.QUEUED, { actor: body.actor ?? "operator" });
    await scheduler.notify(WakeReason.TASK_CREATED);
    return { task: presentTask(await repos.tasks.get(id), now()) };
  });

  // What would this policy actually pick, and would it run? Answering before
  // dispatch beats discovering it from a parked task.
  route("POST", "/api/work/routing/preview", async (_p, body) => {
    const resolved = controller.policy.resolve({
      model_policy: body.modelPolicy ?? {},
      quality_class: body.qualityClass ?? "L2",
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason, candidates: [] };
    const candidates = [];
    for (const c of resolved.candidates) {
      const resource = await repos.resources.get(c.provider, c.model);
      candidates.push({
        logical: c.logical,
        provider: c.provider,
        model: c.model,
        effort: c.thinking ?? null,
        // Whether that effort is a guarantee or a wish. An operator choosing a
        // "critical" route deserves to know which, because a preference-mode
        // level is not sent to the provider at all.
        effortMode: c.effortMode ?? "guaranteed",
        effortEvidence: c.effortEvidence ?? null,
        mode: c.mode ?? "interactive",
        acpAgent: c.acpAgent ?? null,
        availability: resource?.availability ?? "UNKNOWN",
        nextAvailableAt: resource?.next_available_at ?? null,
      });
    }
    return { ok: true, unmapped: resolved.unmapped ?? [], candidates };
  });

  route("POST", "/api/work/tasks/{id}/expedite", async ({ id }, body) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    const ttl = Number(body.ttl ?? body.ttlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) throw badRequest("ttl (ms) must be a positive number");
    await repos.tasks.expedite(id, { ttlMs: ttl, actor: body.actor ?? "operator" });
    await scheduler.notify(WakeReason.MANUAL);
    return { task: presentTask(await repos.tasks.get(id), now()) };
  });

  route("POST", "/api/work/tasks/{id}/cancel", async ({ id }, body) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    try {
      await repos.tasks.cancel(id, { actor: body.actor ?? "operator", note: body.note ?? null });
    } catch (err) {
      throw badRequest(err.message);
    }
    return { task: presentTask(await repos.tasks.get(id), now()) };
  });

  // --- deletion --------------------------------------------------------------
  //
  // Deletion is for work that is provably idle — CREATED (never queued) and
  // CANCELLED (a dead end) — so cleaning the board cannot stop anything that
  // is running. Admin-only, like project deletion: this removes rows, and the
  // attribution of a removal must be an identity someone vouches for.
  route("DELETE", "/api/work/tasks/{id}", async ({ id }, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may delete tasks");
    try {
      const result = await repos.tasks.delete(id, {
        actor: actor.kind === "operator" ? actor.name : "service",
        note: body?.note ?? null,
      });
      return result;
    } catch (err) {
      if (String(err.message).startsWith("unknown task")) throw notFound(err.message);
      throw badRequest(err.message);
    }
  });

  // Bulk delete by status, because the thing an operator actually asks for is
  // "clear out everything that was never started and everything abandoned",
  // not 115 individual DELETE calls. The caller must name the statuses: a
  // destructive bulk action with implicit defaults is the kind of thing that
  // gets run by accident; naming them makes the request itself the record of
  // intent. Each task is still checked and refused individually, and the
  // response names every task touched (spec §8.7).
  route("POST", "/api/work/tasks/purge", async (_p, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may purge tasks");
    const statuses = body?.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      throw badRequest(`statuses must be a non-empty array (one or more of ${DELETABLE_STATUSES.join(", ")})`);
    }
    for (const s of statuses) {
      if (!DELETABLE_STATUSES.includes(s)) {
        throw badRequest(`status "${s}" cannot be deleted (allowed: ${DELETABLE_STATUSES.join(", ")})`);
      }
    }
    const by = actor.kind === "operator" ? actor.name : "service";
    const deleted = [];
    const refused = [];
    for (const s of [...new Set(statuses)]) {
      for (const task of await repos.tasks.list({ status: s, limit: 10_000 })) {
        try {
          deleted.push(await repos.tasks.delete(task.id, { actor: by, note: body?.note ?? null }));
        } catch (err) {
          refused.push({ taskId: task.id, status: task.status, reason: err.message });
        }
      }
    }
    log.info("tasks.purged", {
      statuses: [...new Set(statuses)], deleted: deleted.length, refused: refused.length, by,
    });
    return { deleted, refused };
  });

  // Repairs a task whose status disagrees with its own final execution —
  // the divergence left behind when a run's end could not be applied to the
  // task (TASK-7A3CC32A: execution COMPLETE under a task the watchdog had
  // parked BLOCKED, D57). Rule 6 forbids fixing rows by hand, so the repair
  // is an endpoint: same mapping the reconciler uses, same state-machine
  // gate as everyone else, and a refusal that names the transition rather
  // than a silent nothing.
  route("POST", "/api/work/tasks/{id}/settle", async ({ id }, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may settle tasks");
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    const execution = await repos.executions.latest(id);
    if (!execution || execution.finalized_at == null) {
      throw badRequest(`task ${id} has no finalized execution to settle from`);
    }
    const target = TASK_FOR_EXECUTION[execution.status];
    if (!target) throw badRequest(`execution ${execution.id} is ${execution.status}, which maps to no task status`);
    if (task.status === target) {
      return { settled: false, reason: `task already ${target}`, task: presentTask(task, now()) };
    }
    if (!canTransition(task.status, target)) {
      throw badRequest(`cannot settle task ${id}: illegal transition ${task.status} -> ${target}`);
    }
    const by = actor.kind === "operator" ? actor.name : "service";
    await repos.tasks.setStatus(id, target, {
      reason: `settled by ${by} from execution ${execution.id} (${execution.status})`,
      actor: by,
    });
    // The divergent path also skipped the sink's lease release; if anything is
    // still held under this execution, let it go now.
    if (task.workspace_path) {
      const lease = await repos.leases.get(task.workspace_path);
      if (lease?.execution_id === execution.id) {
        await repos.leases.release(task.workspace_path, { executionId: execution.id, actor: "settle" });
      }
    }
    await scheduler.notify(WakeReason.MANUAL);
    log.info("task.settled", { task: id, from: task.status, to: target, exec: execution.id, by });
    return {
      settled: true, from: task.status, to: target, execution: execution.id,
      task: presentTask(await repos.tasks.get(id), now()),
    };
  });

  // --- approvals ------------------------------------------------------------
  //
  // Called by the ACP permission interposer running on the Gateway host
  // (POC-3). It has a tool call held mid-turn and is blocking on the answer, so
  // this endpoint must be cheap and must never 500 into an implicit allow — the
  // interposer treats any failure as a rejection.
  route("POST", "/api/work/approvals", async (_p, body) => {
    const { sessionId, tool, level, workspace } = body;
    if (!tool || !level) throw badRequest("tool and level are required");

    // The interposer knows the harness session, not the task. Resolve through
    // the execution that owns that session; fall back to the workspace lease.
    let taskId = body.taskId ?? null;
    let executionId = null;
    if (!taskId && sessionId) {
      const exec = await controller.store.get(
        `SELECT id, task_id FROM executions WHERE session_ref = ? ORDER BY revision_no DESC LIMIT 1`,
        [sessionId],
      );
      taskId = exec?.task_id ?? null;
      executionId = exec?.id ?? null;
    }
    if (!taskId && workspace) {
      const t = await controller.store.get(
        `SELECT id FROM tasks WHERE workspace_path = ? ORDER BY updated_at DESC LIMIT 1`,
        [workspace],
      );
      taskId = t?.id ?? null;
    }
    if (!taskId) throw badRequest(`cannot map session ${sessionId ?? "?"} to a task`);

    const approval = await repos.approvals.create({
      taskId,
      executionId,
      level,
      question: `Allow "${tool}" for ${taskId}?`,
      options: ["APPROVE", "REJECT", "MODIFY", "COMMENT"],
    });
    // Park the task so the queue shows why nothing is moving.
    const task = await repos.tasks.get(taskId);
    if (task && ![Status.COMPLETE, Status.CANCELLED].includes(task.status)) {
      await repos.tasks.setStatus(taskId, Status.WAIT_HUMAN, {
        waitDetail: `approval ${approval.id} pending (${level}): ${tool}`,
      });
    }
    return { approvalId: approval.id, taskId, level };
  });

  route("GET", "/api/work/approvals/{id}", async ({ id }) => {
    const approval = await repos.approvals.get(id);
    if (!approval) throw notFound(`unknown approval ${id}`);
    return { approval: presentApproval(approval) };
  });

  route("POST", "/api/work/approvals/{id}/decide", async ({ id }, body, _q, actor) => {
    // Attribution comes from the credential, not from the body. A caller that
    // could name anyone as the decider would make `decided_by` decorative, and
    // the whole point of P4-08 is that a decision belongs to a person.
    const decidedBy =
      actor?.kind === "operator" ? actor.name : (body.decided_by ?? body.decidedBy ?? null);
    log.info("approval.decide", { approval: id, decision: body.decision, by: decidedBy, via: actor?.kind ?? "unknown" });
    if (!body.decision) throw badRequest("decision is required");
    if (!decidedBy) {
      throw badRequest(
        "decided_by is required: either call with an operator token, or name the operator explicitly",
      );
    }
    let approval;
    try {
      approval = await repos.approvals.decide(id, {
        decision: body.decision,
        note: body.note ?? null,
        decidedBy,
      });
    } catch (err) {
      throw badRequest(err.message);
    }
    // An approval raised mid-turn by the interposer belongs to an execution
    // that is still alive. Approving it resumes that run; re-admitting the task
    // would be wrong, because there is nothing new to dispatch.
    const live = await repos.executions.latest(approval.task_id);
    const midTurn = live && ["PENDING", "DISPATCHED", "RUNNING"].includes(live.status);
    const task = await repos.tasks.get(approval.task_id);
    if (midTurn && task?.status === Status.WAIT_HUMAN) {
      await repos.tasks.setStatus(approval.task_id, approval.decision === "APPROVE" ? Status.RUNNING : Status.BLOCKED, {
        waitDetail: null,
        actor: body.decided_by ?? body.decidedBy,
      });
    }

    await scheduler.notify(WakeReason.APPROVAL_DECIDED);
    return { approval: presentApproval(approval) };
  });

  route("POST", "/api/work/approvals/{id}/comment", async ({ id }, body) => {
    if (!body.note) throw badRequest("note is required");
    const approval = await repos.approvals.comment(id, {
      note: body.note,
      by: body.by ?? body.decided_by ?? "operator",
    });
    if (!approval) throw notFound(`unknown approval ${id}`);
    return { approval: presentApproval(approval) };
  });

  // --- operator chat surface ------------------------------------------------
  //
  // Transport-agnostic on purpose: a Slack app, a CLI, or curl all post the
  // same {text, user} here. Keeping the transport outside the controller means
  // the intent router and the command surface are testable without Slack, and
  // swapping Slack for something else touches nothing in here.
  route("POST", "/api/work/slack", async (_p, body) => {
    if (!controller.slack) throw badRequest("the chat surface is not enabled on this instance");
    if (typeof body.text !== "string") throw badRequest("text is required");
    const reply = await controller.slack.handle({
      text: body.text,
      user: body.user ?? body.user_name ?? "operator",
    });
    return { reply: reply.text, blocks: reply.blocks ?? [] };
  });

  // --- Slack ----------------------------------------------------------------
  //
  // Two endpoints, both authenticated by Slack's signature over the raw bytes
  // rather than by a bearer token (see the `slack: true` branch in `handle`).
  // Neither takes an actor from the caller: the acting operator is derived from
  // the Slack user id, which Slack itself vouches for by signing the request.
  // That is the whole reason verification is not optional here — Slack may
  // create, stop and re-model tasks, so a forged request would be a forged
  // operator.
  route(
    "POST",
    "/api/work/slack/command",
    async (_p, body) => {
      if (!controller.slackApp) throw badRequest("the Slack app is not enabled on this instance");
      return controller.slackApp.handleCommand({
        text: body.text ?? "",
        user_id: body.user_id ?? null,
        user_name: body.user_name ?? null,
      });
    },
    { slack: true },
  );

  // Block Kit buttons. Slack posts the payload as a JSON string inside a form
  // field; `parseSlackBody` has already unwrapped it.
  route(
    "POST",
    "/api/work/slack/interactive",
    async (_p, body) => {
      if (!controller.slackApp) throw badRequest("the Slack app is not enabled on this instance");
      const payload = body.payload ?? body;
      // Slack sends url_verification when the endpoint is first configured.
      if (payload?.type === "url_verification") return { challenge: payload.challenge };
      return controller.slackApp.handleInteraction(payload);
    },
    { slack: true },
  );

  // --- operator UI ----------------------------------------------------------

  /**
   * Everything a project card needs, in one call.
   *
   * The card exists to answer "why should I open this?", and the honest answer
   * is almost always "because something is waiting for you". So the counts are
   * grouped by lifecycle phase rather than by raw status — seventeen statuses
   * make a table nobody reads — and `needsAttention` is separated out, because
   * WAIT_HUMAN, BLOCKED and FAILED are the ones a person can actually resolve.
   * The other seven WAIT_* states resolve themselves.
   */
  route("GET", "/api/work/projects/summary", async () => {
    const ts = now();
    const projects = await repos.projects.list();
    const out = [];
    for (const p of projects) {
      const tasks = await repos.tasks.list({ projectId: p.id, limit: 10_000 });
      const phase = { stocked: 0, queued: 0, waiting: 0, needsAttention: 0, running: 0, done: 0 };
      let lastActivity = 0;
      for (const t of tasks) {
        lastActivity = Math.max(lastActivity, t.updated_at ?? 0);
        if (t.status === Status.CREATED) phase.stocked += 1;
        else if ([Status.QUEUED, Status.RESUMABLE].includes(t.status)) phase.queued += 1;
        else if ([Status.WAIT_HUMAN, Status.BLOCKED, Status.FAILED].includes(t.status)) phase.needsAttention += 1;
        else if (String(t.status).startsWith("WAIT_")) phase.waiting += 1;
        else if ([Status.DISPATCHED, Status.RUNNING].includes(t.status)) phase.running += 1;
        else phase.done += 1;
      }
      const spend = await controller.store.get(
        `SELECT COALESCE(SUM(tokens_input + tokens_output + tokens_cache_read + tokens_cache_creation), 0) AS tokens,
                COUNT(*) AS runs
           FROM executions e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ?`,
        [p.id],
      );
      out.push({
        id: p.id,
        name: p.name,
        status: p.status,
        weight: p.weight,
        workspacePath: p.workspace_path,
        taskCount: tasks.length,
        phase,
        tokens: spend?.tokens ?? 0,
        runs: spend?.runs ?? 0,
        lastActivityAt: lastActivity || null,
        // Surfaced separately so a card can be sorted by urgency without the
        // caller re-deriving what urgency means.
        needsAttention: phase.needsAttention,
      });
    }
    out.sort((a, b) => b.needsAttention - a.needsAttention || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    return { projects: out, generatedAt: ts };
  });

  /**
   * The append-only log, readable.
   *
   * It has been the audit trail since the first commit and nothing could read
   * it, which meant "what happened to this task" was only answerable by reading
   * Docker logs. Newest first, because that is the question people actually ask.
   */
  route("GET", "/api/work/events", async (_p, _b, query) => {
    const subject = query.get("subject");
    const kind = query.get("kind");
    const limit = Math.min(Number(query.get("limit") ?? 100), 1000);
    const where = [];
    const params = [];
    if (subject) { where.push("subject_id = ?"); params.push(subject); }
    if (kind) { where.push("kind = ?"); params.push(kind); }
    params.push(limit);
    const rows = await controller.store.all(
      `SELECT seq, at, kind, subject_type, subject_id, actor, payload FROM event_log
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY seq DESC LIMIT ?`,
      params,
    );
    return {
      events: rows.map((r) => ({
        seq: r.seq,
        at: r.at,
        kind: r.kind,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        actor: r.actor,
        payload: (() => { try { return JSON.parse(r.payload); } catch { return { raw: r.payload }; } })(),
      })),
    };
  });

  /**
   * What an operator may actually ask for.
   *
   * Free text is the wrong input for a model choice: a name with nothing behind
   * it parks the task in WAIT_RESOURCE, and `glm-5.2` alone is ambiguous
   * whenever the catalog offers it at several efforts. A UI that offers this
   * list cannot produce either mistake.
   */
  route("GET", "/api/work/models", async () => {
    const entries = controller.policy.catalogEntries();
    const out = [];
    for (const e of entries) {
      const resource = await repos.resources.get(e.provider, e.model);
      out.push({
        name: e.name,
        provider: e.provider,
        model: e.model,
        effort: e.thinking ?? null,
        effortMode: e.effortMode ?? "guaranteed",
        effortEvidence: e.effortEvidence ?? null,
        mode: e.mode ?? "interactive",
        acpAgent: e.acpAgent ?? null,
        availability: resource?.availability ?? "UNKNOWN",
        nextAvailableAt: resource?.next_available_at ?? null,
      });
    }
    return { models: out };
  });

  /**
   * The conversation: what we sent, and what the model actually said back.
   *
   * `blocks` is the point of this endpoint existing separately from a plain
   * "give me the text": `execution_messages.blocks` is where reasoning and
   * tool calls actually live (`messages.flatten` deliberately drops thinking
   * blocks and reduces a tool call to a one-line label — see the comment
   * there), and the Task Detail side panel needs the real shape to tell a
   * response apart from the model's reasoning and from what it actually ran.
   * A malformed row (there shouldn't be one, since `messages.append` is what
   * writes it) degrades to `null` rather than 500ing the whole transcript.
   */
  route("GET", "/api/work/tasks/{id}/transcript", async ({ id }) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    const executions = await repos.executions.listByTask(id);
    const turns = [];
    for (const e of executions) {
      if (e.instruction) {
        turns.push({ executionId: e.id, revision: e.revision_no, role: "operator", at: e.created_at, text: e.instruction, blocks: null });
      }
      for (const m of await repos.messages.listByExecution(e.id)) {
        // The gateway echoes our own dispatch back as `user` turns — measured:
        // the preamble wrapper arrives (sometimes more than once per run), and
        // the echo carries only the preamble, not even the instruction text,
        // so matching on the instruction cannot catch it. What an operator
        // actually typed never starts with the preamble marker (D48).
        if (m.role === "user" && isPreambleWrapped(m.content)) continue;
        let blocks = null;
        if (m.blocks) {
          try {
            blocks = JSON.parse(m.blocks);
          } catch {
            blocks = null;
          }
        }
        turns.push({ executionId: e.id, revision: e.revision_no, role: m.role, at: m.at, text: m.content, seq: m.seq, blocks });
      }
    }
    turns.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
    return { taskId: id, turns };
  });

  // --- brains ---------------------------------------------------------------
  //
  // Brain = (provider, model, thinking, effortMode) yang diberi nama. Halaman
  // konfigurasinya adalah alasan tabel ini ada: selama katalog hanya berupa
  // berkas, operator tidak bisa mengubahnya tanpa deploy, dan role AgentOS
  // tidak punya sesuatu yang bisa dipetakan kepadanya.
  route("GET", "/api/work/brains", async (_p, _b, query) => {
    const list = await controller.brains.list({
      level: query.get("level") ?? undefined,
      category: query.get("category") ?? undefined,
      enabledOnly: query.get("enabled") === "true",
    });
    // Ketersediaan datang dari tabel resources, bukan dari Brain: satu model
    // bisa dipakai beberapa Brain, dan kuotanya milik model.
    const out = [];
    for (const b of list) {
      const resource = await repos.resources.get(b.provider, b.model);
      // D51: jadwal reset dan kebijakan ulangnya diturunkan di sini, bukan
      // disimpan dua kali — otak keputusan ada di quota-windows.mjs dan UI
      // hanya menampilkan apa yang scheduler akan lakukan.
      out.push({
        ...b,
        availability: resource?.availability ?? "UNKNOWN",
        nextAvailableAt: resource?.next_available_at ?? null,
        quotaReset: {
          shortMs: b.quotaResetShortMs,
          longMs: b.quotaResetLongMs,
          shortLabel: describeWindow(b.quotaResetShortMs),
          longLabel: describeWindow(b.quotaResetLongMs),
          autoRetry: isRetryableWindow(b.quotaResetShortMs),
          retryLimit: QUOTA_RETRY_LIMIT,
        },
      });
    }
    return { brains: out };
  });

  route("POST", "/api/work/brains", async (_p, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may define brains");
    try {
      const brain = await controller.brains.create(body);
      log.info("brain.created", { brain: brain.name, level: brain.level, by: actor.name });
      return { brain };
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  route("PATCH", "/api/work/brains/{id}", async ({ id }, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may change brains");
    try {
      const brain = await controller.brains.update(id, body);
      log.info("brain.updated", { brain: brain.name, by: actor.name });
      return { brain };
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  // Deletion is the honest end for a Brain whose provider left the gateway.
  // Disabling keeps a dead row on the page forever — the old assumption
  // "brains are never deleted, only disabled" predates provider removal.
  // The endpoint clears brain_map cells pinning the brain (the same
  // semantics resolution already gives a missing brain: "not pinned") and
  // reports which cells fell back to the default grid. Provisioned agents
  // are left to the gateway, where they live. Admin-only like every other
  // deletion: a removal must be vouched for by an identity.
  route("DELETE", "/api/work/brains/{id}", async ({ id }, _b, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may delete brains");
    try {
      const { brain, clearedMappings } = await controller.brains.delete(id);
      log.info("brain.deleted", {
        brain: brain.name,
        clearedMappings: clearedMappings.map((m) => `${m.template}/${m.role}/${m.level}`),
        by: actor.name,
      });
      return { brain, clearedMappings };
    } catch (err) {
      if (String(err.message).startsWith("unknown brain")) throw notFound(err.message);
      throw badRequest(err.message);
    }
  });

  /**
   * Pemetaan (template × profile × role) → level.
   *
   * Profile adalah sumbu eksplisit: (software, fast) dan (software, quality)
   * adalah dua kebutuhan berbeda, dan halaman Role Map adalah grid
   * (template × role) dengan kolom dropdown per profile. Override ditandai
   * profilnya supaya jelas sel grid mana yang menyimpang dari default.
   */
  route("GET", "/api/work/role-levels", async (_p, _b, query) => {
    const template = query.get("template");
    const rows = await controller.store.all(
      template
        ? `SELECT * FROM role_levels WHERE template = ? ORDER BY role, profile`
        : `SELECT * FROM role_levels ORDER BY template, role, profile`,
      template ? [template] : [],
    );
    return {
      defaults: DEFAULT_ROLE_LEVELS,
      profileMapping: PROFILE_TO_LEVEL,
      profiles: PROFILES,
      overrides: rows.map((r) => ({
        template: r.template,
        profile: r.profile,
        role: r.role,
        level: r.level,
        updatedAt: r.updated_at,
      })),
    };
  });

  route("PUT", "/api/work/role-levels", async (_p, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may map roles to levels");
    const { template, profile, role } = body;
    const level = body.level ?? null;
    if (!template || !profile || !role) throw badRequest("template, profile and role are required");
    if (!PROFILES.includes(profile)) throw badRequest(`invalid profile "${profile}"`);
    // `level: null` menghapus override — sel grid kembali ke default bawaan.
    // Dibedakan dari field yang tidak dikirim supaya "reset" tidak terbaca
    // sebagai "biarkan".
    if (level === null) {
      await controller.store.run(`DELETE FROM role_levels WHERE template = ? AND profile = ? AND role = ?`, [
        String(template).toLowerCase(),
        profile,
        String(role).toLowerCase(),
      ]);
      log.info("role-level.cleared", { template, profile, role, by: actor.name });
      return { template, profile, role, level: null };
    }
    if (!["low", "normal", "critical"].includes(level)) throw badRequest(`invalid level "${level}"`);
    await controller.store.run(
      `INSERT INTO role_levels (template, profile, role, level, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(template, profile, role) DO UPDATE SET level = excluded.level,
         actor = excluded.actor, updated_at = excluded.updated_at`,
      [String(template).toLowerCase(), profile, String(role).toLowerCase(), level, actor.name, now()],
    );
    log.info("role-level.set", { template, profile, role, level, by: actor.name });
    return { template, profile, role, level };
  });

  /** Level efektif untuk sebuah (template, role, profile) — untuk pratinjau UI. */
  route("GET", "/api/work/role-levels/resolve", async (_p, _b, query) => {
    const template = query.get("template");
    const role = query.get("role");
    const profile = query.get("profile") ?? "balanced";
    const projectId = query.get("projectId");
    const rows = await controller.store.all(
      `SELECT role, level FROM role_levels WHERE template = ? AND profile = ?`,
      [String(template ?? "").toLowerCase(), profile],
    );
    const overrides = Object.fromEntries(rows.map((r) => [r.role, r.level]));
    const projectOverrides = projectId
      ? Object.fromEntries((await repos.projects.roleLevels.list(projectId)).map((r) => [r.role, r.level]))
      : {};
    const level = resolveLevel({ template, role, profile, overrides, projectOverrides });
    return {
      template, role, profile, level,
      source: projectOverrides[String(role ?? "").toLowerCase()]
        ? "project"
        : overrides[String(role ?? "").toLowerCase()]
          ? "operator"
          : DEFAULT_ROLE_LEVELS[String(template ?? "").toLowerCase()]?.[String(profile ?? "").toLowerCase()]?.[String(role ?? "").toLowerCase()]
            ? "template default"
            : "project profile",
      candidates: (await controller.brains.candidatesFor({ level })).map((b) => b.name),
    };
  });

  // --- brain map ------------------------------------------------------------
  //
  // Pemetaan (template × role × level) → Brain tertentu. Melengkapi
  // role-levels, tidak menggantikannya: yang satu memutuskan seberapa mahal
  // role boleh berpikir, yang ini memutuskan Brain mana pada level itu.
  // Halamannya grid dengan dropdown per kolom level; sel yang tidak dipaku
  // memakai default grid (DEFAULT_BRAIN_MAP), lalu kandidat level.
  route("GET", "/api/work/brain-map", async (_p, _b, query) => {
    const template = query.get("template");
    const mappings = await controller.brainMap.list({ template: template ?? undefined });
    const brains = await controller.brains.list({ enabledOnly: true });
    const byId = new Map(brains.map((b) => [b.id, b]));

    return {
      // Role yang tersedia per template, apa pun profilenya.
      roles: Object.fromEntries(
        Object.keys(DEFAULT_ROLE_LEVELS).map((tpl) => [tpl, rolesForTemplate(tpl)]),
      ),
      rolesNotInAgentOs: ROLES_NOT_IN_AGENTOS,
      levels: ["low", "normal", "critical"],
      defaults: DEFAULT_BRAIN_MAP,
      brains: brains.map((b) => ({ id: b.id, name: b.name, level: b.level, category: b.category ?? null })),
      mappings: mappings.map((m) => {
        const brain = byId.get(m.brainId) ?? null;
        return {
          ...m,
          brainName: brain?.name ?? null,
          brainLevel: brain?.level ?? null,
          // `belowLevel`: Brain yang klasifikasinya di bawah level selnya.
          // Dengan kunci per level itu keputusan eksplisit operator — dipakai,
          // tetapi ditandai supaya tidak ada penurunan yang tidak disadari.
          belowLevel: brain ? LEVEL_RANK[brain.level] < LEVEL_RANK[m.level] : false,
          // `stale` berarti: baris ini ada di halaman tetapi tidak akan pernah
          // dipakai. Menampilkannya tanpa tanda persis kelas kesalahan agen
          // `config-only` di D32 — terlihat benar, tidak pernah berjalan.
          stale: !brain,
        };
      }),
    };
  });

  route("PUT", "/api/work/brain-map", async (_p, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may map roles to brains");
    const { template, role, level } = body;
    if (!template || !role || !level) throw badRequest("template, role and level are required");
    if (!["low", "normal", "critical"].includes(level)) throw badRequest(`invalid level "${level}"`);
    // `brainId: null` melepas pemaku. Dibedakan dari field yang tidak dikirim
    // supaya "lepaskan" tidak terbaca sebagai "biarkan".
    if (body.brainId === null) {
      const cleared = await controller.brainMap.clear({ template, role, level });
      log.info("brain-map.cleared", { template, role, level, by: actor.name });
      return { mapping: cleared };
    }
    try {
      const mapping = await controller.brainMap.set(
        { template, role, level, brainId: body.brainId, actor: actor.name },
        { brains: controller.brains },
      );
      log.info("brain-map.set", { template, role, level, brain: body.brainId, by: actor.name });
      return { mapping };
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  // --- komentar operator pada task ------------------------------------------
  //
  // Ditulis ke event_log, bukan ke tabel baru. Komentar adalah catatan
  // "seseorang berkata X pada waktu Y" — persis bentuk yang sudah dipegang log
  // append-only, dan ia langsung terbaca oleh `GET /api/work/events?subject=`
  // yang dipakai linimasa di popup task. Tabel terpisah hanya akan menambah
  // sumber kebenaran kedua untuk hal yang sama.
  route("POST", "/api/work/tasks/{id}/comments", async ({ id }, body, _q, actor) => {
    const task = await repos.tasks.get(id);
    if (!task) throw notFound(`unknown task ${id}`);
    const text = String(body.text ?? body.note ?? "").trim();
    if (!text) throw badRequest("text is required");
    if (text.length > 8000) throw badRequest("comment is too long (max 8000 characters)");
    const by = actor?.kind === "operator" ? actor.name : (body.by ?? "operator");
    await controller.events.append({
      kind: "task.comment",
      subjectType: "task",
      subjectId: id,
      actor: by,
      payload: { text },
    });
    return { comment: { taskId: id, text, by, at: now() } };
  });

  // --- register tasks from docs/tasks.md -------------------------------------
  //
  // Pendaftaran task dari dokumen checklist (PREPARE "daftarkan…"). Dokumen
  // adalah sumbernya; controller hanya memindahkan apa yang tertulis ke
  // basis data — judul, deskripsi, role, dependensi antar temporary ID.
  //
  // Status default CREATED (tertahan): mendaftarkan 40+ task sekaligus
  // langsung ke antrian berarti satu kesalahan baca dokumen langsung
  // memakan worker seluruh project — alasan yang sama dekomposisi menahan
  // fase lanjutannya. Bila operator minta "langsung jalankan", semuanya
  // QUEUED dan admission yang memutuskan siapa yang benar-benar jalan
  // (dependensi parkir di WAIT_DEP persis seperti hasil dekomposisi).
  async function registerTasksFromDoc({ projectId, text, actor }) {
    const project = await repos.projects.get(projectId);
    if (!project) throw badRequest(`unknown project ${projectId}`);
    const root = project.workspace_path;
    if (!root) {
      return { ok: false, reason: "Project belum punya workspace — docs/tasks.md tidak bisa dibaca." };
    }
    let content;
    try {
      content = await readFile(`${root}/docs/tasks.md`, "utf8");
    } catch {
      return { ok: false, reason: "docs/tasks.md tidak ada — buat dulu lewat PREPARE “Create tasks”." };
    }
    // Hanya `[ ]` yang belum hidup di basis data: `[-]` sudah pernah
    // didaftarkan (controller yang menandainya balik saat pendaftaran
    // berhasil) dan `[x]` selesai di dokumen — keduanya TIDAK boleh dibuat
    // ulang, karena "daftarkan" kedua kali yang menduplikasi seluruh
    // checklist adalah cara paling halus untuk menggandakan pekerjaan.
    const docItems = parseTasksMd(content);
    const items = docItems.filter((t) => !t.done && !t.registered);
    if (docItems.length > 0 && items.length === 0) {
      return { ok: false, reason: "Semua tasks sudah didaftarkan sebelumnya", already: true };
    }
    if (docItems.length === 0) {
      return {
        ok: false,
        reason: "Tidak ada task yang bisa didaftarkan dari docs/tasks.md — format checklist tidak dikenali.",
      };
    }
    // D43: setiap permukaan pembuat task match worker dengan cara yang sama.
    const worker = await repos.workers.match({ projectId });
    if (!worker) {
      return {
        ok: false,
        reason:
          "Tidak ada worker aktif yang boleh mengerjakan project ini — daftarkan worker dengan akses ke project tersebut lebih dulu.",
      };
    }
    const immediate = wantsImmediateRun(text);
    const idByLocal = new Map();
    const registered = [];
    for (const item of items) {
      // Dependensi hanya ke task yang sudah terdaftar di atasnya — checklist
      // ditulis top-down, jadi referensi maju (kalau ada) dibuang, bukan
      // dibuat menggantung ke id yang tidak ada.
      const dependsOn = item.deps.map((d) => idByLocal.get(d)).filter(Boolean);
      const task = await repos.tasks.create({
        projectId,
        workerId: worker.id,
        title: item.title.slice(0, 120),
        description: item.description ?? item.title,
        workspacePath: root,
        modelPolicy: item.role && ROLE_CATEGORY[item.role] ? { category: ROLE_CATEGORY[item.role] } : {},
        dependsOn,
      });
      idByLocal.set(item.localId, task.id);
      await controller.events.append({
        kind: EventKind.TASK_CREATED,
        subjectType: "task",
        subjectId: task.id,
        actor,
        payload: { source: "docs/tasks.md", localId: item.localId, role: item.role, dependsOn },
      });
      if (immediate) {
        await repos.tasks.setStatus(task.id, Status.QUEUED, { actor });
      }
      registered.push({
        localId: item.localId,
        id: task.id,
        title: item.title,
        status: immediate ? Status.QUEUED : Status.CREATED,
        role: item.role,
        deps: item.deps,
      });
    }
    if (immediate) await scheduler.notify(WakeReason.TASK_CREATED);
    // Tulis balik `[-]` SETELAH seluruh loop sukses — menandai per task di
    // tengah loop berarti kegagalan task ke-N meninggalkan tanda untuk task
    // yang belum dibuat. Kegagalan menulis bukan kegagalan mendaftarkan
    // (task sudah hidup di basis data), jadi ia jadi peringatan di jawaban,
    // bukan rollback: berbohong "gagal semua" akan menyuruh operator
    // mengulang pendaftaran yang justru menduplikasi.
    let marked = true;
    try {
      await writeFile(`${root}/docs/tasks.md`, markRegistered(content, registered.map((r) => r.localId)), "utf8");
    } catch (err) {
      marked = false;
      log.warn("control.tasks-mark-failed", { project: projectId, error: err.message });
    }
    log.info("control.tasks-registered", { project: projectId, count: registered.length, immediate, marked, by: actor });
    return { ok: true, registered, immediate, marked };
  }

  // --- control surface ------------------------------------------------------
  //
  // Permukaan chat untuk UI Semanggi. Berbagi router intent dengan Slack
  // (§8.2), tetapi menjawab dengan STRUKTUR, bukan teks: halaman perlu tahu
  // intent apa yang terdeteksi dan task apa yang terbentuk, dan memaksa UI
  // mem-parse balasan prosa akan membuat dua permukaan menyimpang diam-diam.
  route("POST", "/api/work/control/message", async (_p, body, _q, actor) => {
    const text = String(body.text ?? "").trim();
    if (!text) throw badRequest("text is required");
    const parsed = classify(text);

    if (parsed.intent === Intent.CHAT) {
      return { intent: "CHAT", reply: `Halo. ${CONTROL_HELP}`, tasks: [] };
    }
    if (parsed.intent === Intent.CONFIRM) {
      // Klasifikasi yang tidak yakin MUST menjadi pertanyaan, bukan aksi
      // (§8.2). Ini berlaku di sini persis seperti di Slack — sebuah halaman
      // yang lebih longgar akan menjadi jalan pintas untuk melewati aturannya.
      return {
        intent: "CONFIRM",
        reply: `Saya belum yakin maksudnya${parsed.reason ? ` — ${parsed.reason}` : ""}.`,
        reason: parsed.reason ?? null,
        tasks: [],
      };
    }

    if (parsed.intent === Intent.PREPARE) {
      // Persiapan dokumen rencana sebagai SATU task analyst — bukan rantai
      // dekomposisi (D47). Project dari body/env, sama dengan jalur TASK.
      const taskProjectId = body.projectId ?? process.env.SEMANGGI_DEFAULT_PROJECT ?? null;
      if (!taskProjectId) throw badRequest("projectId is required (tidak ada project default yang dikonfigurasi)");
      const by = actor?.kind === "operator" ? actor.name : String(body.user ?? "agentos-ui");

      // "Daftarkan semua tasks yang ada di docs/tasks.md…" juga PREPARE:
      // menyiapkan pekerjaan agar bisa dijalankan — hanya saja hasilnya
      // bukan dokumen, melainkan task di basis data. Dideteksi dari verba
      // "daftarkan" + rujukan ke tasks.md; di luar itu jatuh ke jalur
      // penyusunan dokumen rencana di bawah.
      if (/daftarkan/i.test(parsed.text) && /tasks\.md/i.test(parsed.text)) {
        const outcome = await registerTasksFromDoc({ projectId: taskProjectId, text: parsed.text, actor: by });
        if (!outcome.ok) {
          return {
            intent: "PREPARE",
            action: "register",
            taskId: null,
            needsConfirmation: false,
            target: null,
            reply: outcome.reason,
            tasks: [],
            registered: [],
          };
        }
        return {
          intent: "PREPARE",
          action: "register",
          taskId: null,
          needsConfirmation: false,
          target: null,
          reply:
            `${outcome.registered.length} task didaftarkan dari docs/tasks.md — ` +
            (outcome.immediate
              ? "semua masuk antrian (QUEUED) dan mengalir sesuai dependensinya."
              : "semua berstatus CREATED, menunggu dijalankan; tambah “langsung jalankan” untuk mengantrekannya.") +
            (outcome.marked === false
              ? " Peringatan: docs/tasks.md gagal ditandai `[-]` — perbaiki izinnya sebelum mendaftarkan lagi, atau task ini akan terdaftar dua kali."
              : " Checkbox task di docs/tasks.md kini bertanda `[-]`.") +
            `  _(${by})_`,
          tasks: [],
          registered: outcome.registered,
          created: true,
        };
      }

      const outcome = await createPrepareTask(controller, {
        projectId: taskProjectId,
        text: parsed.text,
        actor: by,
      });
      if (!outcome.ok) {
        return {
          intent: "PREPARE",
          action: "task",
          taskId: null,
          needsConfirmation: false,
          target: null,
          reply: outcome.reason,
          tasks: [],
        };
      }
      return {
        intent: "PREPARE",
        action: "task",
        taskId: outcome.task.id,
        needsConfirmation: false,
        target: { id: outcome.task.id, title: outcome.task.title, status: outcome.task.status },
        reply: `Task \`${outcome.task.id}\` dibuat — satu analyst (${outcome.level}, ${outcome.brain.name}) menyiapkan docs/plans.md dan docs/tasks.md  _(${by})_`,
        tasks: [],
      };
    }

    if (parsed.intent === Intent.TASK) {
      // "TASK: <description>" declares a direct single task — a core
      // control-plane operation, deliberately NOT behind the Slack app: the
      // Command Center has no dependency on the Slack surface, and forcing
      // this through the channel adapter made the endpoint 400 on instances
      // without Slack configured (found live 2026-09-05). Task-scoped
      // commands (status/stop/run/model) keep using the shared handler below.
      if (parsed.action === Action.CREATE) {
        const taskProjectId = body.projectId ?? process.env.SEMANGGI_DEFAULT_PROJECT ?? null;
        if (!taskProjectId) throw badRequest("projectId is required (tidak ada project default yang dikonfigurasi)");
        if (!(await repos.projects.get(taskProjectId))) throw badRequest(`unknown project ${taskProjectId}`);

        // D43: every task-creating surface matches the same way — least-loaded
        // ACTIVE worker with access; assign or refuse, never park silently.
        const worker = await repos.workers.match({ projectId: taskProjectId });
        if (!worker) {
          return {
            intent: "TASK",
            action: "task",
            taskId: null,
            needsConfirmation: false,
            target: null,
            reply:
              "Tidak ada worker aktif yang boleh mengerjakan project ini — daftarkan worker dengan akses ke project tersebut lebih dulu, atau task akan parkir selamanya.",
            tasks: [],
          };
        }

        const by = actor?.kind === "operator" ? actor.name : String(body.user ?? "agentos-ui");
        const task = await repos.tasks.create({
          projectId: taskProjectId,
          workerId: worker.id,
          title: parsed.text.slice(0, 120),
          description: parsed.text,
        });
        await repos.tasks.setStatus(task.id, Status.QUEUED, { actor: by });
        await scheduler.notify(WakeReason.TASK_CREATED);
        log.info("control.task-created", { task: task.id, project: taskProjectId, by });
        return {
          intent: "TASK",
          action: "task",
          taskId: task.id,
          needsConfirmation: false,
          target: { id: task.id, title: task.title, status: task.status },
          reply: `Task \`${task.id}\` dibuat dan masuk antrian — *${task.title}*  _(${by})_`,
          tasks: [],
        };
      }

      if (!controller.slackApp) throw badRequest("perintah task belum tersedia di instance ini");
      // Identitas: token operator kalau ada, kalau tidak nama yang dikirim UI.
      // Halaman ini memakai satu token bersama, jadi `name` di sini adalah
      // satu-satunya yang membedakan siapa yang bertindak — dan ia berasal dari
      // pemanggil, bukan dari kredensial. Itu batas yang diketahui, bukan
      // atribusi yang bisa dipercaya (§8.4).
      const operator =
        actor?.kind === "operator"
          ? { id: actor.id, name: actor.name, role: actor.role }
          : { id: "agentos-ui", name: String(body.user ?? "agentos-ui"), role: "operator" };
      const result = await controller.slackApp.runCommand({
        parsed,
        operator,
        confirmed: body.confirm === true,
        // Command Center memilih project aktifnya sendiri; CREATE lewat "TASK:"
        // harus masuk ke project itu, bukan ke SEMANGGI_DEFAULT_PROJECT.
        projectId: body.projectId ?? process.env.SEMANGGI_DEFAULT_PROJECT ?? undefined,
      });
      return {
        intent: "TASK",
        action: parsed.action,
        taskId: parsed.taskId,
        needsConfirmation: result.needsConfirmation === true,
        target: result.target ?? null,
        reply: result.text,
        tasks: [],
      };
    }

    // WORK — dekomposisi.
    const projectId = body.projectId ?? process.env.SEMANGGI_DEFAULT_PROJECT ?? null;
    if (!projectId) throw badRequest("projectId is required (tidak ada project default yang dikonfigurasi)");
    const project = await repos.projects.get(projectId);
    if (!project) throw badRequest(`unknown project ${projectId}`);

    // D37: template and profile are the project's own setting (Settings →
    // Project), not something re-typed per request. `body.template`/
    // `body.profile` still work as an explicit override — Slack's `runCommand`
    // and the test harness both rely on being able to pin these — but the
    // Control page itself no longer sends them, so the project row is what
    // decides for every normal request.
    const template = String(body.template ?? project.template ?? "software").toLowerCase();
    const profile = String(body.profile ?? project.profile ?? "balanced").toLowerCase();
    const overrideRows = await controller.store.all(
      `SELECT role, level FROM role_levels WHERE template = ? AND profile = ?`,
      [template, profile],
    );
    const overrides = Object.fromEntries(overrideRows.map((r) => [r.role, r.level]));
    // Snapshot milik project (modal Project Role Level) menang atas keduanya:
    // begitu operator menyimpannya, dekomposisi project ini mengikutinya,
    // bukan lagi role_levels global ataupun default template.
    const projectOverrideRows = await repos.projects.roleLevels.list(projectId);
    const projectOverrides = Object.fromEntries(projectOverrideRows.map((r) => [r.role, r.level]));

    const plan = buildPlan({
      // parsed.text, bukan `text` mentah: deklarasi "WORK: " sudah dipisah
      // classifier — menyertakannya kembali berarti setiap fase membaca
      // permintaan yang diawali sisa prefix.
      request: parsed.text,
      template,
      levelFor: (role) => resolveLevel({ template, role, profile, overrides, projectOverrides }),
    });

    // Brain per fase diselesaikan SEBELUM satu task pun dibuat. Membuat dulu
    // lalu menemukan bahwa separuhnya tidak punya Brain akan meninggalkan
    // rencana setengah jadi yang harus dibersihkan tangan.
    const resolved = [];
    for (const step of plan) {
      const pick = await controller.brainMap.resolve({
        template,
        role: step.role,
        level: step.level,
        brains: controller.brains,
        category: step.category,
      });
      resolved.push({ ...step, brain: pick.brain, brainSource: pick.source, brainNote: pick.reason });
    }

    const unresolved = resolved.filter((s) => !s.brain);
    if (unresolved.length > 0 && body.force !== true) {
      return {
        intent: "WORK",
        created: false,
        reply:
          `Rencana ${resolved.length} fase siap, tetapi ${unresolved.length} fase belum punya Brain: ` +
          `${unresolved.map((s) => `${s.role} (${s.level})`).join(", ")}. ` +
          "Tetapkan Brain-nya di halaman Brain Map, atau kirim ulang dengan force untuk membuat task tetap tertahan.",
        plan: resolved.map(presentPlanStep),
        tasks: [],
      };
    }

    // D29/D35: a task-creating surface assigns a worker or refuses —
    // admission only validates, and a task created bare parks on
    // WAIT_WORKER with the whole chain stalled behind it (found live
    // 2026-09-05: "Create plans" queued six phases and the first parked
    // immediately). Least-loaded match per phase role (D43); refuse the
    // whole plan when a role has nobody, mirroring the Brain check above —
    // a half-created plan is worse than no plan.
    for (const step of resolved) {
      const worker = await repos.workers.match({ projectId, role: step.role });
      if (!worker) {
        return {
          intent: "WORK",
          created: false,
          reply:
            `Rencana ${resolved.length} fase siap, tetapi tidak ada worker aktif untuk role: ` +
            `${resolved.map((s) => s.role).join(", ")}. ` +
            "Daftarkan worker dengan akses ke project ini lebih dulu.",
          plan: resolved.map(presentPlanStep),
          tasks: [],
        };
      }
      step.workerId = worker.id;
    }

    // Dibuat dengan `hold`: dekomposisi otomatis membuat banyak task sekaligus,
    // dan melepas semuanya ke antrian tanpa jeda berarti kesalahan membaca satu
    // kalimat langsung memakan worker beberapa project. Fase pertama dilepas;
    // sisanya menunggu ketergantungannya lewat halaman Summary.
    const idByRole = new Map();
    const created = [];
    for (const step of resolved) {
      const dependsOn = step.after.map((r) => idByRole.get(r)).filter(Boolean);
      const task = await repos.tasks.create({
        projectId,
        workerId: step.workerId,
        title: step.title,
        description: step.description,
        qualityClass: step.qualityClass,
        workspaceMode: step.workspaceMode,
        workspacePath: project.workspace_path,
        modelPolicy: {
          category: step.category ?? undefined,
          class: step.level,
          ...(step.brain ? { preferred: [step.brain.name] } : {}),
        },
        dependsOn,
      });
      idByRole.set(step.role, task.id);
      created.push({ ...presentPlanStep(step), taskId: task.id, dependsOn });
      await controller.events.append({
        kind: "task.decomposed",
        subjectType: "task",
        subjectId: task.id,
        actor: actor?.name ?? "operator",
        payload: { role: step.role, level: step.level, brain: step.brain?.name ?? null, dependsOn, request: text },
      });
    }

    // Hanya fase tanpa ketergantungan yang dilepas; sisanya sudah terikat
    // WAIT_DEP dan akan mengalir sendiri saat pendahulunya selesai.
    for (const step of created) {
      if (step.dependsOn.length === 0) {
        await repos.tasks.setStatus(step.taskId, Status.QUEUED, { actor: actor?.name ?? "operator" });
      }
    }
    await scheduler.notify(WakeReason.TASK_CREATED);

    return {
      intent: "WORK",
      created: true,
      projectId,
      template,
      reply: `Permintaan dipecah menjadi ${created.length} task. ${created.filter((c) => c.dependsOn.length === 0).length} sudah masuk antrian; sisanya menunggu pendahulunya.`,
      tasks: created,
    };
  });

  // --- gateway models & thinking levels --------------------------------------
  //
  // Dua endpoint bacaan yang mengisi form Brain: model yang BENAR-BENAR
  // onboarded di gateway sekarang (bukan katalog statis), dan kosakata
  // thinking yang sudah diukur per model (bukan ditebak dari nama levelnya).
  // Reads the cache, not the gateway — a page load or form open is not a
  // reason to pay for a live RPC. "Refresh Models" below is the only path
  // that actually asks the gateway, and it writes its answer here so this
  // route serves it to everyone else afterward.
  route("GET", "/api/work/gateway/models", async () => {
    const models = await controller.gatewayModels?.list?.().catch(() => []) ?? [];
    return { models };
  });

  route("POST", "/api/work/gateway/models/refresh", async () => {
    const live = await controller.runtime?.listModels?.().catch(() => []) ?? [];
    const models = await controller.gatewayModels?.replaceAll?.(live) ?? live;
    log.info("gateway-models.refreshed", { count: models.length });
    return { models };
  });

  route("GET", "/api/work/gateway/thinking-levels", async (_p, _b, query) => {
    const provider = query.get("provider");
    const model = query.get("model");
    const levels = await controller.thinkingLevels.list(
      provider && model ? { provider, model } : {},
    );
    return { levels };
  });

  route("POST", "/api/work/gateway/thinking-levels/refresh", async (_p, _b, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may refresh the thinking-levels catalog");
    try {
      const result = await controller.thinkingLevels.refresh();
      log.info("thinking-levels.refreshed", { by: actor.name, ...result });
      return result;
    } catch (err) {
      throw badRequest(err.message);
    }
  });

  // --- thinking-level probe ---------------------------------------------------
  //
  // "Refresh Levels" in the Brain form. Unlike /refresh above (which only
  // re-syncs the DB from the static seed file), this actually dispatches
  // real runs against the gateway — one candidate level at a time, each with
  // its own bounded timeout (see thinking-probe.mjs and gateway-ws.mjs's
  // probeLevel). Per the 2026-09-01 operator decision this is scoped to
  // exactly the one (provider, model) the caller names, never a sweep of
  // every onboarded model — at least one live model is documented to hang
  // on some levels until the watchdog reclaims it, and a bulk probe would
  // multiply that cost by the whole fleet.
  //
  // Seven candidate levels at up to a minute each can run well past any
  // reasonable HTTP timeout, including the AgentOS proxy chain in front of
  // this controller — so this route starts the probe and returns
  // immediately. The caller polls GET .../thinking-levels/probe/status,
  // and once it stops running, re-reads GET .../thinking-levels for the
  // persisted result.
  route("POST", "/api/work/gateway/thinking-levels/probe", async (_p, body, _q, actor) => {
    if (actor?.role !== "admin") throw forbidden("only an admin may probe thinking levels");
    const provider = String(body?.provider ?? "").trim();
    const model = String(body?.model ?? "").trim();
    if (!provider || !model) throw badRequest("provider and model are required");
    if (!controller.runtime?.probeLevel) throw badRequest("this runtime does not support thinking-level probing");

    const statusKey = `${provider}/${model}`.toLowerCase();
    const existing = thinkingProbes.get(statusKey);
    if (existing?.running) {
      return { ok: true, started: false, reason: "already-running", provider, model, status: presentProbeStatus(existing) };
    }

    const live = (await controller.runtime?.listAgents?.().catch(() => [])) ?? [];
    const match = live.find((a) => String(a?.model?.primary ?? "").toLowerCase() === statusKey);
    if (!match) {
      const status = {
        running: false,
        startedAt: now(),
        finishedAt: now(),
        error: null,
        reason: "no-agent",
        message:
          `No agent is currently provisioned for ${provider}/${model}. A thinking-level probe needs an existing ` +
          `agent bound to this model — pin one via Brain Map + the provisioner, or create one in AgentOS first.`,
        samples: [],
      };
      thinkingProbes.set(statusKey, status);
      return { ok: false, started: false, reason: "no-agent", provider, model, status: presentProbeStatus(status) };
    }
    const agentId = match.id ?? match.agentId;

    const status = { running: true, startedAt: now(), finishedAt: null, error: null, reason: null, message: null, samples: [] };
    thinkingProbes.set(statusKey, status);
    log.info("thinking-levels.probe-started", { provider, model, agentId, by: actor.name });

    // Fire-and-forget: the HTTP response below does not wait on this. Every
    // failure path is caught and recorded on the status entry rather than
    // thrown into an unhandled rejection.
    (async () => {
      try {
        const result = await probeThinkingLevels({
          runtime: controller.runtime,
          agentId,
          now,
          onLevelDone: async (_sample, samplesSoFar, partial) => {
            status.samples = samplesSoFar;
            // Persisted incrementally so a probe interrupted partway (a
            // process restart, an operator giving up on a hung level)
            // still leaves behind whatever it measured, rather than an
            // all-or-nothing write at the very end.
            try {
              await controller.thinkingLevels.upsert({ provider, model, ...partial });
            } catch (err) {
              log.warn("thinking-levels.probe-partial-save-failed", {
                provider, model, error: String(err.message).slice(0, 160),
              });
            }
          },
        });
        await controller.thinkingLevels.upsert({
          provider, model, levels: result.levels, effortMode: result.effortMode, evidence: result.evidence,
        });
        status.samples = result.samples;
        status.running = false;
        status.finishedAt = now();
        log.info("thinking-levels.probe-finished", {
          provider, model, agentId, levels: result.levels, effortMode: result.effortMode,
        });
      } catch (err) {
        status.running = false;
        status.finishedAt = now();
        status.error = String(err.message).slice(0, 300);
        log.error("thinking-levels.probe-failed", { provider, model, agentId, error: status.error });
      }
    })();

    return { ok: true, started: true, provider, model, agentId, status: presentProbeStatus(status) };
  });

  route("GET", "/api/work/gateway/thinking-levels/probe/status", async (_p, _b, query) => {
    const provider = query.get("provider");
    const model = query.get("model");
    if (!provider || !model) throw badRequest("provider and model are required");
    const status = thinkingProbes.get(`${provider}/${model}`.toLowerCase());
    if (!status) return { found: false, running: false };
    return { found: true, ...presentProbeStatus(status) };
  });

  // --- brain connection test --------------------------------------------------
  //
  // "Test" berarti: cari agen yang SUDAH ada dan sudah membawa model Brain ini,
  // lalu kirim satu prompt sekali pakai. Tidak ada RPC untuk menguji kombinasi
  // (provider, model, thinking) secara abstrak — satu agen membawa tepat satu
  // model (D35), dan gateway menolak menjalankan model di luar itu bahkan untuk
  // admin. Kalau belum ada agen untuk Brain ini, itu dilaporkan apa adanya,
  // bukan disamarkan sebagai kegagalan koneksi.
  //
  // `claude-code` MUST NOT be matched the same way as every other provider.
  // It is harness-routed (POC-3, agent-registry.mjs `isHarnessRouted`): the
  // agent that actually runs it is a named ACP agent (`acpAgent` in
  // routing.json, e.g. "claude-opus"), never a live agent literally reporting
  // model `claude-code/claude-code` — no such agent exists or ever will.
  // Matching on `model.primary` for a claude-code Brain therefore always
  // missed, and every claude Brain read as "no agent provisioned" even with a
  // running, healthy harness. Fixed by resolving on `acpAgent`'s own agent id
  // for that one provider, the same distinction dispatch already makes.
  function resolveTestAgent(liveAgents, { provider, model, acpAgent }) {
    if (provider === "claude-code") {
      if (!acpAgent) {
        return {
          match: null,
          message:
            "This Brain has no ACP agent pinned. claude-code is dispatched to a named harness agent " +
            '(routing.json "acpAgent"), never matched by model — set one before testing.',
        };
      }
      const match = liveAgents.find((a) => String(a?.id ?? "").toLowerCase() === acpAgent.toLowerCase());
      return {
        match,
        message: match
          ? null
          : `No live agent named "${acpAgent}" — the ACP harness agent this Brain pins. Provision it first.`,
      };
    }
    const target = `${provider}/${model}`.toLowerCase();
    const match = liveAgents.find((a) => String(a?.model?.primary ?? "").toLowerCase() === target);
    return {
      match,
      message: match
        ? null
        : `No agent is currently provisioned for ${target}. A connection test needs an existing agent ` +
          `bound to this model — pin one via Brain Map + the provisioner, or create one in AgentOS first.`,
    };
  }

  async function runBrainTest({ provider, model, acpAgent, thinking, effortMode }) {
    const live = (await controller.runtime?.listAgents?.().catch(() => [])) ?? [];
    const { match, message } = resolveTestAgent(live, { provider, model, acpAgent });
    if (!match) return { ok: false, reason: "no-agent", message };

    const agentId = match.id ?? match.agentId;
    const effectiveThinking = thinking && effortMode === "guaranteed" ? thinking : null;
    if (!controller.runtime?.testAgent) {
      throw badRequest("this runtime does not support connection testing");
    }
    const result = await controller.runtime.testAgent({ agentId, thinking: effectiveThinking });
    return { ok: result.ok, agentId, thinking: effectiveThinking, ...result };
  }

  route("POST", "/api/work/brains/{id}/test", async ({ id }) => {
    const brain = await controller.brains.get(id);
    if (!brain) throw notFound(`unknown brain ${id}`);
    const result = await runBrainTest(brain);
    log.info("brain.tested", { brain: brain.name, agentId: result.agentId ?? null, ok: result.ok, status: result.status });
    return result;
  });

  // Tests an unsaved Brain draft — same resolution and dispatch as the route
  // above, minus a saved row to read from. Exists so "Add Brain" can verify a
  // (provider, model) combination actually has a live agent before the
  // operator commits to it, instead of finding out only after saving.
  route("POST", "/api/work/brains/test", async (_p, body) => {
    const provider = String(body?.provider ?? "").trim();
    const model = String(body?.model ?? "").trim();
    if (!provider || !model) throw badRequest("provider and model are required");
    const acpAgent = body?.acpAgent ? String(body.acpAgent).trim() || null : null;
    const thinking = body?.thinking ? String(body.thinking).trim() || null : null;
    const effortMode = body?.effortMode === "preference" ? "preference" : "guaranteed";

    const result = await runBrainTest({ provider, model, acpAgent, thinking, effortMode });
    log.info("brain.tested-draft", { provider, model, agentId: result.agentId ?? null, ok: result.ok, status: result.status });
    return result;
  });

  // --- agents ---------------------------------------------------------------
  //
  // Deliberately read-only. Two control planes already write this registry
  // without coordinating (D32); adding a third writer would make the drift
  // worse, and the controller has no need — it creates agents through the
  // gateway's RPC, which is the one path that produces a runnable agent.
  route("GET", "/api/work/agents", async () => {
    const live = await controller.runtime?.listAgents?.().catch(() => []) ?? [];
    const configAgents = readAgentConfig();
    const catalog = controller.policy.catalogEntries();
    const rows = buildAgentInventory({ liveAgents: live, configAgents, catalog });
    return { summary: summariseInventory(rows), agents: rows };
  });

  // --- introspection --------------------------------------------------------
  route("GET", "/api/work/queue", async () => {
    const ts = now();
    const waiting = [];
    for (const status of [Status.QUEUED, ...Object.values(Status).filter((s) => s.startsWith("WAIT_"))]) {
      for (const task of await repos.tasks.list({ status, limit: 10_000 })) {
        waiting.push({
          id: task.id,
          projectId: task.project_id,
          status: task.status,
          waitReason: task.wait_reason,
          priority: task.priority,
          effectivePriority: effectivePriority(task, ts),
          // ETA is only ever a forecast (POC-4 §5.4): it informs planning and
          // never feeds an admission decision.
          etaAt: task.next_retry_at ?? null,
        });
      }
    }
    return {
      running: await admission.countRunning(),
      waiting,
      lastPasses: scheduler.history.slice(-10),
    };
  });

  route("GET", "/api/work/resources", async () => ({
    resources: (await repos.resources.list()).map(presentResource),
  }));

  route("POST", "/api/work/resources", async (_p, body) => {
    if (!body.provider || !body.model) throw badRequest("provider and model are required");
    const resource = await repos.resources.upsert(body);
    await scheduler.notify(WakeReason.RESOURCE_CHANGED);
    return { resource: presentResource(resource) };
  });

  route("GET", "/api/work/leases", async () => ({
    leases: (await repos.leases.list()).map((l) => ({
      workspacePath: l.workspace_path,
      mode: l.mode,
      executionId: l.execution_id,
      owner: l.owner,
      acquiredAt: l.acquired_at,
      expiresAt: l.expires_at,
      expired: l.expires_at <= now(),
    })),
  }));

  /** Empirical routing input (POC-4 §7.1, §12.4): observed cost per model. */
  route("GET", "/api/work/stats", async () => {
    const rows = await controller.store.all(
      `SELECT model_provider, model_id, status,
              COUNT(*) AS runs,
              SUM(tokens_input) AS tokens_input,
              SUM(tokens_output) AS tokens_output,
              AVG(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
                       THEN ended_at - started_at END) AS avg_duration_ms
         FROM executions
        WHERE model_provider IS NOT NULL
        GROUP BY model_provider, model_id, status`,
    );
    return {
      models: rows.map((r) => ({
        model: `${r.model_provider}/${r.model_id}`,
        status: r.status,
        runs: r.runs,
        tokensInput: r.tokens_input ?? 0,
        tokensOutput: r.tokens_output ?? 0,
        avgDurationMs: r.avg_duration_ms ?? null,
      })),
    };
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://controller.local");
    const match = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));

    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // Who is calling. Two accepted credentials, and the difference matters:
    //
    //   a per-operator token  -> a named person; actions are attributed to them
    //   the service token     -> the controller's own automation and the Slack
    //                            app itself, which must then name the operator
    //                            it is acting for (see the Slack routes)
    //
    // A named operator always wins, so an operator token is never silently
    // downgraded to "anonymous service".
    let actor = null;
    if (match.auth) {
      const header = req.headers.authorization ?? "";
      const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
      const operator = controller.operators ? await controller.operators.byToken(provided) : null;
      if (operator) {
        actor = { kind: "operator", id: operator.id, name: operator.name, role: operator.role };
      } else if (tokenMatches(provided, token)) {
        actor = { kind: "service", id: "service", name: "service", role: "admin" };
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (actor.role === "readonly" && req.method !== "GET") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `operator ${actor.name} is read-only` }));
        return;
      }
    }

    let body = {};

    // Slack authenticates with a signature over the RAW bytes, not with a
    // bearer token, so its routes read the body themselves and verify before
    // anything else happens. Parsing and re-encoding would change the bytes and
    // break every signature.
    if (match.slack) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const verdict = verifySlackRequest({
        signingSecret: slackSigningSecret,
        signature: req.headers["x-slack-signature"],
        timestamp: req.headers["x-slack-request-timestamp"],
        rawBody,
        now,
      });
      if (!verdict.ok) {
        log.warn("slack.rejected", { reason: verdict.reason, path: url.pathname });
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `slack verification failed: ${verdict.reason}` }));
        return;
      }
      const parsed = parseSlackBody(rawBody, req.headers["content-type"] ?? "");
      try {
        const payload = await match.handler(
          Object.fromEntries(match.names.map((n, i) => [n, decodeURIComponent(url.pathname.match(match.regex)[i + 1])])),
          parsed,
          url.searchParams,
          null,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload ?? {}));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        log.error("slack.handler-failed", { error: String(err.message).slice(0, 200) });
        res.writeHead(status, { "content-type": "application/json" });
        // Slack shows `text` to the operator, so the failure is visible where
        // they are rather than only in a log they are not reading.
        res.end(JSON.stringify({ response_type: "ephemeral", text: `Failed: ${err.message}` }));
      }
      return;
    }

    // PATCH carries a body too; only reading it for POST silently discarded
    // every field of an update and made the call look like a no-op.
    //
    // PUT was missing here and it was not harmless: `PUT /api/work/role-levels`
    // reads `body.template`, so with the body never parsed it rejected EVERY
    // call with "template, role and level are required" — a route that could
    // not succeed under any input. Found by reading, not by a failing test,
    // which is the uncomfortable part: nothing exercised it end to end.
    //
    // DELETE reads `body.note` on the task route, so it joins the list for the
    // same reason — a route's body only exists if the dispatcher parses it.
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
    }

    const params = Object.fromEntries(
      match.names.map((name, i) => [name, decodeURIComponent(url.pathname.match(match.regex)[i + 1])]),
    );

    try {
      const payload = await match.handler(params, body, url.searchParams, actor);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message, detail: err.detail ?? null }));
    }
  }

  return { handle, createServer: () => createServer(handle) };
}
