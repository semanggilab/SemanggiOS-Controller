// D15: turning gateway session events into terminal executions.
//
// The event shapes below are copied from frames captured on the live cluster,
// not invented — see docs/decisions.md D15.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { createSessionEventSink, classifyRunEnd, usageFromMessage } from "../../src/runtime/session-events.mjs";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";

function endEvent(runId, { stopReason = "stop", aborted = false, sessionId = "sess-uuid" } = {}) {
  return [
    "agent",
    {
      runId,
      stream: "lifecycle",
      sessionKey: "agent:w:task",
      sessionId,
      data: { phase: "end", startedAt: 1000, endedAt: 2000, aborted, stopReason },
    },
  ];
}

async function sinkFor(h) {
  return createSessionEventSink({
    repos: h.repos,
    events: h.events,
    runtime: { connect: async () => ({}), request: async () => ({ subscribed: true }) },
    scheduler: h.scheduler,
  });
}

test("classification distinguishes finished, aborted and stopped-short runs", () => {
  assert.equal(classifyRunEnd({ stopReason: "stop" }).task, Status.COMPLETE);
  // Aborted is checked first: an abort can still carry stopReason "stop", and
  // reading that as success would mark unfinished work complete.
  assert.equal(classifyRunEnd({ stopReason: "stop", aborted: true }).task, Status.CANCELLED);
  // Ran to an end that is not completion: a human should look, and the task
  // stays resumable rather than being buried as FAILED.
  assert.equal(classifyRunEnd({ stopReason: "max_tokens" }).task, Status.BLOCKED);
  assert.equal(classifyRunEnd({}).task, Status.BLOCKED);
});

test("a lifecycle end drives the execution and task terminal", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);

  const sink = await sinkFor(h);
  await sink.handle(...endEvent(execution.id));

  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
  const done = await h.repos.executions.get(execution.id);
  assert.equal(done.status, ExecutionStatus.COMPLETE);
  assert.ok(done.finalized_at, "reaching a terminal status freezes the row");
});

test("the run's own session id is recorded so CONTINUE can resume it", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  const sink = await sinkFor(h);
  await sink.handle(...endEvent(execution.id, { sessionId: "4ca451bf-9980-4691-ac50-783aefb99b78" }));
  assert.equal((await h.repos.executions.get(execution.id)).session_ref, "4ca451bf-9980-4691-ac50-783aefb99b78");
});

test("the workspace lease is released, so the next task can run", async () => {
  // Without this the queue deadlocks: the lease outlives the run and every
  // later task on that workspace parks on WAIT_WORKSPACE forever.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;
  assert.ok(await h.repos.leases.get(path), "held while running");

  const sink = await sinkFor(h);
  await sink.handle(...endEvent(execution.id));
  assert.equal(await h.repos.leases.get(path), null);
});

test("usage seen before the end is written against the execution", async () => {
  // session.message arrives just before the lifecycle end, so usage is held and
  // written once, at the end — not twice, and not after the row is frozen.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  const sink = await sinkFor(h);
  // Correlated by sessionKey — session.message carries no runId.
  await sink.handle("session.message", {
    sessionKey: "agent:w:task",
    message: { usage: { input_tokens: 8, output_tokens: 1303, cache_read_input_tokens: 92663, cache_creation_input_tokens: 31860 } },
  });
  await sink.handle(...endEvent(execution.id));

  const done = await h.repos.executions.get(execution.id);
  assert.equal(h.repos.executions.billableTokens(done), 125834);
  assert.equal(done.cost_unit, "tokens");
});

test("events for runs we do not own are ignored, not invented", async () => {
  // The gateway streams every session, including ones started by an operator
  // in the TUI. Creating records for those would corrupt the audit trail.
  const h = await buildHarness();
  const sink = await sinkFor(h);
  const res = await sink.applyEnd("someone-elses-run", { phase: "end", stopReason: "stop" }, {});
  assert.equal(res.handled, false);
  assert.match(res.reason, /unknown execution/);
});

test("a replayed end event is ignored once the execution is final", async () => {
  // The reconciler is kept as a slow path, so the same completion can arrive
  // twice. The second must not error and must not rewrite a frozen row.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  const sink = await sinkFor(h);
  await sink.handle(...endEvent(execution.id));
  const again = await sink.applyEnd(execution.id, { phase: "end", stopReason: "stop" }, {});
  assert.equal(again.handled, false);
  assert.match(again.reason, /already final/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
});

test("non-lifecycle chatter is ignored", async () => {
  const h = await buildHarness();
  const sink = await sinkFor(h);
  // Streaming deltas, ticks and health frames all arrive on the same socket.
  for (const [n, p] of [
    ["agent", { runId: "x", stream: "assistant", data: { text: "hi" } }],
    ["tick", { ts: 1 }],
    ["health", { ok: true }],
    ["agent", { runId: "x", stream: "lifecycle", data: { phase: "start" } }],
  ]) {
    await sink.handle(n, p);
  }
  assert.equal(sink.pendingUsageSize, 0);
});

test("usage extraction tolerates both field spellings", () => {
  assert.equal(usageFromMessage({ message: { usage: { input_tokens: 5 } } }).input_tokens, 5);
  assert.equal(usageFromMessage({ usage: { inputTokens: 7 } }).input_tokens, 7);
  assert.equal(usageFromMessage({}), null);
});

test("an inherited session ref survives; only our own sessionKey is replaced", async () => {
  // CONTINUE/FORK point an execution at a real session id from an earlier run.
  // Overwriting that with the current run's id would silently re-anchor the
  // task to a different conversation.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  await h.repos.executions.update(execution.id, { session_ref: "inherited-uuid-from-earlier-run" });

  const sink = await sinkFor(h);
  await sink.handle(...endEvent(execution.id, { sessionId: "brand-new-uuid" }));
  assert.equal((await h.repos.executions.get(execution.id)).session_ref, "inherited-uuid-from-earlier-run");
});

// ── Usage accounting: the shapes the gateway actually sends ──────────────

test("usage is read from the gateway's own field names", () => {
  // Measured on the cluster. None of the Anthropic-style spellings appear, and
  // guessing them is what made every execution report zero.
  const u = usageFromMessage({
    message: { usage: { input: 10157, output: 37, totalTokens: 10322, cacheRead: 128, cacheWrite: 0, cost: { total: 0.01236712 } } },
  });
  assert.equal(u.input_tokens, 10157);
  assert.equal(u.output_tokens, 37);
  assert.equal(u.cache_read_input_tokens, 128);
  assert.equal(u.cache_creation_input_tokens, 0);
  assert.equal(u.providerCostUsd, 0.01236712);
  // 10157 + 37 + 128 = 10322, matching the gateway's own totalTokens.
  assert.equal(u.input_tokens + u.output_tokens + u.cache_read_input_tokens, 10322);
});

test("the POC-3 batch spelling still works", () => {
  // `claude -p --output-format json` reports the other shape; both are real.
  const u = usageFromMessage({ usage: { input_tokens: 8, output_tokens: 1303, cache_read_input_tokens: 92663, cache_creation_input_tokens: 31860 } });
  assert.equal(u.input_tokens, 8);
  assert.equal(u.cache_read_input_tokens, 92663);
  assert.equal(u.providerCostUsd, null);
});

test("usage is correlated through sessionKey, because session.message has no runId", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const sessionKey = "agent:doc-worker:task-x";

  const sink = await sinkFor(h);
  // Exactly what the wire sends: no runId anywhere in this frame.
  await sink.handle("session.message", {
    sessionKey,
    message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } },
  });
  await sink.handle("agent", {
    runId: execution.id,
    stream: "lifecycle",
    sessionKey,
    data: { phase: "end", stopReason: "stop", aborted: false },
  });

  const done = await h.repos.executions.get(execution.id);
  assert.equal(h.repos.executions.billableTokens(done), 125);
});

test("a metered provider's own cost is recorded in USD; tokens remain the quota unit", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const sessionKey = "agent:doc-worker:task-y";

  const sink = await sinkFor(h);
  await sink.handle("session.message", {
    sessionKey,
    message: { usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.25 } } },
  });
  await sink.handle("agent", { runId: execution.id, stream: "lifecycle", sessionKey, data: { phase: "end", stopReason: "stop" } });

  const done = await h.repos.executions.get(execution.id);
  assert.equal(done.cost, 0.25);
  assert.equal(done.cost_unit, "usd");
  assert.equal(h.repos.executions.billableTokens(done), 125, "tokens are still what the quota window counts");
});

test("a subscription plan ignores the provider's USD estimate", async () => {
  // POC-3 E8: on a Pro plan that number corresponds to no invoice. Recording it
  // as cost would make the cheapest-looking runs the ones burning the window.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await h.repos.resources.upsert({ provider: "google", model: "gemini-flash", creditClass: "subscription", concurrencyLimit: 4 });
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const sessionKey = "agent:doc-worker:task-z";

  const sink = await sinkFor(h);
  await sink.handle("session.message", { sessionKey, message: { usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.25 } } } });
  await sink.handle("agent", { runId: execution.id, stream: "lifecycle", sessionKey, data: { phase: "end", stopReason: "stop" } });

  const done = await h.repos.executions.get(execution.id);
  assert.equal(done.cost_unit, "tokens");
  assert.equal(done.cost, 125);
});

test("an all-zero usage frame is not recorded as a free run", async () => {
  // Measured: gemini-3.1-flash-lite reports {"input":0,...,"cost":{"total":0}}
  // while glm-5.1 on the same wire reports real numbers. Writing the zeros
  // through would read as "this run cost nothing" instead of "this provider
  // does not report usage".
  const { isEmptyUsage } = await import("../../src/runtime/session-events.mjs");
  assert.equal(isEmptyUsage(usageFromMessage({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } })), true);
  assert.equal(isEmptyUsage(usageFromMessage({ usage: { input: 10157, output: 37, cacheRead: 128 } })), false);

  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const sessionKey = "agent:doc-worker:silent";

  const sink = await sinkFor(h);
  await sink.handle("session.message", { sessionKey, message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
  await sink.handle("agent", { runId: execution.id, stream: "lifecycle", sessionKey, data: { phase: "end", stopReason: "stop" } });

  const done = await h.repos.executions.get(execution.id);
  assert.equal(done.cost_unit, "tokens", "no bogus usd unit from an empty frame");
  assert.equal(done.cost, 0);
});

// ── Late dispatch refusals (D47) ─────────────────────────────────────────
// The gateway can accept a dispatch and then refuse the run at start, sending
// a second res frame the adapter surfaces as "gateway.late-error". Incident
// TASK-E28D15F3/TASK-BFA56024: without a handler, the execution sat
// DISPATCHED with zero tokens for thirty minutes until the watchdog blocked
// it with a generic message, and every resume re-dispatched into the same
// silent wall.

test("a late refusal blocks the execution immediately, with the real reason", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;
  assert.ok(await h.repos.leases.get(path), "held while dispatched");

  const sink = await sinkFor(h);
  const res = await sink.applyLateError({
    runId: execution.id,
    error: { code: "UNAVAILABLE", message: 'Thinking level "max" is not supported for zai/glm-5.2. Use one of: off.' },
  });
  assert.equal(res.handled, true);

  const done = await h.repos.executions.get(execution.id);
  assert.equal(done.status, ExecutionStatus.BLOCKED);
  assert.match(done.result, /Thinking level "max" is not supported/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
  assert.equal(await h.repos.leases.get(path), null, "the lease must not outlive the refused run");
});

test("a late refusal reaches the sink through handle() like any other event", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  const sink = await sinkFor(h);
  await sink.handle("gateway.late-error", { runId: execution.id, error: { code: "UNAVAILABLE", message: "refused" } });
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.BLOCKED);
});

test("a late refusal for an unknown execution is ignored, not invented", async () => {
  const h = await buildHarness();
  const sink = await sinkFor(h);
  const res = await sink.applyLateError({ runId: "someone-elses-run", error: { message: "refused" } });
  assert.equal(res.handled, false);
  assert.match(res.reason, /unknown execution/);
});

test("a late refusal cannot condemn a finalized or already-running execution", async () => {
  // A refusal that arrives late must not race the truth: an execution that
  // already ended (or is provably running) has its own events deciding it.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  const sink = await sinkFor(h);
  await sink.handle(...endEvent(execution.id));
  const tooLate = await sink.applyLateError({ runId: execution.id, error: { message: "refused" } });
  assert.equal(tooLate.handled, false);
  assert.match(tooLate.reason, /already final/);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.COMPLETE);
});

// ── Transcript capture by dispatched session key (D48) ────────────────────
// Incident TASK-E28D15F3/TASK-BFA56024: both tasks ran for minutes — read
// documents, reasoned, wrote deliverables — and their transcripts recorded
// NOTHING but the operator's instruction. Usage survived (it is keyed in
// memory by the event's own session key) while message correlation matched
// only session_ref, and a CONTINUE revision sends a composite key
// (`…:s<inherited ref>`) that session_ref never holds.

test("a mid-run message is captured by the dispatched session key, not only session_ref", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  // What dispatch actually sent: a composite CONTINUE key the stored
  // session_ref does not contain.
  const sentKey = `agent:doc-worker:${task.id}:sagent:doc-worker:${task.id}:r1`.toLowerCase();
  await h.repos.executions.update(execution.id, { session_key: sentKey });

  const sink = await sinkFor(h);
  await sink.handle("session.message", {
    sessionKey: sentKey,
    messageSeq: 1,
    message: { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "here is the analysis" }] },
  });

  const rows = await h.repos.messages.listByExecution(execution.id);
  assert.equal(rows.length, 1, "the message must land on the execution that dispatched the key");
  assert.equal(rows[0].content, "here is the analysis");
  assert.ok(rows[0].blocks, "the raw blocks survive alongside the flattened text");
});

test("messages for a shared session key land on the execution still in flight", async () => {
  // CONTINUE revisions reuse one session key by design, so the key alone
  // never names a single execution — the live one must win, or a redelivered
  // message would attach to a finished revision and read as history it never
  // was.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const first = await h.repos.executions.latest(task.id);
  const sharedKey = `agent:doc-worker:${task.id}:r1`.toLowerCase();
  await h.repos.executions.update(first.id, { session_key: sharedKey });
  const firstSink = await sinkFor(h);
  await firstSink.handle(...endEvent(first.id));
  assert.equal((await h.repos.executions.get(first.id)).status, ExecutionStatus.COMPLETE);

  // Second revision, same conversation key.
  await h.repos.tasks.createRevision(task.id, { sessionMode: "CONTINUE", instruction: "again", actor: "test" });
  await h.scheduler.notify();
  const second = await h.repos.executions.latest(task.id);
  assert.notEqual(second.id, first.id);
  await h.repos.executions.update(second.id, { session_key: sharedKey });

  const sink = await sinkFor(h);
  await sink.handle("session.message", {
    sessionKey: sharedKey,
    messageSeq: 9,
    message: { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "second revision speaking" }] },
  });

  assert.equal((await h.repos.messages.listByExecution(second.id)).length, 1, "the live revision takes the message");
  const firstRows = await h.repos.messages.listByExecution(first.id);
  assert.ok(firstRows.every((m) => m.content !== "second revision speaking"), "the finished revision keeps its own history");
});

// ── Structured tool lifecycle frames (D48) ────────────────────────────────
// connect advertises the `tool-events` cap so the gateway sends `session.tool`
// frames — the tool results the transcript used to lose. Their shape is not
// documented, so message-shaped payloads go through the normal message path
// and anything else is preserved raw rather than dropped.

test("a message-shaped session.tool frame is recorded like any message", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const sentKey = `agent:doc-worker:${task.id}:r1`.toLowerCase();
  await h.repos.executions.update(execution.id, { session_key: sentKey });

  const sink = await sinkFor(h);
  await sink.handle("session.tool", {
    sessionKey: sentKey,
    messageSeq: 5,
    message: { role: "toolResult", timestamp: Date.now(), content: [{ type: "text", text: "total 72\ndrwxr-xr-x 2 kubus kubus" }] },
  });

  const rows = await h.repos.messages.listByExecution(execution.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "toolResult");
  assert.match(rows[0].content, /total 72/);
});

test("an unknown-shape session.tool frame is preserved raw, not dropped", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const sentKey = `agent:doc-worker:${task.id}:r1`.toLowerCase();
  await h.repos.executions.update(execution.id, { session_key: sentKey });

  const sink = await sinkFor(h);
  await sink.handle("session.tool", {
    sessionKey: sentKey,
    toolName: "exec",
    status: "completed",
    output: "file written",
  });

  const rows = await h.repos.messages.listByExecution(execution.id);
  assert.equal(rows.length, 1, "a frame whose shape we do not know still lands in the transcript");
  const blocks = JSON.parse(rows[0].blocks);
  assert.equal(blocks[0].type, "toolEvent");
  assert.equal(blocks[0].toolName, "exec");
  assert.equal(blocks[0].payload.output, "file written", "the raw payload survives for the UI to render");
});
