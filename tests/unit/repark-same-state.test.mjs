// Re-parking a task that is already waiting.
//
// Found on the cluster, not in review: the controller was in a crash loop,
// restarting once per scheduler tick with
//
//   Error: illegal task transition WAIT_WORKSPACE -> WAIT_WORKSPACE
//     at assertTransition (state-machine.mjs)
//     at park (admission.mjs) → tick → pass → drain
//
// TASK-05C65CF2 was waiting on a workspace lease held by TASK-2C56D3A8#1.
// Admission re-evaluates a waiting task every pass and re-parks it with a fresh
// detail string — and the WAIT_WORKSPACE detail embeds the blocking lease's
// `expires_at`, which moves each time the holder renews. setStatus only
// short-circuits when the detail is byte-identical, so the refreshed ETA fell
// through to an assertion that only ever meant to guard real movement between
// states. The pass threw, the process died, Swarm restarted it, and the next
// tick did it again.
//
// The invariant these tests pin: a task MAY be told it is still waiting, and
// MAY be told a newer reason for it, without that counting as a transition.
// Illegal movement between DIFFERENT states MUST still throw.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

test("re-parking with a REFRESHED detail does not throw and records the new reason", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "waiter" });

  await h.repos.tasks.setStatus(task.id, Status.WAIT_WORKSPACE, {
    waitDetail: "write lease blocked by write holder EXEC-1 until 1000",
  });

  // The exact shape admission produces one tick later: same state, same holder,
  // later expiry. This is the line that used to kill the process.
  await h.repos.tasks.setStatus(task.id, Status.WAIT_WORKSPACE, {
    waitDetail: "write lease blocked by write holder EXEC-1 until 2000",
  });

  const after = await h.repos.tasks.get(task.id);
  assert.equal(after.status, Status.WAIT_WORKSPACE);
  assert.equal(
    after.wait_reason,
    "write lease blocked by write holder EXEC-1 until 2000",
    "the newer ETA must reach the operator, not be discarded",
  );
});

test("an IDENTICAL re-park stays a no-op — no second event in the log", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "waiter" });

  const detail = "write lease blocked by write holder EXEC-1 until 1000";
  await h.repos.tasks.setStatus(task.id, Status.WAIT_WORKSPACE, { waitDetail: detail });
  const before = (await h.events.list({ subjectType: "task", subjectId: task.id })).length;
  await h.repos.tasks.setStatus(task.id, Status.WAIT_WORKSPACE, { waitDetail: detail });
  const after = (await h.events.list({ subjectType: "task", subjectId: task.id })).length;

  assert.equal(after, before, "nothing changed, so the event log must stay quiet");
});

test("every waiting state may be re-parked on itself", async () => {
  // The bug surfaced as WAIT_WORKSPACE because that is the one with a moving
  // number in its detail, but the fix is about same-state writes in general —
  // so all four are pinned rather than the one that happened to bite.
  for (const status of [
    Status.WAIT_WORKSPACE,
    Status.WAIT_QUOTA,
    Status.WAIT_RESOURCE,
    Status.WAIT_HUMAN,
  ]) {
    const h = await buildHarness();
    const { project, worker } = await seedBasics(h);
    const task = await queuedTask(h, { project, worker, title: `waiter ${status}` });

    await h.repos.tasks.setStatus(task.id, status, { waitDetail: "first" });
    await h.repos.tasks.setStatus(task.id, status, { waitDetail: "second" });

    const after = await h.repos.tasks.get(task.id);
    assert.equal(after.status, status);
    assert.equal(after.wait_reason, "second", `${status} must accept a refreshed reason`);
  }
});

test("illegal movement between DIFFERENT states still throws", async () => {
  // The fix narrows when the assertion runs; it MUST NOT narrow what the
  // assertion rejects. CANCELLED is the dead end (§4.1 rule 8).
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "doomed" });

  await h.repos.tasks.setStatus(task.id, Status.CANCELLED, { actor: "operator" });
  await assert.rejects(
    () => h.repos.tasks.setStatus(task.id, Status.QUEUED, { actor: "operator" }),
    /illegal task transition CANCELLED -> QUEUED/,
  );
});

test("re-queueing a COMPLETE task still demands a revision", async () => {
  // The other guard inside assertTransition sits behind the same call site, so
  // it is worth proving it did not get skipped along with the self-transition.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "done" });

  await h.repos.tasks.setStatus(task.id, Status.DISPATCHED);
  await h.repos.tasks.setStatus(task.id, Status.COMPLETE);
  await assert.rejects(
    () => h.repos.tasks.setStatus(task.id, Status.QUEUED, { actor: "operator" }),
    /requires a revision/,
  );
});
