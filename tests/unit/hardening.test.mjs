// Findings from the adversarial pass (C). Each test is a hole that was open.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";
import { assertWorkspacePath } from "../../src/domain/repositories.mjs";

test("a workspace path cannot traverse out of the tree", () => {
  // `/opt/semanggi/../../etc` was accepted. The mount contract is host ==
  // container, so a traversing path aims a real agent at a real directory
  // outside the canonical root.
  assert.throws(() => assertWorkspacePath("/opt/semanggi/../../etc"), /traverse/);
  assert.throws(() => assertWorkspacePath("relative/path"), /absolute/);
  assert.throws(() => assertWorkspacePath(""), /required/);
  assert.doesNotThrow(() => assertWorkspacePath("/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/a"));
});

test("a workspace root can be pinned, and everything outside it refused", () => {
  const root = "/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces";
  assert.doesNotThrow(() => assertWorkspacePath(`${root}/alpha`, { root }));
  assert.throws(() => assertWorkspacePath("/tmp/elsewhere", { root }), /must live under/);
  // A sibling that merely shares a prefix must not pass.
  assert.throws(() => assertWorkspacePath(`${root}-evil/x`, { root }), /must live under/);
});

test("projects and tasks refuse a bad workspace path", async () => {
  const h = await buildHarness();
  await assert.rejects(
    () => h.repos.projects.create({ name: "bad", weight: 1, workspacePath: "/opt/../etc" }),
    /traverse/,
  );
  const { project } = await seedBasics(h);
  await assert.rejects(
    () => h.repos.tasks.create({ projectId: project.id, title: "t", workspacePath: "nope" }),
    /absolute/,
  );
});

test("usage understands both producers' spellings", async () => {
  // Passing the gateway shape into recordUsage used to store zeros, which is
  // the same silent-zero failure that hid D17 for a full cycle.
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const t = await h.repos.tasks.create({ projectId: project.id, title: "u" });
  const e = await h.repos.executions.create({ taskId: t.id, mode: "interactive" });

  const gateway = await h.repos.executions.recordUsage(e.id, { input: 100, output: 10, cacheRead: 5 });
  assert.equal(h.repos.executions.billableTokens(gateway), 115);

  const t2 = await h.repos.tasks.create({ projectId: project.id, title: "u2" });
  const e2 = await h.repos.executions.create({ taskId: t2.id, mode: "batch" });
  const batch = await h.repos.executions.recordUsage(e2.id, {
    input_tokens: 8, output_tokens: 1303, cache_read_input_tokens: 92663, cache_creation_input_tokens: 31860,
  });
  assert.equal(h.repos.executions.billableTokens(batch), 125834);
});

test("an unrecognised usage shape is refused, not stored as zero", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const t = await h.repos.tasks.create({ projectId: project.id, title: "weird" });
  const e = await h.repos.executions.create({ taskId: t.id, mode: "interactive" });
  await assert.rejects(
    () => h.repos.executions.recordUsage(e.id, { tokensConsumed: 42, price: 1 }),
    /unrecognised usage shape/,
  );
});

// ── Retry backoff: found by reading the new logs (C) ─────────────────────

test("a task that cannot run backs off instead of retrying every pass", async () => {
  // Observed on the cluster within a minute of turning on structured logging:
  // one task at execution #582, cycling QUEUED → WAIT_RESOURCE every 30s and
  // writing an immutable execution row each time. Executions are immutable by
  // design, so the fix is to attempt less often, not to reuse rows.
  const { Clock } = await import("../helpers/harness.mjs");
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const { queuedTask } = await import("../helpers/harness.mjs");
  // Routed to a model with no resource row at all, so it can never dispatch.
  const task = await queuedTask(h, {
    project, worker, title: "impossible",
    modelPolicy: { preferred: ["claude-opus-high"] },
  });

  await h.scheduler.notify();
  const first = (await h.repos.executions.listByTask(task.id)).length;

  // Several passes inside the backoff window must not produce new attempts.
  for (let i = 0; i < 5; i++) await h.scheduler.notify();
  assert.equal((await h.repos.executions.listByTask(task.id)).length, first, "no new attempts while backing off");

  const parked = await h.repos.tasks.get(task.id);
  assert.ok(parked.next_retry_at > clock.now(), "and the queue can show a real ETA");
});

test("backoff grows with repeated failure rather than staying flat", async () => {
  const { Clock, queuedTask } = await import("../helpers/harness.mjs");
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "keeps failing" });

  const waits = [];
  for (let i = 0; i < 3; i++) {
    h.fake.failNextDispatch(new Error("runtime down"));
    await h.scheduler.notify();
    const t = await h.repos.tasks.get(task.id);
    waits.push(t.next_retry_at - clock.now());
    clock.advance(t.next_retry_at - clock.now() + 1);
  }
  assert.ok(waits[1] > waits[0], `expected growth, saw ${JSON.stringify(waits)}`);
  assert.ok(waits[2] > waits[1], `expected growth, saw ${JSON.stringify(waits)}`);
});

test("a human decision clears the backoff immediately", async () => {
  // Making an operator wait out a backoff they had no part in reads as the
  // decision being ignored.
  const { Clock, queuedTask } = await import("../helpers/harness.mjs");
  const clock = new Clock(1_000_000);
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "needs approval", approvalLevel: "L3" });
  await h.scheduler.notify();

  const approval = (await h.repos.approvals.listForTask(task.id))[0];
  await h.repos.approvals.decide(approval.id, { decision: "APPROVE", decidedBy: "satria" });
  assert.equal((await h.repos.tasks.get(task.id)).next_retry_at, null, "the decision is news; the backoff is not");
});
