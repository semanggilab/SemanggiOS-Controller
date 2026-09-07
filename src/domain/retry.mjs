// Runtime-failure auto-recovery (D75).
//
// The operator's framing, which this module implements: a run that died at the
// gateway — internal error, crash, external kill, or a death whose end frame
// never reached us — is a TRANSIENT condition the controller can recover from
// itself. Parking it BLOCKED asks a human to press "continue" for what is
// mechanical work: requeue, back off, and let the next dispatch pick a live
// Brain from the failover chain (D68 reallocation, exactly as requested).
//
// The verdict is shared by every place a dead run is discovered so the three
// surfaces cannot disagree about what a dead run means:
//
//   - the dispatch watchdog (silence + describe/abort confirmation)
//   - the session-event sink (a live `end` frame with a bad stopReason)
//   - the reconciler (describe says failed/killed/timeout while the task
//     still claims DISPATCHED/RUNNING — the fast path, no 30-minute wait)
//
// What stays OUT of auto-retry, deliberately:
//   - clean completions (COMPLETE) and operator aborts (CANCELLED) — verdicts,
//     not failures;
//   - definitive provider refusals (401/402/413-structural) — deterministic,
//     a retry hits the same wall (D51/D52 own those);
//   - tasks already BLOCKED — condemned rows are a human's decision (D72).
//
// The budget: `runtimeRetryLimit` requeues per task inside the failure window,
// counted from FAILED executions (recentFailures — the same windowed counter
// admission's backoff reads, so the two schedules agree). When the budget is
// exhausted the task parks BLOCKED with the streak named: a run that keeps
// dying is telling us something a loop would only drown out.
import { Status, ExecutionStatus } from "./state-machine.mjs";
import { EventKind } from "./events.mjs";

/**
 * Applies the shared verdict for an abnormally-dead run.
 *
 * Marks the execution FAILED with the cause (the truth about THAT attempt),
 * then either requeues the task (budget remains) or parks it BLOCKED (budget
 * exhausted). Frees the workspace lease when this execution holds it — the
 * next attempt takes it again through admission.
 *
 * @returns {"requeued"|"blocked"|"noop"} what happened to the task.
 */
export async function applyRuntimeFailure(
  { repos, events, config = {}, log = null, now = () => Date.now() },
  { task, execution, cause, source },
) {
  const limit = config.runtimeRetryLimit ?? 2;
  // The window must span the WHOLE streak, and a streak's clock is dominated
  // by the dispatch silence timeout: three deaths at 30 minutes of silence
  // each already exceed 90 minutes, so a 1-hour window would forget the first
  // failure before the third happens and the budget would never trigger
  // (caught by the budget regression test, not by review).
  const retryWindowMs = config.runtimeRetryWindowMs ?? 6 * 60 * 60 * 1000;
  const retryBaseMs = config.runtimeRetryBaseMs ?? 30_000;
  const retryMaxMs = config.runtimeRetryMaxMs ?? 15 * 60 * 1000;

  // The execution verdict first — the failure count below reads it.
  if (!isExecutionFinal(execution)) {
    await repos.executions.setStatus(execution.id, ExecutionStatus.FAILED, { result: cause });
  }

  const freshTask = await repos.tasks.get(task.id);
  if (!freshTask) return "noop";
  // Only a live pipeline can auto-retry: QUEUED/DISPATCHED/RUNNING. A task a
  // human or a verdict already moved (CANCELLED, BLOCKED, COMPLETE…) keeps its
  // state — auto-recovery must never overrule a decision.
  if (![Status.DISPATCHED, Status.RUNNING].includes(freshTask.status)) {
    log?.warn?.("runtime-failure.task-unmoved", {
      task: freshTask.id, exec: execution.id, status: freshTask.status, cause,
    });
    return "noop";
  }

  const failures = await repos.executions.recentFailures(freshTask.id, now() - retryWindowMs);
  const withinBudget = failures <= limit;

  if (withinBudget) {
    // Same schedule admission uses (D51): 30s, 60s, 120s… capped at 15 min.
    // `actor: "controller"` keeps the backoff the queue already wrote — an
    // automatic retry is exactly the case backoff exists for.
    const backoff = Math.min(retryBaseMs * 2 ** Math.max(0, failures - 1), retryMaxMs);
    await repos.tasks.setStatus(freshTask.id, Status.QUEUED, {
      reason: "auto-retry",
      waitDetail: `${cause} — attempt ${failures}/${limit + 1}, retrying in ${Math.round(backoff / 1000)}s`,
      actor: "controller",
    });
    await repos.tasks.setRetryAt(freshTask.id, now() + backoff);
  } else {
    await repos.tasks.setStatus(freshTask.id, Status.BLOCKED, {
      reason: `${cause} — ${failures - 1} auto-retries exhausted, needs a human`,
      // wait_reason is the column the queue reads; `reason` alone lands only
      // in the event log, and a BLOCKED row with an empty reason is a row the
      // operator has to investigate to understand.
      waitDetail: `${cause} — ${failures - 1} auto-retries exhausted, needs a human`,
      actor: "controller",
    });
  }

  if (freshTask.workspace_path) {
    const lease = await repos.leases.get(freshTask.workspace_path);
    if (lease?.execution_id === execution.id) {
      await repos.leases.release(freshTask.workspace_path, { executionId: execution.id, actor: source });
    }
  }

  await events.append({
    kind: EventKind.EXECUTION_STATUS,
    subjectType: "execution",
    subjectId: execution.id,
    payload: { source, verdict: "runtime-failure", cause, failures, requeued: withinBudget },
  });
  log?.info?.("runtime-failure.applied", {
    task: freshTask.id, exec: execution.id, cause, failures, requeued: withinBudget,
  });
  return withinBudget ? "requeued" : "blocked";
}

function isExecutionFinal(execution) {
  return Boolean(execution?.finalized_at);
}
