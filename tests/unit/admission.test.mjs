// P4-02: every admission blocker produces its own WAIT_* status, never FAILED.
// P4-03: quality-critical work is never quietly downgraded.
import test from "node:test";
import assert from "node:assert/strict";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics, queuedTask, SAMPLE_ROUTING } from "../helpers/harness.mjs";

test("unmet dependency parks the task on WAIT_DEP", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const blocker = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "first" });
  const task = await queuedTask(h, { project, worker, isolate: true, title: "second", dependsOn: [blocker.id] });

  await h.scheduler.notify();
  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_DEP);
  assert.match(parked.wait_reason, new RegExp(blocker.id));
  assert.equal(h.fake.dispatches.length, 0);
});

test("an L3 task raises an approval and waits for a human", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, approvalLevel: "L3", title: "deploy prod" });

  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_HUMAN);

  const [approval] = await h.repos.approvals.pendingForTask(task.id);
  assert.equal(approval.level, "L3");
  assert.equal(h.fake.dispatches.length, 0, "no silent bypass while a human is pending");

  // Re-running admission must not pile up duplicate approvals.
  await h.scheduler.notify();
  assert.equal((await h.repos.approvals.pendingForTask(task.id)).length, 1);
});

test("approval decisions steer the task: APPROVE dispatches, REJECT blocks", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);

  const approved = await queuedTask(h, { project, worker, approvalLevel: "L3", title: "ok" });
  await h.scheduler.notify();
  const [a1] = await h.repos.approvals.pendingForTask(approved.id);
  await h.repos.approvals.decide(a1.id, { decision: "APPROVE", decidedBy: "satria" });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(approved.id)).status, Status.DISPATCHED);

  const rejected = await queuedTask(h, { project, worker, approvalLevel: "L3", title: "no" });
  await h.scheduler.notify();
  const [a2] = await h.repos.approvals.pendingForTask(rejected.id);
  await h.repos.approvals.decide(a2.id, { decision: "REJECT", decidedBy: "satria", note: "unsafe" });
  await h.scheduler.notify();
  const blocked = await h.repos.tasks.get(rejected.id);
  assert.equal(blocked.status, Status.BLOCKED, "a rejection blocks; it is not a failure");
});

test("an approval must name who decided it", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, approvalLevel: "L3", title: "t" });
  await h.scheduler.notify();
  const [approval] = await h.repos.approvals.pendingForTask(task.id);

  await assert.rejects(
    () => h.repos.approvals.decide(approval.id, { decision: "APPROVE", decidedBy: "" }),
    /decidedBy is required/,
  );
  await assert.rejects(
    () => h.repos.approvals.decide(approval.id, { decision: "COMMENT", decidedBy: "satria" }),
    /does not close an approval/,
  );
});

test("a taken workspace lease parks the second task on WAIT_WORKSPACE", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const shared = "/nfs/workspaces/alpha/executions/shared";

  const first = await queuedTask(h, { project, worker, isolate: true, title: "first", workspacePath: shared });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(first.id)).status, Status.DISPATCHED);

  const second = await queuedTask(h, { project, worker, isolate: true, title: "second", workspacePath: shared });
  await h.scheduler.notify();
  const parked = await h.repos.tasks.get(second.id);
  assert.equal(parked.status, Status.WAIT_WORKSPACE);
  assert.equal(h.fake.dispatches.length, 1);
});

test("a model outside any policy route parks on WAIT_RESOURCE", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, {
    project,
    worker,
    title: "unroutable",
    modelPolicy: { category: "nonexistent-category", class: "normal" },
  });

  await h.scheduler.notify();
  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RESOURCE);
  assert.match(parked.wait_reason, /no routing policy/);
});

test("P4-03: exhausted quota parks a critical task with an ETA and never downgrades it", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  // architecture/critical is [claude-opus-high, glm-5.2-high] with fallback: none.
  await h.repos.resources.upsert({ provider: "anthropic", model: "claude-opus-5" });
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.2" });
  const resetAt = h.clock.now() + 5 * 60 * 60 * 1000;
  await h.repos.resources.setAvailability("anthropic", "claude-opus-5", "QUOTA_EXHAUSTED", {
    nextAvailableAt: resetAt,
  });
  await h.repos.resources.setAvailability("zai", "glm-5.2", "QUOTA_EXHAUSTED", { nextAvailableAt: resetAt });

  const task = await queuedTask(h, {
    project,
    worker,
    title: "architecture review",
    qualityClass: "L5",
    modelPolicy: { category: "architecture" },
  });

  await h.scheduler.notify();
  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_QUOTA);
  assert.equal(parked.next_retry_at, resetAt, "the ETA is the real reset time, not a guess");
  assert.equal(h.fake.dispatches.length, 0);

  // gemini-flash is available and cheap, and is exactly what a downgrading
  // scheduler would reach for. It is not in the architecture/critical route,
  // so it must never be chosen.
  assert.equal(
    h.fake.dispatches.some((d) => d.candidate.model === "gemini-flash"),
    false,
  );
});

test("provider concurrency saturation parks on WAIT_CONCURRENCY", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10, concurrencyLimit: 1 });
  // Pinned to a single model on purpose: with the default documentation route
  // the second task would legitimately move to the next preferred model, which
  // is the behaviour the *next* assertion covers.
  const pinned = { preferred: ["gemini-flash"] };

  const first = await queuedTask(h, { project, worker, isolate: true, title: "first", modelPolicy: pinned });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(first.id)).status, Status.DISPATCHED);

  const second = await queuedTask(h, { project, worker, isolate: true, title: "second", modelPolicy: pinned });
  await h.scheduler.notify();
  const parked = await h.repos.tasks.get(second.id);
  assert.equal(parked.status, Status.WAIT_CONCURRENCY);
  assert.match(parked.wait_reason, /concurrency limit/);
});

test("a saturated first choice falls to the next model inside the same policy", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10, concurrencyLimit: 1 });

  // documentation/normal is [gemini-flash, glm-4.7]: moving to glm-4.7 is not a
  // downgrade, it is the operator's stated second preference (POC-4 §5.3).
  await queuedTask(h, { project, worker, isolate: true, title: "first" });
  await h.scheduler.notify();
  await queuedTask(h, { project, worker, isolate: true, title: "second" });
  await h.scheduler.notify();

  assert.deepEqual(
    h.fake.dispatches.map((d) => d.candidate.logical),
    ["gemini-flash", "glm-4.7"],
  );
});

test("worker capacity and worker absence are distinguishable WAIT_WORKER reasons", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 1 });

  const unassigned = await queuedTask(h, { project, worker: null, title: "orphan" });
  await h.scheduler.notify();
  const orphan = await h.repos.tasks.get(unassigned.id);
  assert.equal(orphan.status, Status.WAIT_WORKER);
  assert.match(orphan.wait_reason, /no worker assigned/);

  const first = await queuedTask(h, { project, worker, isolate: true, title: "first" });
  await h.scheduler.notify();
  const second = await queuedTask(h, { project, worker, isolate: true, title: "second" });
  await h.scheduler.notify();
  const busy = await h.repos.tasks.get(second.id);
  assert.equal(busy.status, Status.WAIT_WORKER);
  assert.match(busy.wait_reason, /at capacity/);
});

test("global runtime capacity parks the overflow on WAIT_RUNTIME", async () => {
  const h = await buildHarness({ config: { maxRunning: 1 } });
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10 });

  await queuedTask(h, { project, worker, isolate: true, title: "first" });
  await queuedTask(h, { project, worker, isolate: true, title: "second" });
  await h.scheduler.notify();

  const statuses = (await h.repos.tasks.list({})).map((t) => t.status);
  assert.equal(statuses.filter((s) => s === Status.DISPATCHED).length, 1);
  assert.equal(statuses.filter((s) => s === Status.WAIT_RUNTIME).length, 1);
});

test("a runtime that refuses the handoff yields WAIT_RUNTIME and releases the lease", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "refused" });

  h.fake.failNextDispatch(new Error("AgentOS unreachable"));
  await h.scheduler.notify();

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RUNTIME, "a runtime problem is not a task failure");
  assert.match(parked.wait_reason, /dispatch failed/);
  assert.equal((await h.repos.leases.list()).length, 0, "no lease is left stranded");

  // And it recovers without operator intervention — after the backoff, not on
  // the very next pass. Retrying immediately is what produced 582 executions
  // for one task on the cluster; a transient runtime failure now waits.
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_RUNTIME, "still backing off");

  h.clock.advance(60_000);
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
});

test("claude-code may only leave through the ACP or batch path", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await h.repos.resources.upsert({
    provider: "claude-code",
    model: "claude-code",
    creditClass: "subscription",
    concurrencyLimit: 5,
  });

  const ok = await queuedTask(h, {
    project,
    worker,
    isolate: true,
    title: "coding via acp",
    modelPolicy: { category: "coding", class: "normal" },
  });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(ok.id)).status, Status.DISPATCHED);
  assert.equal(h.fake.dispatches.at(-1).candidate.mode, "acp");

  // A route that points claude-code at the ordinary interactive path is a
  // configuration error and must not dispatch.
  const misrouted = await queuedTask(h, {
    project,
    worker,
    isolate: true,
    title: "coding misrouted",
    modelPolicy: { category: "coding", class: "critical" },
  });
  const misroutedTask = await h.repos.tasks.get(misrouted.id);
  await assert.rejects(() => h.admission.evaluate(misroutedTask), /ACP or batch path/);
});

test("the pipeline stops at the first blocker, in spec order", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const blocker = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "dep" });
  // Dependency (step 1) and approval (step 2) both unsatisfied: step 1 wins.
  const task = await queuedTask(h, {
    project,
    worker,
    title: "both",
    approvalLevel: "L3",
    dependsOn: [blocker.id],
  });

  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_DEP);
  assert.equal(
    (await h.repos.approvals.listForTask(task.id)).length,
    0,
    "an approval is not raised for work that cannot run yet",
  );
});

test("no admission path can produce FAILED", async () => {
  const h = await buildHarness({ config: { maxRunning: 0 } });
  const { project, worker } = await seedBasics(h);
  await queuedTask(h, { project, worker, isolate: true, title: "a" });
  await queuedTask(h, { project, worker: null, title: "b" });
  await queuedTask(h, { project, worker, title: "c", modelPolicy: { category: "nope" } });
  await h.scheduler.notify();

  for (const task of await h.repos.tasks.list({})) {
    assert.notEqual(task.status, Status.FAILED, `${task.title} must wait, not fail`);
  }
});

// D42 regression. Decompose writes the brain's own name into
// model_policy.preferred, and brains.create slugs names — the catalog entry
// "glm-5.2-max" is stored as brain "glm-5-2-max". Before D42 admission looked
// preferred names up in the routing.json catalog by exact string, so EVERY
// brain with a dotted model name parked on WAIT_RESOURCE "unmapped model
// names" — observed on the cluster for project SDMK Kader, where it made the
// Settings → Brain/Brain Map pages unable to route anything they controlled.
test("D42: a slugged brain name routes from the brains table, not the catalog spelling", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);

  const brain = await h.brains.get("glm-5-2-high");
  assert.ok(brain, "the seeded brain exists under its slugged name");
  assert.notEqual(brain.name, "glm-5.2-high", "brain name and catalog key deliberately differ");

  const task = await queuedTask(h, {
    project,
    worker,
    isolate: true,
    title: "builder phase",
    modelPolicy: { preferred: [brain.name], class: "normal", category: "coding" },
  });
  await h.scheduler.notify();

  const after = await h.repos.tasks.get(task.id);
  assert.equal(after.status, Status.DISPATCHED, `expected dispatch, got ${after.status}: ${after.wait_reason}`);
  assert.equal(h.fake.dispatches.length, 1);
  assert.equal(h.fake.dispatches[0].candidate.model, "glm-5.2");
  assert.equal(h.fake.dispatches[0].candidate.thinking, "high", "effort comes from the brain row");
});

test("D42: a brain created on the settings page routes without any routing.json entry", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);

  // A name with no catalog counterpart at all — the flexibility the Brain
  // page exists for.
  const brain = await h.brains.create({
    name: "glm-4.7 tuned",
    provider: "zai",
    model: "glm-4.7",
    thinking: "low",
    level: "normal",
  });
  assert.equal(brain.name, "glm-4-7-tuned");

  const task = await queuedTask(h, {
    project,
    worker,
    isolate: true,
    title: "tuned run",
    modelPolicy: { preferred: [brain.name] },
  });
  await h.scheduler.notify();

  const after = await h.repos.tasks.get(task.id);
  assert.equal(after.status, Status.DISPATCHED, `expected dispatch, got ${after.status}: ${after.wait_reason}`);
  assert.equal(h.fake.dispatches[0].candidate.model, "glm-4.7");
});

test("D42: a disabled brain falls back to the catalog when the name matches one", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);

  const brain = await h.brains.get("glm-5-2-high");
  await h.brains.update(brain.id, { enabled: false });

  // The dotted catalog key: not a live brain anymore, but still a catalog
  // entry — parking here would turn a routine disable into a dead route.
  const task = await queuedTask(h, {
    project,
    worker,
    isolate: true,
    title: "fallback",
    modelPolicy: { preferred: ["glm-5.2-high"] },
  });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
});

test("D42: names that are neither brains nor catalog entries still park on WAIT_RESOURCE", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);

  const task = await queuedTask(h, {
    project,
    worker,
    isolate: true,
    title: "ghost",
    modelPolicy: { preferred: ["no-such-brain"] },
  });
  await h.scheduler.notify();

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RESOURCE);
  assert.match(parked.wait_reason, /no-such-brain/);
  assert.equal(h.fake.dispatches.length, 0);
});
