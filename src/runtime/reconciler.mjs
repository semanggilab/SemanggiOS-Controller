// Status reconciliation — rewritten around the gateway's own session
// projection (D72).
//
// History, because the shape of this file is a lesson: the first reconciler
// read a status through an injected `readStatus` that production never wired
// (main.mjs called reconcileOnce() with no argument — every lookup "unknown",
// nothing ever settled), and even a wired reader had nothing to read:
// /api/snapshot carries AgentOS dispatch records only, and runs dispatched
// straight to the Gateway never appear in it (D15). Meanwhile the fast path
// (sessions.subscribe lifecycle `end`) loses events in every reconnect gap —
// the controller re-subscribes once a minute — and that is how executions
// finished cleanly at the gateway while their tasks sat BLOCKED forever
// (TASK-E2854DB9: gateway logged `ended with stopReason=stop`; the controller
// never saw a byte of it).
//
// `sessions.describe {key}` (measured live on 2026.7.1, protocol 4) returns
// the gateway's durable run classification — running | done | timeout |
// killed | failed — and is the one after-the-fact source that exists. The
// rules now follow from what it can and cannot prove:
//
//   - `done` is positive success evidence: settle COMPLETE (the D57 edge —
//     a late outcome outranks the watchdog's guess — delivered by describe).
//   - `running` is activity proof: refresh the execution's activity clock so
//     the watchdog cannot false-park a live run our subscription lost sight
//     of, and — for a task already parked BLOCKED — abort the straggler so
//     the invariant "BLOCKED ⇒ not running at the gateway" holds. That
//     invariant is what makes freeing the concurrency slot, the worker slot
//     and the workspace lease at park time truthful instead of optimistic.
//   - killed/failed/timeout are evidence, not verdicts: the reconciler
//     rescues, humans condemn. Those rows stay BLOCKED/resumable and the
//     operator reads the recorded evidence.
import { Status, ExecutionStatus } from "../domain/state-machine.mjs";
import { EventKind } from "../domain/events.mjs";
import { applyRuntimeFailure } from "../domain/retry.mjs";

// Exported because the settle API endpoint answers the same question the
// reconciler does — "this execution is final, so where does the task stand?"
// — and the two must not drift apart on the mapping.
export const TASK_FOR_EXECUTION = {
  [ExecutionStatus.COMPLETE]: Status.COMPLETE,
  [ExecutionStatus.FAILED]: Status.FAILED,
  [ExecutionStatus.CANCELLED]: Status.CANCELLED,
  [ExecutionStatus.RUNNING]: Status.RUNNING,
  [ExecutionStatus.BLOCKED]: Status.BLOCKED,
};

export function createReconciler({
  repos,
  events,
  // The gateway runtime: { describeSession({key}) -> session|null }. Null
  // runtime means no reconciliation source — the pass reports everything as
  // unknown and settles nothing (same honest shape as before, now by design).
  runtime = null,
  // The session-event sink's applyDescribe(execution, session) — the single
  // owner of the describe→COMPLETE mapping, shared with nothing.
  applyDescribe = null,
  // D75: the shared runtime-failure verdict — describe saying failed/killed/
  // timeout under a still-DISPATCHED task recovers it NOW instead of waiting
  // for the watchdog's 30-minute silence (the fast path TASK-4CA0D674 never
  // had: it sat DISPATCHED dead for 30 minutes before anyone looked).
  applyFailure = null,
  config = {},
  now = () => Date.now(),
  log = { info() {}, warn() {}, error() {} },
}) {
  // BLOCKED tasks are scanned only inside this window from the execution's
  // last observed activity: the abort-before-park watchdog (D71) already
  // guarantees new BLOCKED rows are confirmed stopped, so this sweep exists
  // for stragglers — rows parked by the old code while their runs kept
  // going. Measured on the cluster DB the base filter (latest execution
  // unfinalized AND carrying a session key) already narrows this to a
  // handful of rows, so a day-wide window is a handful of describes — while
  // still bounding the sweep as old BLOCKED rows accumulate over months.
  const blockedScanWindowMs = config.blockedScanWindowMs ?? 24 * 60 * 60 * 1000;

  async function describe(key) {
    if (!runtime || typeof runtime.describeSession !== "function") return null;
    try {
      return await runtime.describeSession({ key });
    } catch {
      return null;
    }
  }

  async function abortStraggler(execution, task, session) {
    if (typeof runtime.abortRun !== "function") return false;
    const abort = await runtime.abortRun({ sessionKey: execution.session_key }).catch(() => null);
    const stopped = Boolean(abort?.ok && (abort.aborted || abort.status === "no-active-run"));
    await events.append({
      kind: EventKind.EXECUTION_STATUS,
      subjectType: "execution",
      subjectId: execution.id,
      actor: "reconciler",
      payload: {
        source: "sessions.describe",
        observed: "running-under-blocked",
        stopConfirmed: stopped,
        abort: abort ? { aborted: abort.aborted, status: abort.status ?? null } : null,
        sessionStatus: session?.status ?? null,
      },
    });
    log.warn("reconciler.blocked-still-running", {
      task: task.id, exec: execution.id, session: execution.session_key,
      stopped, abortStatus: abort?.status ?? null,
    });
    return stopped;
  }

  /**
   * One reconciliation pass. Self-gating: only tasks whose latest execution
   * is unfinalized AND carries a session key are examined, so the pass costs
   * one describe per piece of possibly-live work — not per task in the DB.
   */
  async function reconcileOnce() {
    const outcome = { settled: [], alive: [], stragglers: [], recovered: [], unknown: [] };
    const describeSession = typeof applyDescribe === "function" ? applyDescribe : null;

    for (const status of [Status.DISPATCHED, Status.RUNNING, Status.WAIT_HUMAN, Status.BLOCKED]) {
      for (const task of await repos.tasks.list({ status, limit: 10_000 })) {
        const execution = await repos.executions.latest(task.id);
        if (!execution?.session_key) continue;
        if (execution.finalized_at) continue;
        if (status === Status.BLOCKED) {
          const lastActive = execution.last_event_at ?? execution.created_at;
          if (now() - lastActive > blockedScanWindowMs) continue;
        }

        const session = await describe(execution.session_key);
        if (!session) {
          outcome.unknown.push(execution.id);
          continue;
        }

        if (session.status === "running") {
          // Activity proof. Refresh the clock the watchdog reads, so a live
          // run our subscription lost sight of cannot be false-parked at the
          // 30-minute mark (D71's other half).
          await repos.executions.touch(execution.id, now());
          outcome.alive.push(execution.id);
          if (status === Status.BLOCKED) {
            // Parked by the old watchdog while the run kept going: enforce
            // the invariant the accounting depends on.
            await abortStraggler(execution, task, session);
            outcome.stragglers.push(execution.id);
          }
          continue;
        }

        if (session.status === "done" && describeSession) {
          const result = await describeSession(execution, session);
          if (result?.handled) {
            outcome.settled.push({ executionId: execution.id, status: Status.COMPLETE });
            continue;
          }
        }

        // D75: gateway terminal evidence under a task still claiming to be
        // live is a dead run discovered EARLY — apply the shared retry verdict
        // now (requeue with backoff, budget-bounded) rather than letting the
        // task sit DISPATCHED-dead for the watchdog's 30-minute silence.
        // BLOCKED tasks are deliberately untouched: condemned rows are a
        // human's decision (D72), and BLOCKED → QUEUED has no legal edge.
        if (
          ["failed", "killed", "timeout"].includes(session.status) &&
          typeof applyFailure === "function" &&
          [Status.DISPATCHED, Status.RUNNING].includes(status)
        ) {
          const result = await applyFailure(execution, task, session);
          outcome.recovered.push({
            executionId: execution.id,
            sessionStatus: session.status,
            recovery: result ?? "noop",
          });
          continue;
        }
        // Other terminal statuses under BLOCKED: evidence for the operator —
        // the reconciler rescues, humans condemn.
      }
    }

    return outcome;
  }

  return { reconcileOnce };
}
