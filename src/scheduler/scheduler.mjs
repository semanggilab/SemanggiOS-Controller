// Event-driven re-evaluation — POC-4 §5.4.
//
// The scheduler does not poll the queue hoping something changed. It wakes on
// the events the spec lists: a new task, a finished task, an approval decision,
// a released lease, a quota reset, a resource availability change, plus a
// watchdog for anything that slipped through.
//
// Ticks are coalesced: many notifications arriving together produce one pass,
// and a pass is never re-entered concurrently. With replicas: 1 that is enough
// to guarantee a single dispatcher.
import { ExecutionStatus, Status } from "../domain/state-machine.mjs";
import { nullLogger } from "../domain/logger.mjs";

export const WakeReason = Object.freeze({
  TASK_CREATED: "task.created",
  TASK_FINISHED: "task.finished",
  APPROVAL_DECIDED: "approval.decided",
  LEASE_RELEASED: "lease.released",
  QUOTA_RESET: "quota.reset",
  RESOURCE_CHANGED: "resource.changed",
  WATCHDOG: "watchdog",
  MANUAL: "manual",
});

export function createScheduler({ admission, repos, config = {}, now = () => Date.now() }) {
  const watchdogMs = config.watchdogMs ?? 30_000;
  // How long a dispatched execution may stay silent before it is reclaimed
  // (D20). Deliberately generous: a long reasoning turn is normal, and
  // reclaiming live work would be worse than reclaiming late.
  const dispatchTimeoutMs = config.dispatchTimeoutMs ?? 30 * 60 * 1000;
  const leaseTtlMs = config.leaseTtlMs ?? 15 * 60 * 1000;
  const log = config.log ?? nullLogger;
  let running = false;
  let pendingReasons = new Set();
  let timer = null;
  const history = [];

  /**
   * Quota windows expire on a timestamp, not on an event somebody sends us
   * (POC-4 §5.4 names the GLM 5-hour window). Flipping the resource back to
   * AVAILABLE is therefore part of every pass.
   */
  async function releaseExpiredQuota() {
    const resources = await repos.resources.list();
    const released = [];
    for (const r of resources) {
      if (r.availability !== "QUOTA_EXHAUSTED") continue;
      if (r.next_available_at == null || r.next_available_at > now()) continue;
      await repos.resources.setAvailability(r.provider, r.model, "AVAILABLE", { source: "quota-window" });
      log.info("quota.window-reset", { provider: r.provider, model: r.model, windowKind: r.window_kind ?? null });
      released.push(`${r.provider}/${r.model}`);
    }
    return released;
  }

  /** Expired leases are reclaimed by the acquire path; this only surfaces them. */
  async function expiredLeases() {
    return (await repos.leases.list()).filter((l) => l.expires_at <= now());
  }

  /**
   * D20 — reclaim dispatches that went quiet.
   *
   * Since D15, terminal status arrives on the gateway's lifecycle `end` event.
   * A run that never really started never emits one: rejected after being
   * accepted, or lost when the gateway restarted mid-flight. Its execution then
   * sits DISPATCHED forever holding the workspace lease, and with one workspace
   * per project that freezes every later task in the project. Observed exactly
   * that on the cluster after a gateway restart.
   *
   * Lease expiry alone was not enough: reclamation only happened on the
   * *acquire* path, so it needed a sibling task to come along and try the same
   * workspace — and even then the stalled task stayed DISPATCHED. This makes it
   * active.
   *
   * BLOCKED, not FAILED: nobody has evidence the work failed. The run may even
   * have completed on the gateway while we lost the event. BLOCKED says "this
   * needs a human or a revision", which is true, and keeps it resumable.
   */
  /**
   * Renews leases held by work that is still running.
   *
   * Found by adversarial review, and it was a real hole: `leases.heartbeat`
   * existed but nothing ever called it. With a 15-minute TTL and a 30-minute
   * dispatch timeout, any run longer than 15 minutes — ordinary for a reasoning
   * model doing real work — would have its lease expire while still running.
   * The next task to want that path would then reclaim it, mark the LIVE
   * execution BLOCKED, and start writing to the same tree. That is precisely
   * the concurrent-write corruption P4-07 exists to prevent, and the defaults
   * made it the normal case rather than an edge one.
   *
   * A lease is renewed only while its owner is genuinely still DISPATCHED or
   * RUNNING, so this can never keep a dead execution's claim alive.
   */
  async function heartbeatLiveLeases() {
    const renewed = [];
    for (const lease of await repos.leases.list()) {
      const owner = await repos.executions.get(lease.execution_id);
      const live = owner && (owner.status === ExecutionStatus.DISPATCHED || owner.status === ExecutionStatus.RUNNING);
      if (!live) continue;
      await repos.leases.heartbeat(lease.workspace_path, {
        executionId: lease.execution_id,
        ttlMs: leaseTtlMs,
      });
      renewed.push(lease.execution_id);
    }
    return renewed;
  }

  async function reclaimStalledDispatches() {
    const stalled = await repos.executions.stalled(now() - dispatchTimeoutMs);
    const reclaimed = [];
    for (const execution of stalled) {
      const task = await repos.tasks.get(execution.task_id);
      const detail = `no runtime event for ${Math.round((now() - execution.created_at) / 1000)}s after dispatch`;
      try {
        await repos.executions.setStatus(execution.id, ExecutionStatus.BLOCKED, { result: detail });
        if (task) {
          await repos.tasks.setStatus(task.id, Status.BLOCKED, { reason: detail, actor: "dispatch-watchdog" });
          if (task.workspace_path) {
            const lease = await repos.leases.get(task.workspace_path);
            if (lease?.execution_id === execution.id) {
              await repos.leases.release(task.workspace_path, { executionId: execution.id, actor: "dispatch-watchdog" });
            }
          }
        }
        log.warn("dispatch.timeout", {
          task: task?.id ?? null, exec: execution.id,
          provider: execution.model_provider, model: execution.model_id,
          silentForMs: now() - execution.created_at,
          workspace: task?.workspace_path ?? null,
        });
        reclaimed.push(execution.id);
      } catch (err) {
        // A race with a late-arriving event is fine: the event wins and the row
        // is already final. Anything else is worth surfacing but must not stop
        // the pass — one bad row cannot be allowed to wedge the scheduler.
        if (!/immutable|final/i.test(String(err.message))) {
          process.stderr.write(`[watchdog] could not reclaim ${execution.id}: ${err.message}\n`);
        }
      }
    }
    // Second case, found the same day: a lease whose owning execution is no
    // longer running. The sweep above only looks at DISPATCHED/RUNNING rows, so
    // an orphan like this would sit there until some sibling task happened to
    // want the same path.
    //
    // The test is "not actively running", NOT "finalized". BLOCKED is
    // deliberately non-terminal — it stays resumable, so `finalized_at` is
    // never stamped — and the first version of this check keyed on
    // `finalized_at` and therefore walked straight past a BLOCKED execution
    // holding a lease on the cluster. The lease exists to stop two RUNNING
    // executions sharing a path (P4-07); anything not running has no claim on
    // it, and a revision will take a fresh lease anyway.
    for (const lease of await repos.leases.list()) {
      const owner = await repos.executions.get(lease.execution_id);
      const active = owner && (owner.status === ExecutionStatus.DISPATCHED || owner.status === ExecutionStatus.RUNNING);
      if (active) continue;
      await repos.leases.release(lease.workspace_path, { executionId: lease.execution_id, actor: "dispatch-watchdog" });
      log.info("lease.orphan-released", {
        exec: lease.execution_id, workspace: lease.workspace_path, mode: lease.mode,
        ownerStatus: owner?.status ?? "missing",
      });
      reclaimed.push(`lease:${lease.workspace_path}`);
    }

    return reclaimed;
  }

  async function pass(reasons) {
    const quotaReleased = await releaseExpiredQuota();
    // Renew before reclaiming: a live run must never lose its workspace to the
    // very pass that was supposed to protect it.
    const leasesRenewed = await heartbeatLiveLeases();
    const stalledReclaimed = await reclaimStalledDispatches();
    const outcome = await admission.tick();
    const record = {
      at: now(),
      reasons: [...reasons],
      quotaReleased,
      stalledReclaimed,
      leasesRenewed,
      dispatched: outcome.dispatched,
      parked: outcome.parked,
    };
    history.push(record);
    if (history.length > 100) history.shift();
    return record;
  }

  async function drain() {
    if (running) return null;
    running = true;
    try {
      let last = null;
      // Loop rather than return after one pass: a notification that arrives
      // while a pass is in flight must still be honoured.
      while (pendingReasons.size > 0) {
        const reasons = pendingReasons;
        pendingReasons = new Set();
        last = await pass(reasons);
      }
      return last;
    } finally {
      running = false;
    }
  }

  return {
    history,
    releaseExpiredQuota,
    reclaimStalledDispatches,
    heartbeatLiveLeases,
    expiredLeases,

    /** Record a wake reason and run a coalesced pass. */
    async notify(reason = WakeReason.MANUAL) {
      pendingReasons.add(reason);
      return drain();
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        void this.notify(WakeReason.WATCHDOG);
      }, watchdogMs);
      if (typeof timer.unref === "function") timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
