// D51: quota reset windows belong to the Brain, and a per-minute window makes
// a quota refusal retryable in place — park WAIT_QUOTA for one window, up to
// ten times, before blocking. Every shape here was chosen against the gap it
// closes: before D51 a late quota error blocked the task immediately AND never
// recorded the resource signal, so the next task hit the same wall blind.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { createSessionEventSink } from "../../src/runtime/session-events.mjs";
import {
  QUOTA_RETRY_LIMIT,
  RESOURCE_RETRY_LIMIT,
  describeWindow,
  isQuotaErrorMessage,
  isRetryableWindow,
  isTransientRuntimeError,
  parseQuotaReset,
  resourceRetryBackoffMs,
} from "../../src/domain/quota-windows.mjs";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";

// The exact vocabulary Google uses on a per-minute exhaustion — no 429 code in
// the message, no "rate limit" phrase. The old detector let all of it through.
const GEMINI_RPM_MESSAGE =
  'Resource has been exhausted: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}';

function sinkFor(h) {
  return createSessionEventSink({
    repos: h.repos,
    events: h.events,
    runtime: { connect: async () => ({}), request: async () => ({ subscribed: true }) },
    scheduler: h.scheduler,
    // D51: without brains the sink cannot know a window is retry-sized; the
    // wiring under test is exactly this parameter. The clock matters as much:
    // a sink built without it prices the retry ETA in real wall time and the
    // test's controllable clock never sees it come due.
    brains: h.brains,
    now: h.now,
  });
}

async function lateQuotaError(h, execution, message = GEMINI_RPM_MESSAGE) {
  const sink = await sinkFor(h);
  await sink.handle("gateway.late-error", {
    runId: execution.id,
    error: { code: "RESOURCE_EXHAUSTED", message },
  });
}

// --- pure helpers -----------------------------------------------------------

test("quota detection recognises Gemini's vocabulary, not just rate-limit phrasing", () => {
  assert.ok(isQuotaErrorMessage(GEMINI_RPM_MESSAGE));
  assert.ok(isQuotaErrorMessage("429 Too Many Requests"));
  assert.ok(isQuotaErrorMessage("You've hit your session limit"));
  assert.equal(isQuotaErrorMessage("model not found"), false);
  assert.equal(isQuotaErrorMessage(""), false);
  assert.equal(isQuotaErrorMessage(null), false);
});

test("only windows shorter than ten minutes are retryable in place", () => {
  // D52: the threshold is dynamic — any provider whose shortest window is
  // under ten minutes gets retry-in-place, not just per-minute Gemini.
  assert.equal(isRetryableWindow(60_000), true);
  assert.equal(isRetryableWindow(300_000), true, "a 5-minute window is worth one wait");
  assert.equal(isRetryableWindow(600_000), false, "the threshold is strict: exactly 10 minutes is not under it");
  assert.equal(isRetryableWindow(18_000_000), false, "a 5-hour window takes the backoff path instead");
  assert.equal(isRetryableWindow(null), false);
  assert.equal(QUOTA_RETRY_LIMIT, 10);
});

test("transient runtime errors are detected separately from quota", () => {
  assert.equal(isTransientRuntimeError("model runner is UNAVAILABLE"), true);
  assert.equal(isTransientRuntimeError("gateway overloaded, try again later"), true);
  assert.equal(isTransientRuntimeError("HTTP 503"), true);
  // Rate limit is quota's vocabulary — it carries a reset schedule and is
  // classified there, never here.
  assert.equal(isTransientRuntimeError("rate limit exceeded"), false);
  assert.equal(isTransientRuntimeError("model not found"), false);
});

test("resource backoff doubles from 30s and caps at 15 minutes", () => {
  assert.equal(resourceRetryBackoffMs(0), 30_000);
  assert.equal(resourceRetryBackoffMs(1), 60_000);
  assert.equal(resourceRetryBackoffMs(2), 120_000);
  assert.equal(resourceRetryBackoffMs(99), 15 * 60_000);
  assert.equal(RESOURCE_RETRY_LIMIT, 5);
});

test("reset metadata survives being embedded in an error string", () => {
  const { resetsAt, rateLimitType } = parseQuotaReset(
    'session limit reached, "resetsAt":1787113200, "rateLimitType":"per_minute"',
  );
  assert.equal(resetsAt, 1787113200);
  assert.equal(rateLimitType, "per_minute");
  assert.deepEqual(parseQuotaReset("no metadata here"), { resetsAt: null, rateLimitType: null });
});

test("windows render operator-facing labels", () => {
  assert.equal(describeWindow(60_000), "per-minute");
  assert.equal(describeWindow(18_000_000), "5-hour");
  assert.equal(describeWindow(86_400_000), "daily");
  assert.equal(describeWindow(604_800_000), "weekly");
  assert.equal(describeWindow(null), null);
});

// --- late-error path (session-events) ---------------------------------------

test("a per-minute late refusal parks WAIT_QUOTA for one window, not BLOCKED", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gemini-rpm" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;

  await lateQuotaError(h, execution);

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_QUOTA, "a wall that clears in 60s is waited out, not died on");
  assert.equal(parked.quota_retries, 1);
  assert.equal(parked.next_retry_at, h.clock.now() + 60_000, "no resetsAt in the message: one short window");
  assert.equal((await h.repos.executions.get(execution.id)).status, ExecutionStatus.FAILED);
  // The signal gap is the other half of D51: the resource used to stay
  // AVAILABLE through all of this.
  const resource = await h.repos.resources.get("google", "gemini-flash");
  assert.equal(resource.availability, "QUOTA_EXHAUSTED");
  assert.equal(resource.next_available_at, h.clock.now() + 60_000, "task and resource share one clock");
  assert.equal(await h.repos.leases.get(path), null, "the failed attempt must not hold the workspace");
});

test("a provider resetsAt in the message wins over the window default", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gemini-eta" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  // resetsAt in epoch seconds, embedded exactly like the gateway relays it.
  const resetsAt = Math.floor(h.clock.now() / 1000) + 45;
  await lateQuotaError(h, execution, `quota exceeded "resetsAt":${resetsAt} "rateLimitType":"per_minute"`);

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_QUOTA);
  assert.equal(parked.next_retry_at, resetsAt * 1000);
});

test("the eleventh per-minute refusal blocks the task, naming the count", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gemini-cap" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  await h.store.run(`UPDATE tasks SET quota_retries = ? WHERE id = ?`, [QUOTA_RETRY_LIMIT, task.id]);
  await lateQuotaError(h, execution);

  const blocked = await h.repos.tasks.get(task.id);
  assert.equal(blocked.status, Status.BLOCKED);
  assert.match(blocked.wait_reason ?? "", /exhausted/);
  // The count did not tick past the limit while giving up.
  assert.equal(blocked.quota_retries, QUOTA_RETRY_LIMIT);
});

test("a 5-hour late refusal parks WAIT_RESOURCE with backoff, not BLOCKED", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  // glm-4.7 is zai: 5-hour short window — over the retry threshold, so the
  // D52 transient path applies: backoff + its own counter, not a block.
  const task = await queuedTask(h, { project, worker, title: "glm-wall", modelPolicy: { preferred: ["glm-4.7"] } });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  await lateQuotaError(h, execution, 'session limit reached, "resetsAt":1787113200, "rateLimitType":"five_hour"');

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RESOURCE, "a long-window wall is waited out with backoff, not died on");
  assert.equal(parked.resource_retries, 1);
  assert.equal(parked.next_retry_at, h.clock.now() + 30_000, "first transient backoff is 30s");
  assert.equal(parked.quota_retries, 0, "the quota counter is not spent by the transient path");
  const resource = await h.repos.resources.get("zai", "glm-4.7");
  assert.equal(resource.availability, "QUOTA_EXHAUSTED", "the signal used to be skipped on this path entirely");
});

test("an UNAVAILABLE late refusal takes the same WAIT_RESOURCE backoff path", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "unavailable" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  await lateQuotaError(h, execution, "model runner is currently UNAVAILABLE");

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RESOURCE);
  assert.equal(parked.resource_retries, 1);
  assert.equal(parked.next_retry_at, h.clock.now() + 30_000);
  // Not a quota event: the resource entry must stay AVAILABLE — no window is
  // known, and manufacturing one would misroute every other task on it.
  const resource = await h.repos.resources.get("google", "gemini-flash");
  assert.equal(resource.availability, "AVAILABLE");
});

test("the sixth transient refusal blocks the task, naming the count", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "unavailable-cap" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  await h.store.run(`UPDATE tasks SET resource_retries = ? WHERE id = ?`, [RESOURCE_RETRY_LIMIT, task.id]);
  await lateQuotaError(h, execution, "gateway overloaded");

  const blocked = await h.repos.tasks.get(task.id);
  assert.equal(blocked.status, Status.BLOCKED);
  assert.match(blocked.wait_reason ?? "", /resource retries exhausted/);
});

test("WAIT_RESOURCE from a late refusal re-dispatches once the backoff passes", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "unavailable-retry" });
  await h.scheduler.notify();
  const first = await h.repos.executions.latest(task.id);
  await lateQuotaError(h, first, "model runner is currently UNAVAILABLE");
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_RESOURCE);

  h.clock.advance(31_000);
  await h.scheduler.notify();

  const again = await h.repos.tasks.get(task.id);
  assert.equal(again.status, Status.DISPATCHED, "the backoff expires and the queue moves on its own");
  assert.equal(again.resource_retries, 1, "the count persists across the re-dispatch");
});

test("a non-quota late refusal is untouched by the retry machinery", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "plain-refusal" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  await lateQuotaError(h, execution, "model not found");

  const blocked = await h.repos.tasks.get(task.id);
  assert.equal(blocked.status, Status.BLOCKED);
  assert.equal(blocked.quota_retries, 0, "the counter counts quota attempts, not refusals in general");
  assert.equal(blocked.resource_retries, 0, "a definitive refusal gets no retry budget");
});

// --- retry lifecycle --------------------------------------------------------

test("the window closing re-dispatches, and success resets the count", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gemini-retry" });
  await h.scheduler.notify();
  const first = await h.repos.executions.latest(task.id);
  await lateQuotaError(h, first);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_QUOTA);

  // One window passes; the scheduler's quota pass releases the resource and
  // the queue moves without an operator.
  h.clock.advance(61_000);
  await h.scheduler.notify();

  const again = await h.repos.tasks.get(task.id);
  assert.equal(again.status, Status.DISPATCHED, "parked for exactly one window, then re-dispatched");
  assert.equal(again.quota_retries, 1, "the count survives a re-dispatch; it measures the streak");

  // The second attempt gets through: COMPLETE wipes the streak.
  const sink = await sinkFor(h);
  await sink.handle("agent", {
    runId: (await h.repos.executions.latest(task.id)).id,
    stream: "lifecycle",
    sessionKey: "agent:w:task",
    sessionId: "sess-after-retry",
    data: { phase: "end", startedAt: 1, endedAt: 2, stopReason: "stop" },
  });
  const done = await h.repos.tasks.get(task.id);
  assert.equal(done.status, Status.COMPLETE);
  assert.equal(done.quota_retries, 0, "success starts the count over");
});

test("a revision resets the count too — the operator decided, not the window", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gemini-revise" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  await lateQuotaError(h, execution);
  await h.store.run(`UPDATE tasks SET quota_retries = 7 WHERE id = ?`, [task.id]);

  await h.repos.tasks.createRevision(task.id, { sessionMode: "FRESH", instruction: "again" });

  assert.equal((await h.repos.tasks.get(task.id)).quota_retries, 0);
});

// --- admission dispatch-throw path ------------------------------------------

test("a per-minute refusal thrown at dispatch counts and blocks at the limit", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gemini-throw" });

  const quotaError = () => {
    const err = new Error("HTTP 429");
    err.status = 429;
    err.quota = { provider: "google", model: "gemini-flash", status: 429, message: "quota exceeded" };
    return err;
  };
  h.fake.failNextDispatch(quotaError());
  await h.scheduler.notify();

  let parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_QUOTA);
  assert.equal(parked.quota_retries, 1);
  assert.equal(parked.next_retry_at, h.clock.now() + 60_000, "no provider ETA: the window is the clock");

  // Nine more failures would be nine more parks; the tenth total refusal —
  // quota_retries already at the limit — must block instead.
  await h.store.run(`UPDATE tasks SET quota_retries = ? WHERE id = ?`, [QUOTA_RETRY_LIMIT, task.id]);
  h.fake.failNextDispatch(quotaError());
  h.clock.advance(61_000);
  await h.scheduler.notify();

  const blocked = await h.repos.tasks.get(task.id);
  assert.equal(blocked.status, Status.BLOCKED);
  assert.match(blocked.wait_reason ?? "", /exhausted/);
});
