// P4-12 intent routing + the Slack surface, and status reconciliation.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, parseDuration, Intent, Action } from "../../src/interface/intent.mjs";
import { createSlackSurface } from "../../src/interface/slack.mjs";
import { createReconciler } from "../../src/runtime/reconciler.mjs";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics, queuedTask, Clock } from "../helpers/harness.mjs";

// --- intent ------------------------------------------------------------------

test("explicit commands classify with high confidence", () => {
  const cases = [
    ["task fix the login bug", Intent.WORK, Action.CREATE],
    ["status TASK-ABCD", Intent.TASK, Action.STATUS],
    ["approve TASK-ABCD", Intent.TASK, Action.APPROVE],
    ["expedite TASK-ABCD 30m", Intent.TASK, Action.EXPEDITE],
    ["lanjutkan TASK-ABCD tambahkan test", Intent.TASK, Action.CONTINUE],
  ];
  for (const [text, intent, action] of cases) {
    const r = classify(text);
    assert.equal(r.intent, intent, text);
    assert.equal(r.action, action, text);
    assert.ok(r.confidence >= 0.9, text);
  }
});

test("the bot prefix is stripped", () => {
  assert.equal(classify("@semanggi status TASK-ABCD").action, Action.STATUS);
});

test("task ids may be given as #code or bare code — normalized to TASK-", () => {
  // 8 hex digits is the shape shortId("TASK") produces; anything looser
  // would harvest commit hashes and prose into task ids.
  assert.equal(classify("status #4F59F63A").taskId, "TASK-4F59F63A");
  assert.equal(classify("status 4F59F63A").taskId, "TASK-4F59F63A");
  assert.equal(classify("stop task-4f59f63a").taskId, "TASK-4F59F63A");
  // Already-complete ids are not double-prefixed.
  assert.equal(classify("status TASK-4F59F63A").taskId, "TASK-4F59F63A");
  // Lowercase 8-hex words are indistinguishable from prose — left alone.
  assert.equal(classify("cek commit deadbeef di repo").taskId, null);
  // The normalized id is what handlers receive in `text` too.
  assert.match(classify("status #4F59F63A").text, /TASK-4F59F63A/);
});

test("P4-12: an unclassifiable message asks rather than acts", () => {
  for (const text of ["do the needful", "", "??? whatever"]) {
    const r = classify(text);
    assert.equal(r.intent, Intent.CONFIRM, `"${text}" must not become an action`);
    assert.ok(r.confidence < 0.6);
  }
});

test("a task verb without a task id asks which task", () => {
  const r = classify("approve");
  assert.equal(r.intent, Intent.CONFIRM);
  assert.equal(r.action, Action.APPROVE);
  assert.match(r.reason, /needs a task id/);
});

test("a bare task id is a guess, so it is confirmed not executed", () => {
  const r = classify("TASK-ABCD");
  assert.equal(r.intent, Intent.CONFIRM);
  assert.equal(r.taskId, "TASK-ABCD");
});

test("small talk is CHAT and touches nothing", () => {
  assert.equal(classify("halo").intent, Intent.CHAT);
  assert.equal(classify("thanks").intent, Intent.CHAT);
});

test("durations parse in both languages", () => {
  assert.equal(parseDuration("expedite TASK-A 30m"), 30 * 60 * 1000);
  assert.equal(parseDuration("expedite TASK-A 2 jam"), 2 * 3600 * 1000);
  assert.equal(parseDuration("expedite TASK-A"), null);
});

// --- slack surface -----------------------------------------------------------

async function slackHarness() {
  const clock = new Clock();
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h);
  const slack = createSlackSurface(h, { defaultProjectId: project.id });
  return { h, slack, project, worker, clock };
}

test("`task ...` queues work and reports where it landed", async () => {
  const { h, slack } = await slackHarness();
  const res = await slack.handle({ text: "task write the runbook", user: "satria" });
  assert.match(res.text, /Queued \*TASK-/);
  const tasks = await h.repos.tasks.list({});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "write the runbook");
});

test("`status` explains why a task is waiting", async () => {
  const { h, slack, project } = await slackHarness();
  const task = await queuedTask(h, { project, worker: null, title: "orphan" });
  await h.scheduler.notify();
  const res = await slack.handle({ text: `status ${task.id}` });
  assert.match(res.text, /WAIT_WORKER/);
  assert.match(res.text, /no worker assigned/);
});

test("`expedite` boosts with a TTL and says so", async () => {
  const { h, slack, project, worker } = await slackHarness();
  const task = await queuedTask(h, { project, worker, title: "t", priority: 4 });
  const res = await slack.handle({ text: `expedite ${task.id} 45m`, user: "satria" });
  assert.match(res.text, /45 minutes/);
  const after = await h.repos.tasks.get(task.id);
  assert.ok(after.expedite_until > h.clock.now());
  assert.equal(after.priority, 4, "priority itself is untouched");
});

test("`approve` records the decision against the Slack user", async () => {
  const { h, slack, project, worker } = await slackHarness();
  const task = await queuedTask(h, { project, worker, title: "deploy", approvalLevel: "L3" });
  await h.scheduler.notify();
  const res = await slack.handle({ text: `approve ${task.id}`, user: "satria" });
  assert.match(res.text, /APPROVE/);
  const [decided] = await h.repos.approvals.decidedForTask(task.id);
  assert.equal(decided.decided_by, "satria");
});

test("an unknown task is reported, not invented", async () => {
  const { slack } = await slackHarness();
  const res = await slack.handle({ text: "status TASK-NOPE" });
  assert.match(res.text, /don't know a task/);
});

test("an ambiguous message produces a question with usage hints", async () => {
  const { slack } = await slackHarness();
  const res = await slack.handle({ text: "please sort it out" });
  assert.match(res.text, /not sure what you meant/);
  assert.match(res.text, /status TASK-XXXX/);
});

test("the approval notification tells the operator exactly how to answer", async () => {
  const { h, slack, project, worker } = await slackHarness();
  const task = await queuedTask(h, { project, worker, title: "migrate", approvalLevel: "L3" });
  await h.scheduler.notify();
  const [approval] = await h.repos.approvals.pendingForTask(task.id);
  const note = slack.approvalNotification(approval, task);
  assert.match(note.text, /ACTION REQUIRED/);
  assert.match(note.text, new RegExp(`approve ${task.id}`));
  assert.match(note.text, new RegExp(`reject ${task.id}`));
});

// --- reconciliation (D72: gateway session projection is the source) ----------

async function dispatched() {
  const clock = new Clock();
  const h = await buildHarness({ clock });
  const { project, worker } = await seedBasics(h, { maxConcurrent: 5 });
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  return { h, clock, task, execution };
}

/** The same wiring main.mjs does: a real sink owns the describe→verdict map. */
async function makeReconciler(h, sessions) {
  const { createSessionEventSink } = await import("../../src/runtime/session-events.mjs");
  const sink = createSessionEventSink({
    repos: h.repos, events: h.events, scheduler: h.scheduler,
    runtime: { connect: async () => ({}), request: async () => ({}) },
  });
  const keys = Object.keys(sessions);
  return createReconciler({
    repos: h.repos,
    events: h.events,
    runtime: {
      describeSession: async ({ key }) => (keys.includes(key) ? sessions[key] : null),
      abortRun: async () => ({ ok: true, aborted: false, status: "no-active-run" }),
    },
    applyDescribe: (execution, session) => sink.applyDescribe(execution, session),
    now: h.clock.now,
  });
}

test("a gateway 'done' session settles COMPLETE — the lost-end rescue (D72)", async () => {
  const { h, task, execution } = await dispatched();
  const rec = await makeReconciler(h, {
    [execution.session_key]: {
      status: "done", startedAt: 1, endedAt: 2, inputTokens: 100, outputTokens: 40,
      sessionId: "sess-1", abortedLastRun: false,
    },
  });
  const out = await rec.reconcileOnce();

  assert.equal(out.settled.length, 1);
  const exec = await h.repos.executions.get(execution.id);
  assert.equal(exec.status, ExecutionStatus.COMPLETE);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
  assert.equal(exec.tokens_input, 100, "describe token totals are recorded when none were");
  assert.equal(exec.tokens_output, 40);
  assert.equal(exec.session_ref, "sess-1", "our own agent: key is upgraded to the gateway sessionId");
  assert.equal((await h.repos.leases.list()).length, 0, "the workspace must be released");
});

test("a gateway 'running' session is activity proof, not staleness (D71)", async () => {
  const { h, clock, task, execution } = await dispatched();
  const rec = await makeReconciler(h, {
    [execution.session_key]: { status: "running", startedAt: 1 },
  });

  const before = execution.last_event_at ?? execution.created_at;
  clock.advance(45 * 60 * 1000);
  const out = await rec.reconcileOnce();
  assert.equal(out.alive.length, 1);
  const after = await h.repos.executions.get(execution.id);
  assert.ok(after.last_event_at > before, "the activity clock is refreshed");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED, "live is live, at any age");
  // And the refreshed clock is exactly what keeps the watchdog from parking.
  const stalled = await h.repos.executions.stalled(clock.now() - 30 * 60 * 1000);
  assert.equal(stalled.length, 0, "a describe-refreshed run is not stalled");
});

test("an unreadable session leaves the task alone", async () => {
  const { h, task } = await dispatched();
  const rec = await makeReconciler(h, {});
  const out = await rec.reconcileOnce();
  assert.equal(out.unknown.length, 1);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED, "silence is not evidence");
});

test("killed/failed evidence rescues nothing and condemns nothing", async () => {
  // TASK-2C56D3A8: the gateway's own projection says the last run of the
  // session died (context overflow -> killed). That is evidence for an
  // operator, not a verdict — the reconciler rescues (done) or records,
  // and only a human condemns.
  const { h, task, execution } = await dispatched();
  const rec = await makeReconciler(h, {
    [execution.session_key]: { status: "killed", endedAt: 2, abortedLastRun: true },
  });
  const out = await rec.reconcileOnce();
  assert.equal(out.settled.length, 0);
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.DISPATCHED);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
});

test("a BLOCKED task whose run is STILL live is aborted (concurrency invariant)", async () => {
  // The user-visible hazard this whole change exists for: parked BLOCKED
  // while the agent kept running frees the model slot, the worker slot and
  // the workspace — admission then over-commits the provider. The reconciler
  // enforces "BLOCKED ⇒ not running at the gateway".
  const { h, task, execution } = await dispatched();
  let abortedKey = null;
  const { createSessionEventSink } = await import("../../src/runtime/session-events.mjs");
  const sink = createSessionEventSink({
    repos: h.repos, events: h.events, scheduler: h.scheduler,
    runtime: { connect: async () => ({}), request: async () => ({}) },
  });
  const rec = createReconciler({
    repos: h.repos,
    events: h.events,
    runtime: {
      describeSession: async () => ({ status: "running", startedAt: 1 }),
      abortRun: async ({ sessionKey }) => {
        abortedKey = sessionKey;
        return { ok: true, aborted: true, status: "aborted" };
      },
    },
    applyDescribe: (execution, session) => sink.applyDescribe(execution, session),
    now: h.clock.now,
  });
  await h.repos.executions.setStatus(execution.id, ExecutionStatus.BLOCKED, { result: "watchdog parked" });
  await h.repos.tasks.setStatus(task.id, Status.BLOCKED, { reason: "watchdog parked" });

  const out = await rec.reconcileOnce();
  assert.ok(out.stragglers.includes(execution.id));
  assert.equal(abortedKey, execution.session_key, "the live run under a BLOCKED task is aborted at the gateway");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED, "the task stays where a human decides");
});

test("old BLOCKED rows fall out of the scan window", async () => {
  const { h, clock, task, execution } = await dispatched();
  const rec = await makeReconciler(h, {
    [execution.session_key]: { status: "running", startedAt: 1 },
  });
  await h.repos.executions.setStatus(execution.id, ExecutionStatus.BLOCKED, { result: "old code parked this" });
  await h.repos.tasks.setStatus(task.id, Status.BLOCKED, { reason: "old code parked this" });

  // Default window is a day — a straggler from the last day of old-code
  // parking is still the reconciler's business; one from two days back is not.
  clock.advance(25 * 60 * 60 * 1000);
  const out = await rec.reconcileOnce();
  assert.equal(out.stragglers.length, 0, "a straggler older than the window is not described");
});

test("the pass is self-gating: finalized or keyless executions are not described", async () => {
  const { h, task, execution } = await dispatched();
  let describeCalls = 0;
  const rec = createReconciler({
    repos: h.repos,
    events: h.events,
    runtime: {
      describeSession: async () => {
        describeCalls += 1;
        return { status: "done", endedAt: 1 };
      },
    },
    applyDescribe: async () => ({ handled: false }),
    now: h.clock.now,
  });
  await h.fake.completeExecution(execution.id);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
  const out = await rec.reconcileOnce();
  assert.equal(describeCalls, 0, "a finalized execution is not the reconciler's business");
  assert.equal(out.settled.length, 0);
});

// --- the chat surface must be reachable --------------------------------------
// It was implemented and wired into main.mjs but had no route, so nothing could
// ever call it. An interface with no door is not an interface.
test("the chat surface is reachable over HTTP and honours the token", async () => {
  const { createApi } = await import("../../src/api/server.mjs");
  const { once } = await import("node:events");
  const { createSlackSurface } = await import("../../src/interface/slack.mjs");

  const h = await buildHarness();
  const { project } = await seedBasics(h);
  h.slack = createSlackSurface(h, { defaultProjectId: project.id });

  const api = createApi(h, { token: "tok" });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const post = (body, token = "tok") =>
    fetch(`http://127.0.0.1:${port}/api/work/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  try {
    assert.equal((await post({ text: "status TASK-X" }, null)).status, 401);
    assert.equal((await post({})).status, 400);

    const created = await (await post({ text: "task write the runbook", user: "satria" })).json();
    assert.match(created.reply, /Queued \*TASK-/);
    assert.equal((await h.repos.tasks.list({})).length, 1);

    const vague = await (await post({ text: "please sort it out" })).json();
    assert.match(vague.reply, /not sure what you meant/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// Deklarasi intent eksplisit "WORK:" / "TASK:" — tombol template Command
// Center menyisipkannya, dan ditemukan live 2026-09-05: teks "WORK: Baca
// semua dokumen…" jatuh ke CONFIRM "could not classify" karena "work" bukan
// verb dan "TASK:" mati di batas verb yang menuntut whitespace. Operator yang
// MENYATAKAN intent tidak boleh diturunkan ke pertanyaan.
test("prefix WORK:/TASK: adalah deklarasi intent, bukan tebiasa", () => {
  const work = classify("WORK: Baca semua dokumen di memory/blueprint.md, memory/decisions.md, docs/architecture.md (jika ada). Buat rencana implementasi.");
  assert.equal(work.intent, Intent.WORK);
  assert.equal(work.action, Action.CREATE);
  assert.equal(work.confidence, 1, "operator yang menyatakan intent tidak menugaskan router menebak");
  assert.equal(work.text, "Baca semua dokumen di memory/blueprint.md, memory/decisions.md, docs/architecture.md (jika ada). Buat rencana implementasi.");
  assert.equal(work.hasVerbPrefix, false, "payload tanpa verb — jangan buang kata pertamanya");

  const task = classify("TASK: Perbaiki bug kecil pada footer");
  assert.equal(task.intent, Intent.TASK);
  assert.equal(task.action, Action.CREATE);
  assert.equal(task.text, "Perbaiki bug kecil pada footer");
});

test("sintaks slash /work /task /task adalah bentuk utama deklarasi intent", () => {
  const work = classify("/work Baca semua dokumen dan buat rencana implementasi.");
  assert.equal(work.intent, Intent.WORK);
  assert.equal(work.action, Action.CREATE);
  assert.equal(work.confidence, 1);
  assert.equal(work.text, "Baca semua dokumen dan buat rencana implementasi.");

  const prepare = classify("/prepare daftarkan semua tasks yang ada di docs/tasks.md");
  assert.equal(prepare.intent, Intent.PREPARE);
  assert.equal(prepare.action, Action.CREATE);

  // Verba task-scope setelah /task tetap menjadi perintah, bukan payload.
  const status = classify("/task status TASK-1234");
  assert.equal(status.intent, Intent.TASK);
  assert.equal(status.action, Action.STATUS);
  assert.equal(status.taskId, "TASK-1234");

  const stop = classify("/task stop #4F59F63A");
  assert.equal(stop.action, Action.PAUSE);
  assert.equal(stop.taskId, "TASK-4F59F63A");

  // "/task" kosong tetap bertanya; "/taskX" bukan prefix (batas kata).
  assert.equal(classify("/task").intent, Intent.CONFIRM);
  assert.notEqual(classify("/taskxyz sesuatu").intent, Intent.TASK);
});

test("prefix dengan payload kosong tetap bertanya, bukan beraksi", () => {
  const r = classify("WORK:");
  assert.equal(r.intent, Intent.CONFIRM);
  assert.match(r.reason, /empty/);
});

test("verb task-scope di dalam prefix tetap dihormati", () => {
  const r = classify("WORK: status TASK-1234");
  assert.equal(r.intent, Intent.TASK);
  assert.equal(r.action, Action.STATUS);
  assert.equal(r.taskId, "TASK-1234");
});

test("prefix PREPARE: deklarasi intent persiapan dokumen rencana", () => {
  const r = classify("PREPARE: Baca semua dokumen di memory/blueprint.md dan docs/brief.md. Buat docs/plans.md dan docs/tasks.md.");
  assert.equal(r.intent, Intent.PREPARE);
  assert.equal(r.action, Action.CREATE);
  assert.equal(r.confidence, 1);
  assert.equal(r.text, "Baca semua dokumen di memory/blueprint.md dan docs/brief.md. Buat docs/plans.md dan docs/tasks.md.");
  assert.equal(classify("PREPARE:").intent, Intent.CONFIRM, "payload kosong tetap bertanya");
});
