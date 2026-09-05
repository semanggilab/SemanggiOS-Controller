// P4-06 quota reset re-evaluation, P4-07 lease exclusivity, P4-11 restart safety.
import test from "node:test";
import assert from "node:assert/strict";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics, queuedTask, Clock } from "../helpers/harness.mjs";

test("P4-07: two tasks on one workspace path are never RUNNING together", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const path = "/nfs/workspaces/alpha/source";

  const a = await queuedTask(h, { project, worker, title: "a", workspacePath: path });
  const b = await queuedTask(h, { project, worker, title: "b", workspacePath: path });
  await h.scheduler.notify();

  const states = [(await h.repos.tasks.get(a.id)).status, (await h.repos.tasks.get(b.id)).status];
  assert.equal(states.filter((s) => s === Status.DISPATCHED).length, 1);
  assert.equal(states.filter((s) => s === Status.WAIT_WORKSPACE).length, 1);
  assert.equal((await h.repos.leases.list()).length, 1);
});

test("releasing a lease lets the waiting task through on the next pass", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const path = "/nfs/workspaces/alpha/source";

  const a = await queuedTask(h, { project, worker, title: "a", workspacePath: path });
  const b = await queuedTask(h, { project, worker, title: "b", workspacePath: path });
  await h.scheduler.notify();

  const holder = (await h.repos.tasks.get(a.id)).status === Status.DISPATCHED ? a : b;
  const waiter = holder.id === a.id ? b : a;

  const execution = await h.repos.executions.latest(holder.id);
  await h.fake.startExecution(execution.id);
  await h.fake.completeExecution(execution.id);
  assert.equal((await h.repos.leases.list()).length, 0, "completion releases the lease");

  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(waiter.id)).status, Status.DISPATCHED);
});

test("an expired lease is reclaimed and the previous owner is marked BLOCKED", async () => {
  const clock = new Clock();
  const h = await buildHarness({ clock, config: { leaseTtlMs: 1_000 } });
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const path = "/nfs/workspaces/alpha/source";

  const a = await queuedTask(h, { project, worker, title: "a", workspacePath: path });
  await h.scheduler.notify();
  const stranded = await h.repos.executions.latest(a.id);
  await h.fake.startExecution(stranded.id);

  // REVISED 2026-08-22. This used to leave the execution RUNNING and simply let
  // the clock pass. That no longer expires anything, and rightly so: live work
  // now heartbeats its lease, because losing a workspace mid-run was letting a
  // second task write to the same tree. Reclamation is for leases whose owner
  // is NOT running — here, one the watchdog already gave up on.
  await h.repos.executions.setStatus(stranded.id, ExecutionStatus.BLOCKED, { result: "runtime went silent" });
  clock.advance(2_000); // TTL lapses, and nothing renews it now

  const b = await queuedTask(h, { project, worker, title: "b", workspacePath: path });
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(b.id)).status, Status.DISPATCHED, "the path is reusable");
  assert.equal(
    (await h.repos.executions.get(stranded.id)).status,
    ExecutionStatus.BLOCKED,
    "the old owner is told it lost the workspace rather than being silently overwritten",
  );

  // Two paths can free it now — the watchdog's orphan sweep (`lease.released`)
  // or expiry at acquire time (`lease.reclaimed`). Which one wins is a race and
  // not the point; what matters is that the path was freed by a recorded action
  // rather than silently taken.
  const kinds = (await h.events.list({ subjectType: "lease", subjectId: path })).map((e) => e.kind);
  assert.ok(
    kinds.includes("lease.reclaimed") || kinds.includes("lease.released"),
    `expected the release to be audited, saw ${JSON.stringify(kinds)}`,
  );
});

test("a heartbeat keeps a long-running execution's lease alive", async () => {
  const clock = new Clock();
  const h = await buildHarness({ clock, config: { leaseTtlMs: 1_000 } });
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const path = "/nfs/workspaces/alpha/source";

  const a = await queuedTask(h, { project, worker, title: "a", workspacePath: path });
  await h.scheduler.notify();

  clock.advance(800);
  // Per execution now, not per path: shared readers mean renewing by path alone
  // would extend leases belonging to work that already stopped.
  await h.repos.leases.heartbeat(path, {
    executionId: (await h.repos.executions.latest(a.id)).id,
    ttlMs: 1_000,
  });
  clock.advance(800);

  const b = await queuedTask(h, { project, worker, title: "b", workspacePath: path });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(b.id)).status, Status.WAIT_WORKSPACE);
});

test("P4-06: a quota window closing re-dispatches without operator action", async () => {
  const clock = new Clock();
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const resetAt = clock.now() + 5 * 60 * 60 * 1000; // GLM-style 5h window
  await h.repos.resources.setAvailability("google", "gemini-flash", "QUOTA_EXHAUSTED", {
    nextAvailableAt: resetAt,
  });
  await h.repos.resources.setAvailability("zai", "glm-4.7", "QUOTA_EXHAUSTED", { nextAvailableAt: resetAt });

  const task = await queuedTask(h, { project, worker, title: "waits for quota" });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_QUOTA);
  assert.equal((await h.repos.tasks.get(task.id)).next_retry_at, resetAt);

  // Still inside the window: nothing changes.
  clock.advance(60_000);
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_QUOTA);

  // Window closes. The pass itself flips availability; no human intervenes.
  clock.advance(5 * 60 * 60 * 1000);
  const record = await h.scheduler.notify();
  assert.ok(record.quotaReleased.length > 0, "the reset is detected by the scheduler, not by an operator");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
});

test("a quota decision is auditable after the fact", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await h.repos.resources.setAvailability("google", "gemini-flash", "QUOTA_EXHAUSTED", {
    nextAvailableAt: h.clock.now() + 1000,
  });
  await h.repos.resources.setAvailability("zai", "glm-4.7", "QUOTA_EXHAUSTED", {
    nextAvailableAt: h.clock.now() + 1000,
  });
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();

  const quotaEvents = (await h.events.list({ subjectType: "task", subjectId: task.id })).filter(
    (e) => e.kind === "quota.decision",
  );
  assert.equal(quotaEvents.length, 1);
  assert.equal(quotaEvents[0].payload.status, Status.WAIT_QUOTA);
  assert.ok(quotaEvents[0].payload.nextRetryAt);
});

test("P4-11: repeated passes never dispatch the same task twice", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const task = await queuedTask(h, { project, worker, title: "once" });

  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  await h.fake.startExecution(execution.id);

  // Simulate the watchdog firing repeatedly while the task is still running.
  for (let i = 0; i < 5; i++) await h.scheduler.notify();

  assert.equal(h.fake.dispatches.length, 1);
  assert.equal((await h.repos.executions.listByTask(task.id)).length, 1);
});

test("P4-11: a restarted controller resumes from the database without re-dispatching", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const task = await queuedTask(h, { project, worker, title: "survivor" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  await h.fake.startExecution(execution.id);

  // A fresh scheduler over the same store is what a restart looks like.
  const { createScheduler } = await import("../../src/scheduler/scheduler.mjs");
  const revived = createScheduler({ admission: h.admission, repos: h.repos, now: h.clock.now });
  await revived.notify();

  assert.equal(h.fake.dispatches.length, 1);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.RUNNING, "in-flight work is left alone");
});

// ── Cost accounting: POC-4 §4 / P4-03 (POC-3 E8) ────────────────────────

test("batch usage is costed in tokens, with cache reads included", async () => {
  // The exact figures POC-3 E8 measured on one batch run. If cost counted only
  // input+output it would read 1,311 instead of 125,834 — the two-orders-of-
  // magnitude error E8 warned about.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "batch review" });
  const execution = await h.repos.executions.create({ taskId: task.id, mode: "batch" });

  const updated = await h.repos.executions.recordUsage(execution.id, {
    input_tokens: 8,
    output_tokens: 1303,
    cache_read_input_tokens: 92663,
    cache_creation_input_tokens: 31860,
  });

  assert.equal(h.repos.executions.billableTokens(updated), 125834);
  assert.equal(updated.cost, 125834, "cost must not stay at 0 for the batch path");
  assert.equal(updated.cost_unit, "tokens", "a Pro plan has no USD unit that corresponds to a bill");
});

test("seeding resources never overwrites a live quota signal", async () => {
  // A 429 recorded at runtime is more current than any config file. Resetting
  // it on restart would send the scheduler straight back into the wall.
  const { createController } = await import("../../src/app.mjs");
  const seed = [{ provider: "claude-code", model: "claude-code", creditClass: "subscription", concurrencyLimit: 1 }];
  const c = await createController({ resources: seed, runtime: null });
  await c.repos.resources.applyQuotaSignal("claude-code", "claude-code", {
    status: 429, resetsAt: 1787113200, rateLimitType: "five_hour", message: "session limit",
  });

  const before = await c.repos.resources.get("claude-code", "claude-code");
  assert.equal(before.availability, "QUOTA_EXHAUSTED");

  // Same store, second boot.
  for (const r of seed) {
    const existing = await c.repos.resources.get(r.provider, r.model);
    if (!existing) await c.repos.resources.upsert(r);
  }
  const after = await c.repos.resources.get("claude-code", "claude-code");
  assert.equal(after.availability, "QUOTA_EXHAUSTED", "a restart must not clear an observed quota wall");
  // The repository normalises a seconds-epoch provider value to milliseconds.
  assert.equal(after.next_available_at, 1787113200000);
});
