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

test("a silent dispatch is reclaimed, the lease released, and the task auto-retried", async () => {
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
  // D75: a confirmed-dead run is a transient failure, not a verdict on the
  // work — the execution records the attempt's truth (FAILED, cause named),
  // and the task goes back to QUEUED for the next dispatch (a fresh session,
  // possibly another Brain from the failover chain). BLOCKED is reserved for
  // a task that has exhausted its retry budget (see below).
  const after = await h.repos.tasks.get(task.id);
  assert.equal(after.status, Status.QUEUED);
  assert.match(after.wait_reason ?? "", /retrying in/, "the wait line names the backoff");
  assert.ok(after.next_retry_at > clock.now(), "the retry is scheduled, not immediate");
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.FAILED);
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

  // First is QUEUED behind its 30s retry backoff — which is exactly what lets
  // the second task take the freed workspace instead of the retried first.
  assert.equal((await h.repos.tasks.get(first.id)).status, Status.QUEUED);
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

  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED, "dead run auto-retried (D75)");
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

// ── D71: the watchdog keys on observed activity, not dispatch age ───────────
//
// The cluster incident this section regresses: TASK-E2854DB9 (64 min, 103
// messages AFTER the park) and TASK-2C56D3A8 (2j48m, 440 after) were both
// parked at exactly the 30-minute mark while still streaming — the old
// `stalled()` keyed on created_at, which says nothing about a run's life.

test("a streaming run is never stalled, however old (TASK-E2854DB9 shape)", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "streams forever" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const key = execution.session_key;

  const { createSessionEventSink } = await import("../../src/runtime/session-events.mjs");
  const sink = createSessionEventSink({
    repos: h.repos, events: h.events, scheduler: h.scheduler,
    runtime: { connect: async () => ({}), request: async () => ({}) },
  });

  // 40 minutes of life, a message every ten: past the old 30-minute wall the
  // whole time, alive the whole time.
  for (let i = 0; i < 4; i++) {
    clock.advance(10 * 60 * 1000);
    await sink.handle("session.message", {
      sessionKey: key, messageSeq: i + 1,
      message: { role: "assistant", content: "work", timestamp: clock.now() },
    });
  }
  assert.equal((await h.repos.executions.stalled(clock.now() - 30 * 60 * 1000)).length, 0,
    "a run that streamed four times in forty minutes is not stalled");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);

  // Now it really goes quiet — and the fake gateway (which never learned of a
  // live run) confirms via abort that nothing is running, so it recovers as an
  // auto-retry (D75): attempt FAILED, task back to QUEUED behind backoff.
  clock.advance(31 * 60 * 1000);
  const reclaimed = await h.scheduler.reclaimStalledDispatches();
  assert.deepEqual(reclaimed, [execution.id]);
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.FAILED);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);
});

test("a run the GATEWAY says is live is not parked — our silence is not its death", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "subscription gap" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  h.fake.gateway.markRunning(execution.session_key);

  // Hours of controller-side silence — the exact TASK-2C56D3A8 shape (2j48m).
  clock.advance(3 * 60 * 60 * 1000);
  const reclaimed = await h.scheduler.reclaimStalledDispatches();
  assert.deepEqual(reclaimed, [], "a gateway-live run is never reclaimed");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
  const after = await h.repos.executions.get(execution.id);
  assert.ok(after.last_event_at >= clock.now() - 1000, "the describe refreshed the activity clock");
});

test("a run the GATEWAY says finished is not parked — the reconciler rescues it", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "lost end frame" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  h.fake.gateway.markTerminal(execution.session_key, "done");

  clock.advance(31 * 60 * 1000);
  assert.deepEqual(await h.scheduler.reclaimStalledDispatches(), [],
    "parking BLOCKED under a finished run would free the workspace for a sibling for nothing");

  // And the same evidence settles it COMPLETE within one reconcile pass.
  const { createSessionEventSink } = await import("../../src/runtime/session-events.mjs");
  const { createReconciler } = await import("../../src/runtime/reconciler.mjs");
  const sink = createSessionEventSink({
    repos: h.repos, events: h.events, scheduler: h.scheduler,
    runtime: { connect: async () => ({}), request: async () => ({}) },
  });
  const reconciler = createReconciler({
    repos: h.repos, events: h.events, runtime: h.runtime,
    applyDescribe: (e, s) => sink.applyDescribe(e, s), now: clock.now,
  });
  const out = await reconciler.reconcileOnce();
  assert.equal(out.settled.length, 1);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.COMPLETE);
});

test("parking waits for abort confirmation — an unverifiable run keeps its slot", async () => {
  // The concurrency invariant (the over-commit hazard): BLOCKED frees the
  // model slot, the worker slot and the lease. None of that may happen while
  // the run's fate at the gateway is unknown.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gateway unreachable" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;

  // A gateway that cannot answer (describe null — session unknown to it — and
  // abort failing outright).
  h.gatewayHooks.describeSession = async () => null;
  h.gatewayHooks.abortRun = async () => ({ ok: false, aborted: false, reason: "gateway unreachable" });

  clock.advance(31 * 60 * 1000);
  const reclaimed = await h.scheduler.reclaimStalledDispatches();
  assert.deepEqual(reclaimed, [], "an unverifiable run is not parked");
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.DISPATCHED);
  assert.ok(await h.repos.leases.get(path), "the lease stays while the outcome is unknown");
  assert.equal(await h.repos.resources.activeCount(execution.model_provider, execution.model_id), 1,
    "the model slot stays occupied while the run may still be live");
});

test("a confirmed stop recovers with the evidence named", async () => {
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "quiet and dead" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  // The run IS live at the gateway, but describe cannot see it (an unknown
  // session to that surface — the shape a pruned or restart-lost session has).
  // The watchdog must not free anything until abort has actually stopped it.
  h.fake.gateway.markRunning(execution.session_key);
  h.gatewayHooks.describeSession = async () => null;
  clock.advance(31 * 60 * 1000);
  const reclaimed = await h.scheduler.reclaimStalledDispatches();
  assert.deepEqual(reclaimed, [execution.id]);
  assert.ok(h.fake.gateway.aborts.includes(execution.session_key), "abort ran before anything was freed");
  const dead = await h.repos.executions.get(execution.id);
  assert.equal(dead.status, ExecutionStatus.FAILED);
  assert.match(dead.result, /aborted live run at gateway/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED, "auto-retried (D75)");
});

test("a gateway-failed session recovers with the verdict named, not just the silence", async () => {
  // TASK-4CA0D674: the gateway's own projection said `failed` while the park
  // reason said only "no runtime event for 1810s". The verdict is the thing
  // an operator needs first — it names the failure, the silence just times it.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "died at gateway" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  h.fake.gateway.markTerminal(execution.session_key, "failed");

  clock.advance(31 * 60 * 1000);
  const reclaimed = await h.scheduler.reclaimStalledDispatches();
  assert.deepEqual(reclaimed, [execution.id]);
  const dead = await h.repos.executions.get(execution.id);
  assert.equal(dead.status, ExecutionStatus.FAILED);
  assert.match(dead.result, /gateway session: failed/);
  assert.match(dead.result, /no active run at gateway/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED, "auto-retried (D75)");
});

test("the retry budget is real: a task that keeps dying ends up BLOCKED", async () => {
  // Auto-recovery must not become a loop that drowns the signal. Default
  // budget is 2 requeues inside the 1h failure window — the third death parks
  // the task BLOCKED with the streak named, which is where a human genuinely
  // belongs. The clock stays tight (backoff is 30s→60s, silence 31m per
  // death): drifting minutes past the window would drop the older failures
  // from recentFailures and the budget would never trigger.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "keeps dying" });
  await h.scheduler.notify();

  const kill = async () => {
    const execution = await h.repos.executions.latest(task.id);
    h.fake.gateway.markTerminal(execution.session_key, "failed");
    clock.advance(31 * 60 * 1000);
    await h.scheduler.reclaimStalledDispatches();
  };

  await kill();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED, "first death requeues");
  clock.advance(5 * 60 * 1000); // backoff 30s elapses, still inside the window
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED, "retry dispatched");
  await kill();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED, "second death requeues");
  clock.advance(5 * 60 * 1000);
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED, "second retry dispatched");
  await kill();
  const exhausted = await h.repos.tasks.get(task.id);
  assert.equal(exhausted.status, Status.BLOCKED, "third death exhausts the budget");
  assert.match(exhausted.wait_reason ?? "", /auto-retries exhausted/);
});

// ── The over-commit scenario, end to end ────────────────────────────────────

test("a live-but-silent run still holds the provider's last concurrency slot", async () => {
  // The exact accounting failure reported: a task parked BLOCKED while its
  // agent kept running freed a slot that no longer existed, so admission
  // dispatched a second task onto a provider already at its limit. With
  // describe-verification the slot is only freed on gateway-confirmed truth.
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h, { concurrencyLimit: 1, maxConcurrent: 8 });
  const first = await queuedTask(h, { project, worker, title: "silent but alive", isolate: true });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(first.id);
  assert.equal(execution.model_provider, "google"); // documentation/normal -> gemini-flash
  h.fake.gateway.markRunning(execution.session_key);

  clock.advance(31 * 60 * 1000);
  await h.scheduler.reclaimStalledDispatches();
  assert.equal((await h.repos.tasks.get(first.id)).status, Status.DISPATCHED,
    "the run is live at the gateway; parking it would invent a free slot");

  // Pinned to the SAME model — otherwise D68 failover routes the second task
  // elsewhere and the test stops being about concurrency accounting.
  const second = await queuedTask(h, {
    project, worker, title: "wants the same model", isolate: true,
    modelPolicy: { preferred: ["gemini-flash"] },
  });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(second.id)).status, Status.WAIT_CONCURRENCY,
    "the provider's only slot is still truthfully occupied");
  assert.equal(await h.repos.resources.activeCount("google", "gemini-flash"), 1);
});
