// Task state machine — spec induk §5.1, refined by POC-4 §5.1.
//
// The parent spec names three waiting states; POC-4's admission pipeline has
// nine failure points and P4-02 requires each to be distinguishable. So the
// waiting states are the pipeline's, and the parent's coarser names remain as
// the family they belong to. The invariant both specs share is the one enforced
// here: a blocked admission is WAIT_*, never FAILED.

export const Status = Object.freeze({
  CREATED: "CREATED",
  QUEUED: "QUEUED",
  WAIT_DEP: "WAIT_DEP",
  WAIT_HUMAN: "WAIT_HUMAN",
  WAIT_WORKSPACE: "WAIT_WORKSPACE",
  WAIT_RESOURCE: "WAIT_RESOURCE",
  WAIT_QUOTA: "WAIT_QUOTA",
  WAIT_CONCURRENCY: "WAIT_CONCURRENCY",
  WAIT_WORKER: "WAIT_WORKER",
  WAIT_RUNTIME: "WAIT_RUNTIME",
  DISPATCHED: "DISPATCHED",
  RUNNING: "RUNNING",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  RESUMABLE: "RESUMABLE",
  CANCELLED: "CANCELLED",
});

export const WAITING_STATUSES = Object.freeze([
  Status.WAIT_DEP,
  Status.WAIT_HUMAN,
  Status.WAIT_WORKSPACE,
  Status.WAIT_RESOURCE,
  Status.WAIT_QUOTA,
  Status.WAIT_CONCURRENCY,
  Status.WAIT_WORKER,
  Status.WAIT_RUNTIME,
]);

export const TERMINAL_STATUSES = Object.freeze([Status.COMPLETE, Status.CANCELLED]);

export function isWaiting(status) {
  return WAITING_STATUSES.includes(status);
}

// Legacy vocabulary is rejected outright: spec induk §5.1 says pending/running/
// done "tidak boleh dipakai", and silently accepting them would let an old
// integration write states the scheduler cannot reason about.
const FORBIDDEN = new Set(["pending", "running", "done", "in_progress", "todo"]);

export function assertKnownStatus(status) {
  if (FORBIDDEN.has(String(status))) {
    throw new Error(`legacy status "${status}" is not allowed (spec induk §5.1)`);
  }
  if (!Object.values(Status).includes(status)) {
    throw new Error(`unknown task status "${status}"`);
  }
  return status;
}

const TRANSITIONS = new Map(
  Object.entries({
    CREATED: [Status.QUEUED, Status.CANCELLED],
    // Admission runs from QUEUED and either dispatches or parks the task.
    // BLOCKED is reachable without ever running: a rejected L3 approval stops
    // the task before dispatch, and that is a block, not a failure.
    QUEUED: [...WAITING_STATUSES, Status.DISPATCHED, Status.BLOCKED, Status.CANCELLED],
    // A parked task returns to the queue when its trigger fires, and may also
    // move sideways when re-evaluation finds a different blocker first.
    ...Object.fromEntries(
      WAITING_STATUSES.map((s) => [
        s,
        [
          Status.QUEUED,
          ...WAITING_STATUSES.filter((o) => o !== s),
          Status.DISPATCHED,
          Status.BLOCKED,
          Status.CANCELLED,
          // WAIT_HUMAN alone may go straight back to RUNNING: the permission
          // interposer parks a task whose execution is still alive mid-turn, so
          // an approval resumes the existing run rather than dispatching a new
          // one (POC-3 E3).
          ...(s === Status.WAIT_HUMAN ? [Status.RUNNING] : []),
        ],
      ]),
    ),
    // COMPLETE is reachable straight from DISPATCHED because reconciliation
    // observes outcomes, not every step: a short task can finish between two
    // polls and we never witness RUNNING. Inventing the missing transition
    // would be recording something that did not happen.
    // WAIT_QUOTA is reachable the same way for the same reason: a provider
    // refusal that arrives after accept is the same event admission handles
    // BEFORE accept, and parking is the honest recording of it. Only quota
    // gets this exit — a task that never started cannot wait on anything
    // else (D51).
    DISPATCHED: [
      Status.RUNNING,
      Status.COMPLETE,
      Status.WAIT_QUOTA,
      Status.BLOCKED,
      Status.FAILED,
      Status.CANCELLED,
    ],
    // RUNNING → WAIT_HUMAN is the permission pause: the interposer holds a tool
    // call mid-turn, so the run is alive but waiting on a person. It returns to
    // RUNNING on approval (POC-3 E3), which is why this is not a terminal exit.
    RUNNING: [Status.WAIT_HUMAN, Status.COMPLETE, Status.BLOCKED, Status.FAILED, Status.CANCELLED],
    BLOCKED: [Status.RESUMABLE, Status.FAILED, Status.CANCELLED],
    RESUMABLE: [Status.QUEUED, Status.CANCELLED],
    // Re-entry from a terminal-ish state is only legal through a revision, which
    // is why callers must pass reason="revision" (checked below).
    COMPLETE: [Status.QUEUED],
    FAILED: [Status.QUEUED, Status.CANCELLED],
    CANCELLED: [],
  }),
);

export function canTransition(from, to) {
  return (TRANSITIONS.get(from) ?? []).includes(to);
}

export function assertTransition(from, to, { reason } = {}) {
  assertKnownStatus(from);
  assertKnownStatus(to);
  if (!canTransition(from, to)) {
    throw new Error(`illegal task transition ${from} -> ${to}`);
  }
  if ((from === Status.COMPLETE || from === Status.FAILED) && to === Status.QUEUED && reason !== "revision") {
    throw new Error(`re-queueing a ${from} task requires a revision (spec induk §5.2)`);
  }
  return to;
}

// Execution status is deliberately a smaller vocabulary than task status: an
// execution is one attempt, so it never "waits" — waiting belongs to the task.
export const ExecutionStatus = Object.freeze({
  PENDING: "PENDING",
  DISPATCHED: "DISPATCHED",
  RUNNING: "RUNNING",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

export const EXECUTION_TERMINAL = Object.freeze([
  ExecutionStatus.COMPLETE,
  ExecutionStatus.FAILED,
  ExecutionStatus.CANCELLED,
]);

export function isExecutionTerminal(status) {
  return EXECUTION_TERMINAL.includes(status);
}
