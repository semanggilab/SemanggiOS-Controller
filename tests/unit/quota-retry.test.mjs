// D51: quota reset windows belong to the Brain, and a per-minute window makes
// a quota refusal retryable in place — park WAIT_QUOTA for one window, up to
// ten times, before blocking. Every shape here was chosen against the gap it
// closes: before D51 a late quota error blocked the task immediately AND never
// recorded the resource signal, so the next task hit the same wall blind.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask, Clock } from "../helpers/harness.mjs";
import { createSessionEventSink } from "../../src/runtime/session-events.mjs";
import {
  QUOTA_RETRY_LIMIT,
  QUOTA_WINDOWS_BY_PROVIDER,
  RESOURCE_RETRY_LIMIT,
  describeWindow,
  isQuotaErrorMessage,
  isRetryableWindow,
  isTransientRuntimeError,
  parseQuotaReset,
  parseUsageLimitReset,
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

test("groq and cerebras reset per-minute + daily, in Gemini's family (D59)", () => {
  // They bill like Gemini: a wall that clears in 60 seconds must not take the
  // 5-hour backoff path. Before D59 both rode the subscription package.
  for (const provider of ["groq", "cerebras"]) {
    assert.deepEqual(
      QUOTA_WINDOWS_BY_PROVIDER[provider],
      { shortMs: 60_000, longMs: 86_400_000 },
      `${provider} follows the per-minute + daily schedule`,
    );
    assert.equal(isRetryableWindow(QUOTA_WINDOWS_BY_PROVIDER[provider].shortMs), true);
  }
  // The subscription family keeps its own schedule — this change moves
  // providers between families, it does not redefine the families.
  assert.deepEqual(QUOTA_WINDOWS_BY_PROVIDER.zai, { shortMs: 18_000_000, longMs: 604_800_000 });
  assert.deepEqual(QUOTA_WINDOWS_BY_PROVIDER["claude-code"], { shortMs: 18_000_000, longMs: 604_800_000 });
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

// --- D63: provider drivers in the runtime paths ------------------------------

test("a groq 413 structural wall blocks immediately — no window climbs it (D63)", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "groq-wall" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  const path = (await h.repos.tasks.get(task.id)).workspace_path;
  // The groq brain is not seeded; relabel the live execution so the late
  // error classifies through the groq driver — exactly the measured D62
  // shape: 413, x-should-retry:false, Limit/Requested in the body.
  await h.store.run(`UPDATE executions SET model_provider = 'groq', model_id = 'qwen3.6-27b' WHERE id = ?`, [execution.id]);

  await lateQuotaError(h, execution, "Request Entity Too Large: Limit 7000, Requested 20011");

  const blocked = await h.repos.tasks.get(task.id);
  assert.equal(blocked.status, Status.BLOCKED, "a structural wall is not waited out");
  assert.match(blocked.wait_reason ?? "", /input-token window/);
  assert.equal(blocked.quota_retries, 0, "the quota budget is not spent on a wall no window clears");
  assert.equal(blocked.resource_retries, 0, "nor is the transient budget — five backoffs would end in the same refusal");
  // No wedged resource either: the blocked tasks are the operator-visible
  // evidence, not a QUOTA_EXHAUSTED row with no release clock.
  assert.equal(await h.repos.resources.get("groq", "qwen3.6-27b"), null);
  assert.equal(await h.repos.leases.get(path), null);
});

test("a clockless dispatch refusal on a long window parks at the driver's long ETA (D63)", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "glm-eta", modelPolicy: { preferred: ["glm-4.7"] } });

  const quotaError = () => {
    const err = new Error("HTTP 429");
    err.status = 429;
    // No resetsAt, no rateLimitType: the provider said nothing about time.
    err.quota = { provider: "zai", model: "glm-4.7", status: 429, message: "quota exceeded" };
    return err;
  };
  h.fake.failNextDispatch(quotaError());
  await h.scheduler.notify();

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_QUOTA);
  // Before D63 this parked with nextRetryAt null, which park() replaced with
  // a 30s failure-count backoff — a weekly credits window released like a
  // hiccup. The zai driver prices the LONG window: no cycle anchor known, so
  // the conservative full window from now.
  assert.equal(parked.next_retry_at, h.clock.now() + 7 * 24 * 3_600_000, "the driver's long window is the clock");
});

// --- D87: reset clock parsed out of the 8.2 refusal text ---------------------

test("parseUsageLimitReset resolves the harness wall clock's zone with its own window (D87)", () => {
  // event_log seq 123115, terukur 2026-09-08: penolakan ZAI. Dibaca sebagai
  // UTC delta-nya 11.37 jam — di luar jendela 5 jam; harness host mencetak
  // UTC+7 (delta 4.37 jam). Jendelanya sendiri yang memilih zonanya.
  const ev1 = parseUsageLimitReset(
    "⚠️ Usage limit reached for 5 hour. Your limit will reset at 2026-09-09 03:34:02",
    Date.parse("2026-09-08T16:12:01.027Z"),
  );
  assert.equal(ev1.resetMs, Date.parse("2026-09-08T20:34:02Z"));
  assert.equal(ev1.offsetMs, 7 * 3_600_000);
  assert.equal(ev1.windowMs, 5 * 3_600_000);
  assert.equal(ev1.windowKind, "5_hour");

  // event_log seq 116639, sumber kedua yang independen: offset yang sama.
  const ev2 = parseUsageLimitReset(
    "⚠️ Usage limit reached for 5 hour. Your limit will reset at 2026-09-08 22:17:50",
    Date.parse("2026-09-08T13:11:24.152Z"),
  );
  assert.equal(ev2.resetMs, Date.parse("2026-09-08T15:17:50Z"));
  assert.equal(ev2.offsetMs, 7 * 3_600_000);
});

test("a wall clock that already reads UTC is taken as UTC (D87)", () => {
  const ev = parseUsageLimitReset(
    "Usage limit reached for 5 hour. Your limit will reset at 2026-09-08 13:00:00",
    Date.parse("2026-09-08T10:00:00Z"),
  );
  assert.equal(ev.resetMs, Date.parse("2026-09-08T13:00:00Z"));
  assert.equal(ev.offsetMs, 0);
});

test("an unresolvable clock is discarded but the window survives (D87)", () => {
  // Jam dinding 35 jam di depan untuk jendela 5 jam: tidak ada zona yang
  // masuk akal — teks ini bukan jam provider ini (pelajaran salah-rute D85).
  const ev = parseUsageLimitReset(
    "Usage limit reached for 5 hour. Your limit will reset at 2026-09-10 03:34:02",
    Date.parse("2026-09-08T16:12:01Z"),
  );
  assert.equal(ev.resetMs, null);
  assert.equal(ev.windowMs, 5 * 3_600_000);
  assert.equal(ev.windowKind, "5_hour");
  assert.equal(ev.offsetMs, null);
});

test("the POC-3 explicit-UTC session-limit clock needs no disambiguation (D87)", () => {
  // Terukur POC-3 E8: "You've hit your session limit · resets 9:40am (UTC)".
  const morning = parseUsageLimitReset(
    "You've hit your session limit · resets 9:40am (UTC)",
    Date.parse("2026-09-08T03:00:00Z"),
  );
  assert.equal(morning.resetMs, Date.parse("2026-09-08T09:40:00Z"));
  assert.equal(morning.offsetMs, 0);
  // Jam itu sudah lewat hari ini → besok (24-jam tanpa am/pm juga diterima).
  const evening = parseUsageLimitReset(
    "You've hit your session limit · resets 14:22 (UTC)",
    Date.parse("2026-09-08T15:00:00Z"),
  );
  assert.equal(evening.resetMs, Date.parse("2026-09-09T14:22:00Z"));
});

test("clock-less refusals parse to nothing (D87)", () => {
  // Bentuk google yang terukur (FailoverError): tanpa jam, tanpa jendela.
  assert.equal(
    parseUsageLimitReset("FailoverError: ⚠️ API rate limit reached. Please try again later.", 1e15),
    null,
  );
  assert.equal(parseUsageLimitReset("quota exceeded", 1e15), null);
  assert.equal(parseUsageLimitReset(null, 1e15), null);
});

test("applyQuotaSignal anchors the parsed wall clock, not the 7-day family window (D87)", async () => {
  const clock = new Clock(Date.parse("2026-09-08T16:12:01Z"));
  const h = await buildHarness({ clock });
  await seedBasics(h);
  // Jam dinding naif 9 jam di depan clock: 2 jam nyata + offset cetak UTC+7.
  const naive = new Date(clock.now() + 9 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  await h.repos.resources.applyQuotaSignal("zai", "glm-4.7", {
    status: 429,
    message: `⚠️ Usage limit reached for 5 hour. Your limit will reset at ${naive}`,
  });
  const row = await h.repos.resources.get("zai", "glm-4.7");
  assert.equal(row.availability, "QUOTA_EXHAUSTED");
  // D84 would have anchored 7 days; the parsed clock says 2 hours.
  assert.equal(row.next_available_at, clock.now() + 2 * 3_600_000);
  assert.equal(row.window_kind, "5_hour");
  // Baris ini dilepaskan oleh pass jendela pada jam itu — bukan menunggu
  // probe pemulihan menyembuhkan jangkar 7-hari yang terlalu konservatif.
  clock.advance(2 * 3_600_000 + 1);
  await h.scheduler.notify();
  const released = await h.repos.resources.get("zai", "glm-4.7");
  assert.equal(released.availability, "AVAILABLE");
});

test("applyQuotaSignal keeps the D84 family fallbacks for text without a usable clock (D87)", async () => {
  const h = await buildHarness();
  await seedBasics(h);
  // Bentuk google yang terukur: keluarga per-menit → satu menit (D84).
  await h.repos.resources.applyQuotaSignal("google", "gemini-flash", {
    status: 429,
    message: "FailoverError: ⚠️ API rate limit reached. Please try again later.",
  });
  let row = await h.repos.resources.get("google", "gemini-flash");
  assert.equal(row.next_available_at, h.now() + 60_000);
  assert.equal(row.window_kind, null);
  // Teks kuota tanpa jam sama sekali: jendela panjang keluarga (D84).
  await h.repos.resources.applyQuotaSignal("zai", "glm-4.7", { status: 429, message: "quota exceeded" });
  row = await h.repos.resources.get("zai", "glm-4.7");
  assert.equal(row.next_available_at, h.now() + 7 * 24 * 3_600_000);
});

// --- D88: jangkar mingguan tetap Anthropic (Senin 02:00 WIB) ------------------

test("weekly-scale refusal text anchors the next Monday 02:00 WIB, not now+7d (D88)", async () => {
  const clock = new Clock(Date.parse("2026-09-09T12:00:00Z")); // Rabu
  const h = await buildHarness({ clock });
  await seedBasics(h);
  await h.repos.resources.upsert({ provider: "claude-code", model: "claude-code" });
  // Teks mingguan tanpa jam yang bisa diselesaikan (offset tidak lolos):
  // jendela ≥ 6 hari pada keluarga ber-reset-tetap → jam Senin berikutnya.
  await h.repos.resources.applyQuotaSignal("claude-code", "claude-code", {
    status: 429,
    message: "⚠️ Usage limit reached for 7 day. Your limit will reset at 2026-10-01 00:00:00",
  });
  const row = await h.repos.resources.get("claude-code", "claude-code");
  assert.equal(row.availability, "QUOTA_EXHAUSTED");
  assert.equal(row.next_available_at, Date.parse("2026-09-13T19:00:00Z"), "Senin 02:00 WIB");
  assert.equal(row.window_kind, "7_day");
  // Dilepaskan pass jendela pada jam Senin itu — bukan 7 hari dari sinyal.
  clock.advance(Date.parse("2026-09-13T19:00:00Z") - clock.now() + 1);
  await h.scheduler.notify();
  assert.equal((await h.repos.resources.get("claude-code", "claude-code")).availability, "AVAILABLE");
});

test("clockless claude-code signal parks at the next Monday, tighter than the 7-day envelope (D88)", async () => {
  const clock = new Clock(Date.parse("2026-09-09T12:00:00Z"));
  const h = await buildHarness({ clock });
  await seedBasics(h);
  await h.repos.resources.upsert({ provider: "claude-code", model: "claude-code" });
  await h.repos.resources.applyQuotaSignal("claude-code", "claude-code", {
    status: 429,
    message: "quota exceeded",
  });
  const row = await h.repos.resources.get("claude-code", "claude-code");
  // D84 would say now+7d (2026-09-16T12:00Z); the fixed reset is Monday
  // 2026-09-13T19:00Z — strictly earlier, and the honest ceiling for BOTH
  // the 5h and the weekly wall of this family.
  assert.equal(row.next_available_at, Date.parse("2026-09-13T19:00:00Z"));
});

test("zai keeps the rolling 7-day envelope — its weekly cycle is an anniversary, not a wall clock (D88)", async () => {
  const h = await buildHarness();
  await seedBasics(h);
  await h.repos.resources.applyQuotaSignal("zai", "glm-4.7", {
    status: 429,
    message: "⚠️ Usage limit reached for 7 day. Your limit will reset at 2026-10-01 00:00:00",
  });
  const row = await h.repos.resources.get("zai", "glm-4.7");
  // Teks mingguan pada keluarga TANPA reset tetap: jendela teks itu sendiri.
  assert.equal(row.next_available_at, h.now() + 7 * 24 * 3_600_000);
});
