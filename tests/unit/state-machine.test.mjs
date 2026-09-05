// P4-01: state machine + revision semantics.
import test from "node:test";
import assert from "node:assert/strict";
import { Status, assertTransition, canTransition, assertKnownStatus } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

test("legacy status vocabulary is rejected outright", () => {
  for (const legacy of ["pending", "running", "done"]) {
    assert.throws(() => assertKnownStatus(legacy), /legacy status/);
  }
  // The uppercase spec vocabulary is what survives.
  assert.equal(assertKnownStatus(Status.RUNNING), Status.RUNNING);
});

test("admission failures move sideways between WAIT_* states, never to FAILED", () => {
  assert.ok(canTransition(Status.WAIT_QUOTA, Status.WAIT_WORKSPACE));
  assert.ok(canTransition(Status.WAIT_QUOTA, Status.QUEUED));
  assert.ok(canTransition(Status.WAIT_QUOTA, Status.DISPATCHED));
  assert.equal(canTransition(Status.WAIT_QUOTA, Status.FAILED), false);
  assert.equal(canTransition(Status.QUEUED, Status.FAILED), false);
});

test("BLOCKED recovers only through RESUMABLE", () => {
  assert.ok(canTransition(Status.BLOCKED, Status.RESUMABLE));
  assert.ok(canTransition(Status.RESUMABLE, Status.QUEUED));
  assert.equal(canTransition(Status.BLOCKED, Status.QUEUED), false);
});

test("CANCELLED is terminal", () => {
  for (const status of Object.values(Status)) {
    assert.equal(canTransition(Status.CANCELLED, status), false);
  }
});

test("a COMPLETE task can only be re-queued as a revision", () => {
  assert.throws(() => assertTransition(Status.COMPLETE, Status.QUEUED), /requires a revision/);
  assert.equal(assertTransition(Status.COMPLETE, Status.QUEUED, { reason: "revision" }), Status.QUEUED);
});

test("revision re-queues the task and freezes the previous execution (P4-01, P4-10)", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "doc" });
  await h.repos.tasks.setStatus(task.id, Status.QUEUED);

  await h.scheduler.notify();
  const first = await h.repos.executions.latest(task.id);
  await h.fake.startExecution(first.id);
  await h.fake.completeExecution(first.id, { result: "v1" });

  await h.repos.tasks.createRevision(task.id, { sessionMode: "CONTINUE", instruction: "tweak it" });
  const requeued = await h.repos.tasks.get(task.id);
  assert.equal(requeued.status, Status.QUEUED);
  assert.equal(requeued.session_policy, "CONTINUE");

  await h.scheduler.notify();
  const executions = await h.repos.executions.listByTask(task.id);
  assert.equal(executions.length, 2, "revision creates a new execution rather than mutating the old one");
  assert.equal(executions[0].result, "v1", "history is untouched");
  assert.equal(executions[1].revision_no, 2);
  assert.equal(executions[1].session_mode, "CONTINUE");
  assert.equal(executions[1].instruction, "tweak it");
});

test("all three session modes are carried to the runtime (P4-10 control-plane half)", async () => {
  for (const mode of ["CONTINUE", "FORK", "FRESH"]) {
    const h = await buildHarness();
    const { project, worker } = await seedBasics(h);
    const task = await h.repos.tasks.create({
      projectId: project.id,
      workerId: worker.id,
      title: `m-${mode}`,
      sessionPolicy: mode,
    });
    await h.repos.tasks.setStatus(task.id, Status.QUEUED);
    await h.scheduler.notify();
    assert.equal(h.fake.dispatches.at(-1).task.session_policy, mode);
    assert.equal((await h.repos.executions.latest(task.id)).session_mode, mode);
  }
});

test("an invalid session mode is refused", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "x" });
  await assert.rejects(
    () => h.repos.tasks.createRevision(task.id, { sessionMode: "RESTART", instruction: "" }),
    /invalid session mode/,
  );
});
