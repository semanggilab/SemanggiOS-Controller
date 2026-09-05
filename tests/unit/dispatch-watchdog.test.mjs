// D20: a dispatch that goes quiet must not freeze the project.
//
// Observed on the cluster: the gateway restarted mid-flight, the lifecycle
// `end` event never arrived, and the execution sat DISPATCHED holding the
// workspace lease. With one workspace per project (2026-08-21 decision) every
// later task in that project parked on WAIT_WORKSPACE indefinitely.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask, Clock } from "../helpers/harness.mjs";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";

const HOUR = 60 * 60 * 1000;

test("a silent dispatch is reclaimed, and the lease released", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "goes quiet" });
  await h.scheduler.notify();

  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
  assert.ok(await h.repos.leases.get(path), "lease held while dispatched");

  clock.advance(HOUR);
  const reclaimed = await h.scheduler.reclaimStalledDispatches();

  assert.deepEqual(reclaimed, [execution.id]);
  // BLOCKED, not FAILED: nobody has evidence the work failed — the run may even
  // have finished while the event was lost.
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.BLOCKED);
  assert.equal(await h.repos.leases.get(path), null, "lease released so the project can move");
});

test("a dispatch still inside its window is left alone", async () => {
  // Reclaiming live work would be worse than reclaiming late: a long reasoning
  // turn is normal, and there is no way to un-cancel a run.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "still thinking" });
  await h.scheduler.notify();

  clock.advance(5 * 60 * 1000);
  assert.deepEqual(await h.scheduler.reclaimStalledDispatches(), []);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
});

test("reclaiming frees the project so the next task runs", async () => {
  // The actual symptom: with one workspace per project, a stalled task blocks
  // every sibling. This is the assertion that would have caught it.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const first = await queuedTask(h, { project, worker, title: "first" });
  await h.scheduler.notify();
  const second = await queuedTask(h, { project, worker, title: "second" });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(second.id)).status, Status.WAIT_WORKSPACE);

  clock.advance(HOUR);
  await h.scheduler.reclaimStalledDispatches();
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(first.id)).status, Status.BLOCKED);
  assert.equal((await h.repos.tasks.get(second.id)).status, Status.DISPATCHED, "the project moves again");
});

test("a late event still wins over the watchdog", async () => {
  // The two race by design. Whichever lands first is authoritative, and the
  // loser must not error or rewrite a finalized row.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "late event" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  const { createSessionEventSink } = await import("../../src/runtime/session-events.mjs");
  const sink = createSessionEventSink({
    repos: h.repos, events: h.events, scheduler: h.scheduler,
    runtime: { connect: async () => ({}), request: async () => ({ subscribed: true }) },
  });
  await sink.handle("agent", {
    runId: execution.id, stream: "lifecycle", sessionKey: "k",
    data: { phase: "end", stopReason: "stop" },
  });
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);

  clock.advance(HOUR);
  // Must not throw, and must not drag a completed task back to BLOCKED.
  assert.deepEqual(await h.scheduler.reclaimStalledDispatches(), []);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
});

test("the watchdog runs on every scheduler pass, not only on demand", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "auto" });
  await h.scheduler.notify();

  clock.advance(HOUR);
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
  const pass = h.scheduler.lastPasses?.().at(-1) ?? null;
  if (pass) assert.ok(Array.isArray(pass.stalledReclaimed));
});

test("a synchronous rejection releases the lease immediately", async () => {
  // This half of D20 turned out to be already correct — the first diagnosis
  // blamed rejection, but the real cause was a gateway restart losing an
  // in-flight run. The behaviour is load-bearing either way (without it one
  // refusal would freeze the project until the watchdog window elapsed), so it
  // gets a guard rather than being left to chance.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "refused" });

  h.fake.failNextDispatch?.(new Error("UNAVAILABLE: model override is not allowed"));
  const original = h.fake.dispatch.bind(h.fake);
  h.fake.dispatch = async () => {
    h.fake.dispatch = original;
    throw new Error("UNAVAILABLE: model override is not allowed");
  };

  await h.scheduler.notify();

  const t = await h.repos.tasks.get(task.id);
  assert.equal(t.status, Status.WAIT_RUNTIME);
  assert.equal(await h.repos.leases.get(t.workspace_path ?? `${project.workspace_path}`), null,
    "the lease must not survive a refused dispatch");
});

test("a lease left behind by a finished execution is released", async () => {
  // Seen on the cluster: an execution completed but its lease stayed, so the
  // path was protected by work that was already over. The stalled-execution
  // sweep above cannot see it, because that execution is final.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "orphan lease" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;

  // Finish the execution the way the runtime would, but leave the lease.
  await h.fake.startExecution(execution.id);
  await h.fake.completeExecution(execution.id);
  await h.repos.leases.acquire({
    workspacePath: path, executionId: execution.id, owner: worker.id, ttlMs: 60_000,
  });
  assert.ok(await h.repos.leases.get(path), "lease present before the sweep");

  const reclaimed = await h.scheduler.reclaimStalledDispatches();
  assert.ok(reclaimed.includes(`lease:${path}`));
  assert.equal(await h.repos.leases.get(path), null);
});

test("a BLOCKED execution does not keep holding the workspace", async () => {
  // Regression from the cluster: the first version of the orphan sweep keyed on
  // `finalized_at`, but BLOCKED is deliberately non-terminal (it stays
  // resumable) so that field is never stamped. The lease survived, and the
  // project stayed frozen. The lease guards RUNNING work; BLOCKED is not
  // running.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "blocked holder" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;

  await h.repos.executions.setStatus(execution.id, ExecutionStatus.BLOCKED, { result: "operator paused" });
  assert.equal((await h.repos.executions.get(execution.id)).finalized_at ?? null, null, "BLOCKED is not final");
  assert.ok(await h.repos.leases.get(path));

  await h.scheduler.reclaimStalledDispatches();
  assert.equal(await h.repos.leases.get(path), null);
});

// ── Lease heartbeat: found by adversarial review (C) ─────────────────────

test("a long-running execution keeps its lease", async () => {
  // The hole: `leases.heartbeat` existed but nothing called it. With a
  // 15-minute TTL and a 30-minute dispatch timeout, any run longer than 15
  // minutes lost its workspace while still running — and the next task would
  // reclaim it and write to the same tree. Concurrent-write corruption, and the
  // defaults made it the normal case.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock, config: { leaseTtlMs: 60_000 } });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "long run" });
  await h.scheduler.notify();
  const path = (await h.repos.tasks.get(task.id)).workspace_path;

  // Well past the TTL, but the run is still going.
  clock.advance(5 * 60 * 1000);
  await h.scheduler.heartbeatLiveLeases();

  const lease = await h.repos.leases.get(path);
  assert.ok(lease, "the lease must still exist");
  assert.ok(lease.expires_at > clock.now(), "and must not be expired");

  // A second task must still be kept out.
  const other = await queuedTask(h, { project, worker, title: "intruder" });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(other.id)).status, Status.WAIT_WORKSPACE);
});

test("a finished execution's lease is not kept alive by the heartbeat", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock, config: { leaseTtlMs: 60_000 } });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "done" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;

  await h.fake.startExecution(execution.id);
  await h.fake.completeExecution(execution.id);

  const renewed = await h.scheduler.heartbeatLiveLeases();
  assert.equal(renewed.includes(execution.id), false, "a dead execution must not hold a path open");
  void path;
});

test("an oversized instruction is refused rather than billed", async () => {
  // A 2MB description used to be accepted and sent to the provider verbatim.
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  await assert.rejects(
    () => h.repos.tasks.create({ projectId: project.id, title: "huge", description: "x".repeat(200_000) }),
    /over the .* byte limit/,
  );
});
