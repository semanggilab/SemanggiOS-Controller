// Admission pipeline — POC-4 §5.1.
//
// Nine ordered checks. Failing any of them parks the task in the WAIT_* state
// that names the actual blocker; nothing here may produce FAILED (P4-02). The
// order matters and matches the spec: cheap, task-local checks first, shared
// runtime capacity last, so a task never holds a lease while waiting on quota.
import { Status, ExecutionStatus } from "../domain/state-machine.mjs";
import { EventKind } from "../domain/events.mjs";
import { QUOTA_RETRY_LIMIT, isRetryableWindow } from "../domain/quota-windows.mjs";
import { quotaDriverFor } from "../domain/quota-drivers/index.mjs";
import { orderCandidates } from "./selection.mjs";
import { assertDispatchPathAllowed } from "./routing.mjs";
import { nullLogger } from "../domain/logger.mjs";

const wait = (status, detail, extra = {}) => ({ ok: false, status, detail, ...extra });

export const ADMISSIBLE_STATUSES = Object.freeze([
  Status.QUEUED,
  Status.WAIT_DEP,
  Status.WAIT_HUMAN,
  Status.WAIT_WORKSPACE,
  Status.WAIT_RESOURCE,
  Status.WAIT_QUOTA,
  Status.WAIT_CONCURRENCY,
  Status.WAIT_WORKER,
  Status.WAIT_RUNTIME,
]);

export function createAdmission({
  repos,
  events,
  policy,
  // D42: the brains table is the owner of the catalog after seeding (D35), so
  // admission must resolve brain names there. Without this, only routing.json
  // keys routed — and since brains.create slugs names ("glm-5.2-max" becomes
  // "glm-5-2-max"), even brains seeded FROM the catalog never matched it.
  brains = null,
  runtime,
  // D80: provisioning on-demand. Optional karena admission harus tetap bisa
  // dibangun tanpa gateway provisioning (harness test, runtime AgentOS
  // read-only) — tanpanya perilakunya identik pra-D80: parkir dan selesai.
  sandboxProvision = null,
  config = {},
  now = () => Date.now(),
  log = nullLogger,
}) {
  const maxRunning = config.maxRunning ?? 8;
  const leaseTtlMs = config.leaseTtlMs ?? 15 * 60 * 1000;
  // Backoff for a task that keeps parking. Without it, a task whose model has
  // no agent was retried every watchdog tick forever — observed on the cluster
  // at execution #582 for a single task, each attempt writing an immutable row
  // and churning a lease. Executions are immutable by design, so the fix is to
  // attempt less often, not to reuse rows.
  const retryBaseMs = config.retryBaseMs ?? 30_000;
  const retryMaxMs = config.retryMaxMs ?? 15 * 60 * 1000;
  const retryWindowMs = config.retryWindowMs ?? 60 * 60 * 1000;

  // One workspace per PROJECT, not per task (operator decision 2026-08-21).
  //
  // Spec induk §6.1 asked for executions/<task-id>, and that was implemented —
  // but it cannot work on this gateway. `cwd`/`workspaceDir` are rejected at
  // dispatch regardless of scope (D14), so a workspace only exists by being an
  // agent's configured workspace. Per-task paths therefore meant provisioning a
  // fresh agent for every task, and tasks parked in WAIT_RESOURCE until an
  // operator did so — which is how it actually behaved on the cluster.
  //
  // Exclusivity does not depend on separate directories: the workspace lease
  // (P4-07) already guarantees one RUNNING execution per path, and that test
  // still passes unchanged. Two coding tasks on one project now serialise
  // rather than running in parallel on separate paths — a real trade, made
  // deliberately, and the honest one while the gateway pins this version.
  //
  // A task may still override with its own workspace_path when it genuinely
  // needs isolation and someone has provisioned an agent for it.
  async function resolveWorkspacePath(task) {
    if (task.workspace_path) return task.workspace_path;
    const project = await repos.projects.get(task.project_id);
    return project?.workspace_path ?? null;
  }

  // --- step 1 ---------------------------------------------------------------
  async function checkDependencies(task) {
    const deps = await repos.tasks.dependencies(task.id);
    const unmet = deps.filter((d) => d.status !== Status.COMPLETE);
    if (unmet.length > 0) {
      return wait(Status.WAIT_DEP, `waiting on ${unmet.map((d) => d.id).join(", ")}`);
    }
    return { ok: true };
  }

  // --- step 2 ---------------------------------------------------------------
  async function checkApproval(task) {
    const pending = await repos.approvals.pendingForTask(task.id);
    if (pending.length > 0) {
      return wait(Status.WAIT_HUMAN, `approval ${pending[0].id} pending (${pending[0].level})`, {
        approvalId: pending[0].id,
      });
    }

    const decided = await repos.approvals.decidedForTask(task.id);
    const last = decided.at(-1);
    if (last?.decision === "REJECT" || last?.decision === "MODIFY") {
      // A rejection is a block, not a failure: the work is intact and a
      // revision can carry it forward (POC-4 §6).
      return { ok: false, status: Status.BLOCKED, detail: `approval ${last.id} returned ${last.decision}` };
    }

    // L3 always requires a human before the first dispatch (spec induk §10).
    if (task.approval_level === "L3" && decided.length === 0) {
      const approval = await repos.approvals.create({
        taskId: task.id,
        level: "L3",
        question: `Approve execution of ${task.id}: ${task.title}?`,
      });
      return wait(Status.WAIT_HUMAN, `approval ${approval.id} pending (L3)`, { approvalId: approval.id });
    }

    return { ok: true };
  }

  // --- step 3 ---------------------------------------------------------------
  // Peek only. The lease is taken at dispatch time so a task cannot sit on a
  // workspace while it waits for quota three steps later.
  //
  // Read/write aware: a reader is blocked only by a live writer, a writer by any
  // live holder. Before this, every task took an exclusive lease, so on a
  // shared project workspace a documentation task and a coding task took turns
  // for no defensible reason.
  async function checkWorkspace(task, workspacePath) {
    if (!workspacePath) return wait(Status.WAIT_WORKSPACE, "task has no resolvable workspace path");
    const mode = task.workspace_mode ?? "write";
    const live = (await repos.leases.holders(workspacePath)).filter((l) => l.expires_at > now());
    if (live.length === 0) return { ok: true };

    const blockers = [];
    for (const l of live) {
      const holder = await repos.executions.get(l.execution_id);
      if (holder && holder.task_id === task.id) continue; // our own
      if (mode === "write" || l.mode === "write") blockers.push(l);
    }
    if (blockers.length === 0) return { ok: true };
    const b = blockers[0];
    log.info("workspace.blocked", {
      task: task.id, workspace: workspacePath, want: mode,
      heldBy: b.execution_id, heldMode: b.mode, until: b.expires_at,
    });
    return wait(
      Status.WAIT_WORKSPACE,
      `${mode} lease blocked by ${b.mode} holder ${b.execution_id} until ${b.expires_at}`,
    );
  }

  // --- steps 4-6 ------------------------------------------------------------
  // D42: preferred names are Brain names first, catalog names second.
  //
  // Decompose writes the brain's own name into model_policy.preferred, and
  // brains.create slugs names — so a brain seeded from the catalog entry
  // "glm-5.2-max" is stored as "glm-5-2-max" and never matches a direct
  // catalog lookup. Resolving preferred names from the brains table is what
  // makes the Settings → Brain page the real owner of routing (D35); the
  // routing.json catalog remains the fallback for names that are not brains
  // (e.g. an explicit model typed in Slack).
  //
  // D68: preferred is an ORDERED failover list (brain_map cell). The walk
  // below already preserves order and takes the first survivor — that IS the
  // per-dispatch-attempt selection: no stored pointer, free fail-back. Each
  // candidate carries the index it held in the operator's list so dispatch
  // logs can say "won position 2 of 4", which is the honest story when the
  // first-choice brain was down.
  async function resolveModelCandidates(task) {
    const explicit = task.model_policy?.preferred;
    if (!brains || !Array.isArray(explicit) || explicit.length === 0) return policy.resolve(task);

    const candidates = [];
    const unmapped = [];
    for (const [index, name] of explicit.entries()) {
      const brain = await brains.get(name);
      if (brain?.enabled) {
        candidates.push({
          logical: brain.name,
          preferredIndex: index,
          provider: brain.provider,
          model: brain.model,
          ...(brain.thinking ? { thinking: brain.thinking } : {}),
          effortMode: brain.effortMode,
          ...(brain.mode ? { mode: brain.mode } : {}),
          ...(brain.acpAgent ? { acpAgent: brain.acpAgent } : {}),
        });
        continue;
      }
      // Not a live Brain (unknown or disabled): it may still be a raw catalog
      // name, and a disabled brain whose name matches the catalog falls back
      // to it rather than parking outright.
      const fromCatalog = policy.resolve({ ...task, model_policy: { ...task.model_policy, preferred: [name] } });
      if (fromCatalog.ok) candidates.push(...fromCatalog.candidates);
      else unmapped.push(name);
    }

    if (candidates.length === 0) {
      return { ok: false, reason: `explicit models unmapped: ${unmapped.join(", ")}` };
    }
    return { ok: true, candidates, unmapped };
  }

  async function checkModelAndQuota(task) {
    const resolved = await resolveModelCandidates(task);
    if (!resolved.ok) return wait(Status.WAIT_RESOURCE, resolved.reason);

    const enriched = [];
    for (const candidate of resolved.candidates) {
      const resource = await repos.resources.get(candidate.provider, candidate.model);
      enriched.push({ candidate, resource });
    }

    const known = enriched.filter((e) => e.resource);
    if (known.length === 0) {
      return wait(
        Status.WAIT_RESOURCE,
        `no resource entry for ${resolved.candidates.map((c) => `${c.provider}/${c.model}`).join(", ")}`,
      );
    }

    const usable = known.filter((e) => e.resource.availability !== "UNAVAILABLE");
    if (usable.length === 0) {
      return wait(Status.WAIT_RESOURCE, "all policy-approved models are unavailable");
    }

    // Step 5: quota. Note what is *not* happening here — no widening of the
    // candidate set. If every approved model is quota-exhausted the task waits
    // and reports an ETA (P4-03).
    const withQuota = usable.filter((e) => e.resource.availability === "AVAILABLE");
    if (withQuota.length === 0) {
      const nextAt = usable
        .map((e) => e.resource.next_available_at)
        .filter((v) => typeof v === "number")
        .sort((a, b) => a - b)[0] ?? null;
      return wait(Status.WAIT_QUOTA, "policy-approved models are quota-exhausted", { nextRetryAt: nextAt });
    }

    // Step 6: provider concurrency.
    const free = [];
    for (const entry of withQuota) {
      const active = await repos.resources.activeCount(entry.candidate.provider, entry.candidate.model);
      if (active < entry.resource.concurrency_limit) free.push(entry);
    }
    if (free.length === 0) {
      return wait(Status.WAIT_CONCURRENCY, "policy-approved models are at their concurrency limit");
    }

    // Preference order is preserved throughout, so the first survivor is the
    // operator's most-preferred available model.
    return { ok: true, candidate: assertDispatchPathAllowed(free[0].candidate) };
  }

  // --- step 7 ---------------------------------------------------------------
  async function checkWorker(task) {
    if (!task.worker_id) return wait(Status.WAIT_WORKER, "no worker assigned");
    const worker = await repos.workers.get(task.worker_id);
    if (!worker) return wait(Status.WAIT_WORKER, `worker ${task.worker_id} not found`);
    if (worker.status !== "ACTIVE") return wait(Status.WAIT_WORKER, `worker ${worker.id} is ${worker.status}`);
    if (worker.project_access.length > 0 && !worker.project_access.includes(task.project_id)) {
      return wait(Status.WAIT_WORKER, `worker ${worker.id} has no access to ${task.project_id}`);
    }
    const active = await repos.workers.activeCount(worker.id);
    if (active >= worker.max_concurrent) {
      return wait(Status.WAIT_WORKER, `worker ${worker.id} at capacity (${active}/${worker.max_concurrent})`);
    }
    return { ok: true, worker };
  }

  // --- step 8 ---------------------------------------------------------------
  async function checkRuntimeCapacity(runningNow) {
    if (runningNow >= maxRunning) {
      return wait(Status.WAIT_RUNTIME, `runtime at capacity (${runningNow}/${maxRunning})`);
    }
    return { ok: true };
  }

  /** Steps 1-8 for one task. Never dispatches, never mutates task status. */
  async function evaluate(task, { runningNow = 0 } = {}) {
    const workspacePath = await resolveWorkspacePath(task);

    const steps = [
      () => checkDependencies(task),
      () => checkApproval(task),
      () => checkWorkspace(task, workspacePath),
      () => checkModelAndQuota(task),
      () => checkWorker(task),
      () => checkRuntimeCapacity(runningNow),
    ];

    let candidate = null;
    let worker = null;
    for (const step of steps) {
      const result = await step();
      if (!result.ok) return result;
      candidate ??= result.candidate ?? null;
      worker ??= result.worker ?? null;
    }

    return { ok: true, plan: { candidate, worker, workspacePath } };
  }

  async function countRunning() {
    const rows = await repos.tasks.list({ status: Status.RUNNING, limit: 10_000 });
    const dispatched = await repos.tasks.list({ status: Status.DISPATCHED, limit: 10_000 });
    return rows.length + dispatched.length;
  }

  async function park(task, result) {
    await repos.tasks.setStatus(task.id, result.status, { waitDetail: result.detail });
    // A quota park carries a real reset time from the provider; anything else
    // gets exponential backoff derived from how often this task has failed
    // recently. Both end up in the same field, so the queue shows one ETA.
    let retryAt = result.nextRetryAt ?? null;
    if (!retryAt) {
      const failures = await repos.executions.recentFailures(task.id, now() - retryWindowMs);
      const backoff = Math.min(retryBaseMs * 2 ** Math.max(0, failures - 1), retryMaxMs);
      retryAt = now() + backoff;
    }
    await repos.tasks.setRetryAt(task.id, retryAt);
    await events.append({
      kind: result.status === Status.WAIT_QUOTA ? EventKind.QUOTA_DECISION : EventKind.DISPATCH_DECISION,
      subjectType: "task",
      subjectId: task.id,
      payload: { decision: "wait", status: result.status, detail: result.detail, nextRetryAt: result.nextRetryAt ?? null },
    });
  }

  /**
   * Step 9. Creates the execution, takes the lease, and hands off to AgentOS.
   * Idempotent: a task that already has a live execution is never dispatched
   * twice, which is what makes a controller restart safe (P4-11).
   */
  async function dispatch(task, plan) {
    const live = await repos.executions.latest(task.id);
    if (live && [ExecutionStatus.PENDING, ExecutionStatus.DISPATCHED, ExecutionStatus.RUNNING].includes(live.status)) {
      return { ok: false, status: Status.WAIT_RUNTIME, detail: `execution ${live.id} already in flight` };
    }

    const instruction = (await repos.tasks.consumePendingInstruction(task.id)) ?? task.description;
    const execution = await repos.executions.create({
      taskId: task.id,
      sessionMode: task.session_policy,
      instruction,
      modelProvider: plan.candidate.provider,
      modelId: plan.candidate.model,
      mode: plan.candidate.mode ?? "interactive",
    });

    const workspaceMode = task.workspace_mode ?? "write";
    const lease = await repos.leases.acquire({
      workspacePath: plan.workspacePath,
      executionId: execution.id,
      owner: plan.worker.id,
      ttlMs: leaseTtlMs,
      mode: workspaceMode,
    });
    if (!lease.ok) {
      await repos.executions.setStatus(execution.id, ExecutionStatus.CANCELLED, {
        result: "lost workspace lease race",
      });
      log.warn("lease.race-lost", {
        task: task.id, exec: execution.id, workspace: plan.workspacePath,
        want: workspaceMode, heldBy: lease.holder.execution_id, heldMode: lease.holder.mode,
      });
      return wait(
        Status.WAIT_WORKSPACE,
        `${workspaceMode} lease lost race to ${lease.holder.mode} holder ${lease.holder.execution_id}`,
      );
    }
    log.info("lease.acquired", {
      task: task.id, exec: execution.id, workspace: plan.workspacePath, mode: workspaceMode,
      expiresAt: lease.lease?.expires_at ?? null,
    });

    await repos.tasks.setWorkspacePath(task.id, plan.workspacePath);

    try {
      const handoff = await runtime.dispatch({
        task,
        execution,
        candidate: plan.candidate,
        worker: plan.worker,
        workspacePath: plan.workspacePath,
        instruction,
      });
      await repos.executions.update(execution.id, {
        runtime_ref: handoff.runtimeRef ?? null,
        // An inherited session wins over whatever the runtime reports: for
        // CONTINUE/FORK the harness session is the thing being resumed, and
        // overwriting it would silently turn a resume into a fresh run — the
        // exact false positive POC-3 E3 caught.
        session_ref: execution.session_ref ?? handoff.sessionRef ?? null,
        // The key actually sent to the gateway — session.message events carry
        // it, and for CONTINUE it differs from session_ref, so it is stored
        // in its own column (D48).
        session_key: handoff.sessionKey ?? null,
      });
      await repos.executions.setStatus(execution.id, ExecutionStatus.DISPATCHED);
      await repos.tasks.setStatus(task.id, Status.DISPATCHED, { waitDetail: null });
      await events.append({
        kind: EventKind.DISPATCH_SENT,
        subjectType: "task",
        subjectId: task.id,
        payload: {
          executionId: execution.id,
          runtimeRef: handoff.runtimeRef ?? null,
          model: `${plan.candidate.provider}/${plan.candidate.model}`,
          workspacePath: plan.workspacePath,
          sessionMode: task.session_policy,
        },
      });
      log.info("dispatch.sent", {
        task: task.id,
        exec: execution.id,
        runtimeRef: handoff.runtimeRef ?? null,
        provider: plan.candidate.provider,
        model: plan.candidate.model,
        effort: plan.candidate.thinking ?? null,
        // Logged separately from the level itself: a run recorded as "high"
        // that never carried the parameter would make the log agree with the
        // catalog and disagree with what the provider actually did.
        effortMode: plan.candidate.effortMode ?? "guaranteed",
        mode: plan.candidate.mode ?? "interactive",
        logical: plan.candidate.logical ?? null,
        // D68: posisi dalam daftar failover operator saat ini terpilih —
        // 0 berarti pilihan pertama; >0 berarti failover sedang bekerja.
        preferredIndex: plan.candidate.preferredIndex ?? null,
        acpAgent: plan.candidate.acpAgent ?? null,
        sessionMode: task.session_policy,
        workspace: plan.workspacePath,
        workspaceMode,
        worker: plan.worker.id,
      });
      return { ok: true, executionId: execution.id };
    } catch (err) {
      // A runtime that refuses the handoff is a capacity problem, not a task
      // failure: release everything and let the next tick retry.
      await repos.leases.release(plan.workspacePath, { executionId: execution.id });
      await repos.executions.setStatus(execution.id, ExecutionStatus.FAILED, { result: String(err.message ?? err) });
      await events.append({
        kind: EventKind.DISPATCH_FAILED,
        subjectType: "task",
        subjectId: task.id,
        payload: { executionId: execution.id, error: String(err.message ?? err) },
      });

      // A quota refusal is not a generic runtime problem: it names the model
      // and carries a reset time, so record it against the resource and park
      // the task where the queue can show a real ETA (POC-3 E8).
      // No agent is configured for the routed model. The controller must not
      // substitute a different model — that part of D14 never changes — but
      // since D80 it MAY grow an agent for the SAME model (see below), and if
      // it cannot or may not, this parks as a resource problem an operator can
      // act on, which is exactly P4-03's "availability decides dispatch or
      // wait, never which model".
      if (err.name === "AgentUnavailableError") {
        // D80: parkir tetap jawabannya, tapi sekarang parkir yang menumbuhkan
        // jalan keluarnya — bila semua pagar lolos (Brain aktif untuk model
        // ini, ada baris resource, armada model masih di bawah
        // concurrency_limit, bukan claude-code), satu sandbox dibuat SEKARANG
        // dan task dicoba lagi nyaris seketika. Ini pembalikan eksplisit
        // operator atas keputusan lama "controller tidak pernah membentuk
        // armadanya sendiri" (D32); kegagalan provisioning tidak pernah
        // mengubah hasil: task parkir WAIT_RESOURCE seperti sebelum D80.
        let provisioned = null;
        if (sandboxProvision) {
          provisioned = await sandboxProvision
            .maybeProvisionForBrain({ candidate: plan.candidate, reason: `task ${task.id}` })
            .catch((perr) => ({ created: false, why: "create-failed", error: String(perr.message ?? perr) }));
        }
        log.warn("resource.no-agent", {
          task: task.id, exec: execution.id,
          workspace: err.workspacePath, provider: err.provider, model: err.model,
          available: err.available?.map((a) => a.model) ?? [],
          provisioned: provisioned ? (provisioned.created ? provisioned.agent.name : provisioned.why) : "off",
        });
        return wait(
          Status.WAIT_RESOURCE,
          err.message,
          // Agen yang baru dibuat perlu beberapa detik sebelum bisa menerima
          // run; backoff 30 detik biasa akan menunda dispatch pertama yang
          // berhasil tanpa alasan — tapi HANYA jalur ini yang dipercepat.
          provisioned?.created ? { nextRetryAt: now() + 3_000 } : {},
        );
      }

      // POC-6 (D63): a driver-fatal refusal — groq's 413 structural input
      // wall, a 402 from a spent trial — is neither capacity nor a task bug.
      // It names an operator fix (paid tier, credits, or a prompt budget),
      // and parking it in WAIT_RUNTIME just replays the identical wall five
      // times with backoff in between. BLOCKED once, reason first.
      if (err.fatalQuota) {
        log.warn("quota.fatal", {
          task: task.id, exec: execution.id,
          provider: err.fatalQuota.provider, model: err.fatalQuota.model,
          reason: err.fatalQuota.reason ?? null,
          structural: Boolean(err.fatalQuota.structural),
        });
        return {
          ok: false,
          status: Status.BLOCKED,
          detail: `${err.fatalQuota.reason ?? "provider fatal"} (${err.fatalQuota.provider}/${err.fatalQuota.model}): ${err.fatalQuota.message ?? ""}`,
        };
      }

      if (err.quota) {
        await repos.resources.applyQuotaSignal(err.quota.provider, err.quota.model, err.quota);
        const resource = await repos.resources.get(err.quota.provider, err.quota.model);

        // D51: a short (per-minute) window makes redispatch cheap, but not
        // free forever — without a limit, a drained daily cap hiding behind
        // RPM errors becomes a task that retries every minute for days and
        // an event log full of nothing else. Ten failed attempts in a row
        // means the window is not the problem, and the task says so plainly.
        const brain = brains ? await brains.forModel(err.quota.provider, err.quota.model) : null;
        if (isRetryableWindow(brain?.quotaResetShortMs ?? null)) {
          const fresh = await repos.tasks.get(task.id);
          const retries = fresh?.quota_retries ?? 0;
          if (retries >= QUOTA_RETRY_LIMIT) {
            log.warn("quota.retry-exhausted", {
              task: task.id, exec: execution.id,
              provider: err.quota.provider, model: err.quota.model,
              attempts: retries,
            });
            return {
              ok: false,
              status: Status.BLOCKED,
              detail: `quota retries exhausted (${QUOTA_RETRY_LIMIT}x): ${err.quota.provider}/${err.quota.model}: ${err.quota.message}`,
            };
          }
          // The provider's reset time when it gave one, else the driver's
          // price for one short window — rolling from the hit, fixed-time at
          // its next wall-clock occurrence (POC-6 D63: a google RPD parked
          // "one minute" comes back into the same refusal; parked at midnight
          // Pacific it comes back into a fresh budget).
          const driver = quotaDriverFor(err.quota.provider);
          const eta =
            resource?.next_available_at && resource.next_available_at > now()
              ? resource.next_available_at
              : (driver.nextReset(
                  {
                    kind: brain?.quotaShortType ?? null,
                    ms: brain?.quotaResetShortMs ?? null,
                    fixedReset: brain?.quotaFixedReset ?? null,
                  },
                  { nowMs: now(), resetsAt: err.quota.resetsAt ?? null, lastSignalAt: now() },
                ) ?? now() + brain.quotaResetShortMs);
          if (!resource?.next_available_at) {
            // Anchor the resource to the same clock: a QUOTA_EXHAUSTED row
            // without next_available_at is never released by the scheduler's
            // window pass, which would wedge every OTHER task on this model
            // long after this one's retry succeeded.
            await repos.resources.applyQuotaSignal(err.quota.provider, err.quota.model, {
              status: 429,
              resetsAt: eta,
              rateLimitType: err.quota.rateLimitType ?? null,
              message: err.quota.message,
            });
          }
          await repos.tasks.bumpQuotaRetry(task.id, eta);
          log.warn("quota.parked", {
            task: task.id, exec: execution.id,
            provider: err.quota.provider, model: err.quota.model,
            windowKind: err.quota.rateLimitType ?? null,
            nextAvailableAt: resource?.next_available_at ?? null,
            quotaRetry: retries + 1,
            limit: QUOTA_RETRY_LIMIT,
          });
          return wait(Status.WAIT_QUOTA, `${err.quota.provider}/${err.quota.model}: ${err.quota.message}`, {
            nextRetryAt: eta,
          });
        }

        // Non-retryable window (long/daily): park until the resource says
        // it is back. Before D63 a signal without a clock parked with NO
        // nextRetryAt — the task waited on nothing, and only a lucky
        // resource flip could revive it. The driver prices the LONG window
        // as the fallback: fixed-time at the next wall-clock reset, rolling
        // from the hit, and a provider resetsAt always wins inside the
        // driver (D51) — so both clocks agree when both exist.
        const driver = quotaDriverFor(err.quota.provider);
        const longEta = driver.nextReset(
          {
            kind: brain?.quotaLongType ?? null,
            ms: brain?.quotaResetLongMs ?? null,
            fixedReset: brain?.quotaFixedReset ?? null,
          },
          { nowMs: now(), resetsAt: err.quota.resetsAt ?? null, lastSignalAt: now() },
        );
        log.warn("quota.parked", {
          task: task.id, exec: execution.id,
          provider: err.quota.provider, model: err.quota.model,
          windowKind: err.quota.rateLimitType ?? null,
          nextAvailableAt: resource?.next_available_at ?? null,
          nextRetryAt: longEta,
        });
        return wait(Status.WAIT_QUOTA, `${err.quota.provider}/${err.quota.model}: ${err.quota.message}`, {
          nextRetryAt: resource?.next_available_at ?? longEta,
        });
      }

      log.error("dispatch.failed", {
        task: task.id, exec: execution.id,
        provider: plan.candidate.provider, model: plan.candidate.model,
        error: String(err.message ?? err).slice(0, 300),
      });
      return wait(Status.WAIT_RUNTIME, `dispatch failed: ${err.message ?? err}`);
    }
  }

  /** One scheduling pass over every admissible task. */
  async function tick() {
    const projects = new Map((await repos.projects.list()).map((p) => [p.id, p]));
    const dispatchCounts = await repos.projects.dispatchCounts();

    const candidates = [];
    for (const status of ADMISSIBLE_STATUSES) {
      candidates.push(...(await repos.tasks.list({ status, limit: 10_000 })));
    }
    // Honour the backoff. Before this, `next_retry_at` was written and then
    // ignored, so the field looked like a plan while the scheduler retried on
    // every pass regardless.
    const ready = candidates.filter((t) => !t.next_retry_at || t.next_retry_at <= now());
    const ordered = orderCandidates(ready, { projects, dispatchCounts, now: now() });

    let runningNow = await countRunning();
    const outcome = { dispatched: [], parked: [] };

    for (const task of ordered) {
      const evaluation = await evaluate(task, { runningNow });
      if (!evaluation.ok) {
        await park(task, evaluation);
        outcome.parked.push({ taskId: task.id, status: evaluation.status, detail: evaluation.detail });
        continue;
      }
      // The state machine only allows DISPATCHED from QUEUED/WAIT_*, so a task
      // parked earlier in this same pass is re-queued before hand-off.
      if (task.status !== Status.QUEUED) {
        await repos.tasks.setStatus(task.id, Status.QUEUED, { waitDetail: null });
      }
      const sent = await dispatch({ ...task, status: Status.QUEUED }, evaluation.plan);
      if (!sent.ok) {
        await park(task, sent);
        outcome.parked.push({ taskId: task.id, status: sent.status, detail: sent.detail });
        continue;
      }
      runningNow += 1;
      outcome.dispatched.push({ taskId: task.id, executionId: sent.executionId });
    }

    return outcome;
  }

  return { evaluate, dispatch, tick, countRunning };
}
