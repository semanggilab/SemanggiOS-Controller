// The Slack app: identity, confirmation, and full control.
//
// The three things worth defending here are (a) an unregistered Slack user gets
// nothing, (b) a destructive verb never acts on the first message, and (c) a
// model change that would route to nothing is refused instead of parking the
// task in WAIT_RESOURCE for someone to find later.
import test from "node:test";
import assert from "node:assert/strict";
import { createSlackApp } from "../../src/interface/slack-app.mjs";
import { parseModelSpec, classify, Action } from "../../src/interface/intent.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

async function slackHarness() {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const app = createSlackApp(h, { defaultProjectId: project.id });
  const { operator } = await h.operators.create({ name: "Satria", slackUserId: "U123", role: "admin" });
  return { h, app, project, worker, operator };
}

const cmd = (app, text, user = "U123") => app.handleCommand({ text, user_id: user, user_name: "satria" });

// --- identity ----------------------------------------------------------------

test("an unregistered Slack user is refused, not silently served", async () => {
  const { app } = await slackHarness();
  const res = await cmd(app, "queue", "U-STRANGER");
  assert.match(res.text, /not registered/i);
  assert.equal(res.response_type, "ephemeral");
});

test("an unregistered user cannot press an approval button either", async () => {
  const { app } = await slackHarness();
  const res = await app.handleInteraction({
    user: { id: "U-STRANGER", name: "mallory" },
    actions: [{ action_id: "approve", value: "APR-1" }],
  });
  assert.match(res.text, /not registered/i);
});

test("a read-only operator may look but not act", async () => {
  const { h, app } = await slackHarness();
  await h.operators.create({ name: "Auditor", slackUserId: "U-RO", role: "readonly" });
  const looked = await cmd(app, "queue", "U-RO");
  assert.doesNotMatch(looked.text, /read-only/);
  const acted = await cmd(app, "task write the runbook", "U-RO");
  assert.match(acted.text, /read-only/);
});

// --- attribution -------------------------------------------------------------

test("actions are attributed to the operator behind the Slack id, not to the app", async () => {
  const { h, app } = await slackHarness();
  const res = await cmd(app, "task write the runbook");
  assert.match(res.text, /Satria/);
  // Queued, then possibly moved on by the scheduler pass that `notify` woke —
  // so look it up by identity rather than by whatever status it landed on.
  const id = /`(TASK-[A-Z0-9]+)`/.exec(res.text)?.[1];
  assert.ok(id, `no task id in "${res.text}"`);
  const task = await h.repos.tasks.get(id);
  assert.equal(task.title, "write the runbook");
  assert.notEqual(task.status, Status.CREATED, "a Slack-created task must not stay held");
  // Found live: without a worker the task queues cleanly and then sits on
  // WAIT_WORKER forever, because admission checks the assignment but never
  // makes one. Slack has nowhere to type a worker id, so it has to choose.
  assert.ok(task.worker_id, "a Slack-created task must be given a worker");
});

test("Slack refuses to queue work no worker could take", async () => {
  const { h, app, worker } = await slackHarness();
  await h.store.run(`UPDATE workers SET status = 'PAUSED' WHERE id = ?`, [worker.id]);
  const res = await cmd(app, "task write the runbook");
  assert.match(res.text, /No active worker/i);
  assert.equal((await h.repos.tasks.list({})).length, 0, "nothing should be queued");
});

test("approving from a button records the pressing operator", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  const approval = await h.repos.approvals.create({
    taskId: task.id,
    level: "L3",
    question: "Allow Bash?",
    options: ["APPROVE", "REJECT"],
  });
  const res = await app.handleInteraction({
    user: { id: "U123", name: "satria" },
    actions: [{ action_id: "approve", value: approval.id }],
  });
  assert.match(res.text, /Approved/);
  const stored = await h.repos.approvals.get(approval.id);
  assert.equal(stored.decision, "APPROVE");
  assert.equal(stored.decided_by, "Satria");
});

// --- confirmation on destructive verbs ---------------------------------------

test("stop asks first and names the task it would stop", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  const asked = await cmd(app, `stop ${task.id}`);
  assert.match(asked.text, new RegExp(task.id));
  assert.match(asked.text, /Reply `yes`/);
  // Nothing has changed yet.
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);

  const done = await cmd(app, "yes");
  assert.match(done.text, /Stopped/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
});

test("saying no leaves the task alone", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  await cmd(app, `stop ${task.id}`);
  const dropped = await cmd(app, "no");
  assert.match(dropped.text, /Dropped/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);
});

test("a confirmation belongs to one operator and cannot be answered by another", async () => {
  const { h, app, project } = await slackHarness();
  await h.operators.create({ name: "Budi", slackUserId: "U456", role: "operator" });
  const task = await queuedTask(h, { project });
  await cmd(app, `stop ${task.id}`, "U123");
  const budi = await cmd(app, "yes", "U456");
  assert.match(budi.text, /Nothing waiting/i);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);
});

test("a stale confirmation expires rather than firing later", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  await cmd(app, `stop ${task.id}`);
  h.clock.advance(3 * 60 * 1000);
  const late = await cmd(app, "yes");
  assert.match(late.text, /Nothing waiting/i);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);
});

test('"ok" confirms a pending question but never acts on its own', async () => {
  const { h, app, project } = await slackHarness();

  // Nothing pending: "ok" is just the word the intent router reads as
  // `approve`, and approve-without-a-task-id has to ask.
  const alone = await cmd(app, "ok");
  assert.match(alone.text, /not sure what you meant/i);

  // With a stop outstanding, the same word answers it.
  const task = await queuedTask(h, { project });
  await cmd(app, `stop ${task.id}`);
  const confirmed = await cmd(app, "ok");
  assert.match(confirmed.text, /Stopped/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
});

// --- model and effort --------------------------------------------------------

test("parseModelSpec separates model from effort", () => {
  assert.deepEqual(parseModelSpec("model TASK-ABCD glm-5.2 high"), { model: "glm-5.2", effort: "high" });
  assert.deepEqual(parseModelSpec("model TASK-ABCD glm-5.2-max"), { model: "glm-5.2-max", effort: null });
  assert.deepEqual(parseModelSpec("model TASK-ABCD high"), { model: null, effort: "high" });
});

test("changing the model rewrites the plan and reports the concrete pick", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  const res = await cmd(app, `model ${task.id} glm-5.2 high`);
  assert.match(res.text, /zai\/glm-5\.2/);
  assert.match(res.text, /high/);
  const stored = await h.repos.tasks.get(task.id);
  assert.deepEqual(stored.model_policy.preferred, ["glm-5.2-high"]);
});

test("a model with nothing behind it is refused instead of parking the task", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  const before = await h.repos.tasks.get(task.id);
  const res = await cmd(app, `model ${task.id} gpt-9`);
  assert.match(res.text, /no catalog entry/i);
  assert.match(res.text, /Available:/);
  const after = await h.repos.tasks.get(task.id);
  assert.deepEqual(after.model_policy, before.model_policy, "the plan must not change");
});

test("an ambiguous model names the choices rather than picking one", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  // glm-5.2 exists at both high and max in the sample catalog.
  const res = await cmd(app, `model ${task.id} glm-5.2`);
  assert.match(res.text, /matches 2 entries/);
  assert.match(res.text, /glm-5\.2-high/);
  assert.match(res.text, /glm-5\.2-max/);
});

// --- stop, re-model, run again ------------------------------------------------

test("the full loop: stop, change the model, run it again", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });

  await cmd(app, `stop ${task.id}`);
  await cmd(app, "yes");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);

  await cmd(app, `model ${task.id} glm-5.2-max`);
  const ran = await cmd(app, `run ${task.id}`);
  assert.match(ran.text, /Running/);

  const after = await h.repos.tasks.get(task.id);
  // Back in play — QUEUED, or already picked up and parked on a resource the
  // harness doesn't provide. What matters is that it is no longer BLOCKED.
  assert.notEqual(after.status, Status.BLOCKED);
  assert.deepEqual(after.model_policy.preferred, ["glm-5.2-max"]);
  // BLOCKED must have travelled via RESUMABLE, so the pause stays visible.
  const history = await h.store.all(
    `SELECT payload FROM event_log WHERE subject_id = ? ORDER BY seq`,
    [task.id],
  );
  const statuses = history.map((r) => JSON.parse(r.payload).to).filter(Boolean);
  assert.ok(statuses.includes(Status.RESUMABLE), `expected RESUMABLE in ${statuses.join(",")}`);
});

test("run refuses a task that is already moving", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  const res = await cmd(app, `run ${task.id}`);
  assert.match(res.text, /nothing to start/i);
});

// --- misc ---------------------------------------------------------------------

test("queue lists what is waiting without needing a task id", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  const res = await cmd(app, "queue");
  assert.match(res.text, new RegExp(task.id));
  assert.equal(classify("queue").action, Action.QUEUE);
});

test("an unknown task is reported rather than crashing the handler", async () => {
  const { app } = await slackHarness();
  for (const text of ["status TASK-NOPE", "model TASK-NOPE glm-5.2-max", "run TASK-NOPE", "stop TASK-NOPE"]) {
    const res = await cmd(app, text);
    assert.match(res.text, /don't know a task/i, text);
  }
});

test("status carries the approval buttons when one is pending", async () => {
  const { h, app, project } = await slackHarness();
  const task = await queuedTask(h, { project });
  await h.repos.approvals.create({ taskId: task.id, level: "L3", question: "Allow Bash?", options: ["APPROVE", "REJECT"] });
  const res = await cmd(app, `status ${task.id}`);
  const actions = res.blocks?.find((b) => b.type === "actions");
  assert.ok(actions, "an open approval should render buttons");
  assert.deepEqual(actions.elements.map((e) => e.action_id), ["approve", "reject"]);
});
