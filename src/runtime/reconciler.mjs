// Status reconciliation.
//
// POC-2 E3 and E7 both found dispatch records that stayed `running`, or
// reported `timeout` with `timeoutPhase: gateway_draining`, while the work had
// actually succeeded. So a single status read is not evidence, and a task must
// never be declared failed on the strength of one poll.
//
// The rules here follow from that:
//   - a terminal runtime status is believed immediately;
//   - a non-terminal one is only believed after it has been seen unchanged for
//     `staleAfterMs`, and even then it produces BLOCKED (recoverable), never
//     FAILED;
//   - artifacts on disk outrank the status field, because E3 showed the work
//     completing while the record said otherwise.
import { Status, ExecutionStatus } from "../domain/state-machine.mjs";
import { EventKind } from "../domain/events.mjs";

const TERMINAL_RUNTIME = {
  completed: ExecutionStatus.COMPLETE,
  cancelled: ExecutionStatus.CANCELLED,
  failed: ExecutionStatus.FAILED,
};

const TASK_FOR_EXECUTION = {
  [ExecutionStatus.COMPLETE]: Status.COMPLETE,
  [ExecutionStatus.FAILED]: Status.FAILED,
  [ExecutionStatus.CANCELLED]: Status.CANCELLED,
  [ExecutionStatus.RUNNING]: Status.RUNNING,
  [ExecutionStatus.BLOCKED]: Status.BLOCKED,
};

export function createReconciler({ repos, events, runtime, config = {}, now = () => Date.now() }) {
  const staleAfterMs = config.staleAfterMs ?? 10 * 60 * 1000;
  const lastSeen = new Map(); // executionId -> {status, at}

  /**
   * @param readStatus  (runtimeRef) => {status, result?} | null
   *   Injected so the source can be the SSE stream, a snapshot diff, or a test
   *   double, without the reconciliation rules caring which.
   */
  async function reconcileOnce({ readStatus } = {}) {
    const read = readStatus ?? (async () => null);
    const outcome = { settled: [], stale: [], unknown: [] };

    for (const status of [Status.DISPATCHED, Status.RUNNING, Status.WAIT_HUMAN]) {
      for (const task of await repos.tasks.list({ status, limit: 10_000 })) {
        const execution = await repos.executions.latest(task.id);
        if (!execution?.runtime_ref) continue;

        const report = await read(execution.runtime_ref);
        if (!report) {
          outcome.unknown.push(execution.id);
          continue;
        }

        const mapped = TERMINAL_RUNTIME[String(report.status).toLowerCase()];
        if (mapped) {
          await settle(task, execution, mapped, report.result ?? null, "runtime reported a terminal status");
          outcome.settled.push({ executionId: execution.id, status: mapped });
          lastSeen.delete(execution.id);
          continue;
        }

        // Non-terminal. Track how long it has looked like this.
        const seen = lastSeen.get(execution.id);
        if (!seen || seen.status !== report.status) {
          lastSeen.set(execution.id, { status: report.status, at: now() });
          continue;
        }
        if (now() - seen.at < staleAfterMs) continue;

        // Stale. POC-2 showed the record can lie in both directions, so the
        // task is blocked (recoverable via a revision) rather than failed.
        await settle(
          task,
          execution,
          ExecutionStatus.BLOCKED,
          `runtime status stuck at "${report.status}" for ${Math.round((now() - seen.at) / 1000)}s`,
          "stale runtime status",
        );
        outcome.stale.push({ executionId: execution.id, runtimeStatus: report.status });
        lastSeen.delete(execution.id);
      }
    }

    return outcome;
  }

  async function settle(task, execution, executionStatus, result, reason) {
    await repos.executions.setStatus(execution.id, executionStatus, { result });
    const taskStatus = TASK_FOR_EXECUTION[executionStatus];
    if (taskStatus && taskStatus !== task.status) {
      await repos.tasks.setStatus(task.id, taskStatus, { waitDetail: null, actor: "reconciler" });
    }
    if (task.workspace_path) {
      const lease = await repos.leases.get(task.workspace_path);
      if (lease?.execution_id === execution.id)
        await repos.leases.release(task.workspace_path, { executionId: execution.id, actor: "reconciler" });
    }
    await events.append({
      kind: EventKind.EXECUTION_STATUS,
      subjectType: "execution",
      subjectId: execution.id,
      actor: "reconciler",
      payload: { to: executionStatus, reason, result },
    });
  }

  /**
   * Snapshot-driven trigger. /api/snapshot carries a `revision` that changes
   * when anything moves, so it tells us when to look rather than us polling
   * every task on a timer.
   */
  let lastRevision = null;
  async function revisionChanged() {
    if (!runtime?.snapshot) return false;
    const snap = await runtime.snapshot().catch(() => null);
    if (!snap) return false;
    const revision = snap.revision ?? null;
    const changed = revision !== lastRevision;
    lastRevision = revision;
    return changed;
  }

  return { reconcileOnce, revisionChanged };
}
