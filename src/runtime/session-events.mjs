// Learning that a run finished (D15).
//
// Until this existed, executions stayed DISPATCHED forever: the gateway starts
// the run and then says nothing more that the controller can act on. Three
// sources were tested and only one works on the pinned version —
//
//   agent.wait          a live attach; after the fact it answers
//                       {"status":"timeout","timeoutPhase":"gateway_draining"}
//                       for a run that finished cleanly minutes earlier.
//   /api/snapshot       AgentOS dispatch records only; runs started directly on
//                       the Gateway never appear.
//   sessions.subscribe  works. Measured verbatim while a real run ended:
//
//     {"event":"agent","payload":{
//       "runId":"d15-1787330757967",
//       "stream":"lifecycle",
//       "data":{"phase":"end","stopReason":"stop","aborted":false,
//               "startedAt":1787330758327,"endedAt":1787330764140},
//       "sessionKey":"agent:semanggi-glm-5-1:d15",
//       "sessionId":"4ca451bf-9980-4691-ac50-783aefb99b78"}}
//
// The decisive detail: `runId` IS the `idempotencyKey` we sent, which is the
// execution id. The completion signal ties itself back to the execution with no
// correlation table and no guessing.
//
// THIS IS THE FAST PATH, NOT THE ONLY PATH
//
// A subscription that drops between reconnects silently misses every event in
// the gap, and a controller that trusted it alone would leave those executions
// stranded exactly as before. The snapshot reconciler stays as the slow path.
// Everything here is therefore written to be safely re-run: applying a terminal
// status to an already-finalised execution is expected and ignored, not an
// error.
import { EventKind } from "../domain/events.mjs";
import { ExecutionStatus, Status, canTransition } from "../domain/state-machine.mjs";
import { applyRuntimeFailure } from "../domain/retry.mjs";
import {
  QUOTA_RETRY_LIMIT,
  RESOURCE_RETRY_LIMIT,
  isRetryableWindow,
  isTransientRuntimeError,
  resourceRetryBackoffMs,
} from "../domain/quota-windows.mjs";
import { quotaDriverFor } from "../domain/quota-drivers/index.mjs";
import { nullLogger } from "../domain/logger.mjs";

/**
 * Maps a run outcome onto the execution/task pair.
 *
 * `aborted` is deliberately checked before `stopReason`: an aborted run may
 * still report stopReason "stop", and treating a cancellation as success would
 * mark work complete that nobody finished.
 */
/**
 * Mengembalikan id execution dari `runId` sebuah frame lifecycle.
 *
 * Untuk run biasa, `runId` MEMANG id execution — itulah `idempotencyKey` yang
 * dikirim dispatch, dan seluruh korelasi bergantung padanya.
 *
 * Sesi ACP (D88) memberi bentuk lain. Direkam verbatim dari gateway 2026.8.2
 * sementara sebuah harness berjalan:
 *
 *   "runId": "announce:v1:agent:claude-opus:acp:ee1ba0d6-…:D88-FRAME-PROBE#1",
 *   "sessionKey": "agent:sem-acp-owner:acp-rpc",
 *   "data": { "phase": "end", "stopReason": "stop", "aborted": false }
 *
 * Id execution ada di ujung, di belakang kunci sesi anak. Tanpa dipotong,
 * pencarian execution meleset dan run yang SUKSES terbaca sebagai kegagalan
 * runtime — terukur pada TASK-3E222980: harness menulis berkasnya dengan benar,
 * controller mencatat "run ended: unknown" lalu men-dispatch ulang. Retry itu
 * bukan sekadar berisik; ia menjalankan pekerjaan Claude untuk kedua kalinya.
 *
 * Pemotongan sengaja hanya pada awalan `announce:v1:` dan hanya sampai titik
 * dua TERAKHIR: id execution tidak pernah memuat titik dua, sedangkan kunci
 * sesi selalu memuatnya.
 */
export function executionIdFromRunId(runId) {
  const raw = String(runId ?? "");
  if (!raw.startsWith("announce:v1:")) return runId ?? null;
  const tail = raw.slice(raw.lastIndexOf(":") + 1);
  return tail || null;
}

export function classifyRunEnd({ aborted, stopReason } = {}) {
  if (aborted) return { execution: ExecutionStatus.CANCELLED, task: Status.CANCELLED, reason: "aborted" };
  // Observed terminal reasons: "stop" is the clean one. Anything else — length
  // caps, refusals, tool loops — completed the run without completing the work,
  // so it becomes BLOCKED rather than COMPLETE or FAILED: a human can look at
  // it, and it stays resumable.
  if (stopReason === "stop" || stopReason === "end_turn") {
    return { execution: ExecutionStatus.COMPLETE, task: Status.COMPLETE, reason: stopReason };
  }
  return {
    execution: ExecutionStatus.FAILED,
    task: Status.BLOCKED,
    reason: stopReason ?? "unknown",
  };
}

/**
 * Pulls token counts out of a `session.message` payload.
 *
 * MEASURED, after the first attempt silently recorded zero for every run. The
 * gateway uses none of the Anthropic-style spellings that were guessed at:
 *
 *   "usage": { "input": 10157, "output": 37, "totalTokens": 10322,
 *              "cacheRead": 128, "cacheWrite": 0,
 *              "cost": { "total": 0.01236712 } }
 *
 * (10157 + 37 + 128 = 10322, so `totalTokens` already includes cache reads.)
 *
 * The `input_tokens`/`cache_read_input_tokens` spellings are kept as a fallback
 * because that IS the shape POC-3 measured from `claude -p --output-format json`
 * on the batch path. Both are real; they come from different producers.
 */
export function usageFromMessage(payload = {}) {
  const u = payload?.message?.usage ?? payload?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (...vals) => {
    for (const v of vals) if (Number.isFinite(Number(v))) return Number(v);
    return 0;
  };
  return {
    input_tokens: n(u.input, u.input_tokens, u.inputTokens, u.prompt_tokens),
    output_tokens: n(u.output, u.output_tokens, u.outputTokens, u.completion_tokens),
    cache_read_input_tokens: n(u.cacheRead, u.cache_read_input_tokens, u.cacheReadInputTokens),
    cache_creation_input_tokens: n(u.cacheWrite, u.cache_creation_input_tokens, u.cacheCreationInputTokens),
    // The provider's own money figure, when it gives one. Meaningful for
    // metered providers; meaningless on a subscription plan (POC-3 E8), so the
    // caller decides whether to use it.
    providerCostUsd: Number.isFinite(Number(u.cost?.total)) ? Number(u.cost.total) : null,
  };
}

/**
 * True when a usage object is present but says nothing.
 *
 * Measured: `google/gemini-3.1-flash-lite` through the OpenAI-compatible path
 * reports `{"input":0,"output":0,"totalTokens":0,"cacheRead":0,"cacheWrite":0,
 * "cost":{"total":0}}` — a real frame carrying no information, while
 * `zai/glm-5.1` on the same wire reports 10157/37/128. Writing that through
 * would stamp an execution with a confident "0 tokens, $0.00", which reads as
 * "this run was free" rather than "this provider does not tell us". Not
 * recording it leaves the fields at their default and keeps the difference
 * visible.
 */
export function isEmptyUsage(u) {
  if (!u) return true;
  return (
    u.input_tokens === 0 &&
    u.output_tokens === 0 &&
    u.cache_read_input_tokens === 0 &&
    u.cache_creation_input_tokens === 0 &&
    (u.providerCostUsd === null || u.providerCostUsd === 0)
  );
}

export function createSessionEventSink({
  repos,
  events,
  runtime,
  scheduler,
  // D51: the quota branch needs each model's reset schedule, and the brains
  // table owns it. Optional so the sink stays constructible in tests without
  // seeding a brain — a null brains means quota refusals take the old
  // always-block path, which is still correct for every non-retryable case.
  brains = null,
  // D75: runtime-failure retry budget (see domain/retry.mjs), threaded from
  // the controller's config so the watchdog, this sink and the reconciler
  // count against ONE budget.
  config = {},
  now = () => Date.now(),
  log = nullLogger,
}) {
  // Keyed by sessionKey, NOT runId.
  //
  // This is the bug that made every completed execution report zero tokens:
  // `session.message` carries no `runId` at all. It has sessionKey, sessionId,
  // messageId and messageSeq — so usage has to be correlated through the
  // session, and the lifecycle `end` event (which has both) closes the loop.
  const pendingUsage = new Map();

  // Keyed by runId. OpenClaw 2026.8.2 can emit a PREMATURE lifecycle
  // `end {stopReason:"length"}` when a settled turn fails finalization, then
  // replace the turn with a terminal fallback reply and emit the REAL end
  // (`stop`) ~400ms later — measured live, TASK-4CA0D674#3 2026-09-08: the
  // controller finalized FAILED at 11:50:04.816 on the first frame and the
  // truthful `stop` landed at 11:50:05.197 into the "already final" guard.
  // One flaky turn burned a D75 retry and mislabeled finished work as failure.
  // Non-clean end frames therefore wait out a short grace window here; a newer
  // end frame for the same run supersedes whatever is still waiting. Clean
  // ends (`stop`) and operator aborts stay immediate — nothing corrects them.
  const pendingEnds = new Map(); // runId -> { timer, data, payload }
  const endGraceMs = () => Number(config?.endGraceMs ?? 1500);

  /**
   * The shared tail of every "this run is over, here is the outcome" path:
   * execution status, task follows where the state machine allows, retry
   * reset, lease release, audit event, scheduler wake. Used by the live
   * `end` event (applyEnd) and by the describe-driven rescue (applyDescribe)
   * so the two cannot drift — D57's settle lesson applies to code too.
   */
  async function finalizeRun(execution, verdict, { source, reason, usage = null, sessionId = null, extra = {} }) {
    const runId = execution.id;
    await repos.executions.setStatus(runId, verdict.execution, { result: reason });
    // The run's outcome is recorded on the execution no matter where the task
    // went, but the task only follows where the state machine allows. Two
    // measured shapes of "the task moved on": the watchdog parked it BLOCKED
    // and the real end arrived late (that one is now a legal BLOCKED →
    // COMPLETE — the parking was a guess, this is the truth), and an operator
    // CANCELLED the task while its run was still alive — CANCELLED is a dead
    // end by design, so the task stays abandoned while the execution above
    // says what really happened. Before this check, the forced transition
    // threw inside handle()'s catch-all and the lease release, the audit
    // event and the scheduler wake below were all skipped along with it —
    // which is how TASK-7A3CC32A sat BLOCKED against a COMPLETE execution.
    const taskBefore = await repos.tasks.get(execution.task_id);
    const taskFollows =
      taskBefore && (taskBefore.status === verdict.task || canTransition(taskBefore.status, verdict.task));
    if (taskFollows) {
      await repos.tasks.setStatus(execution.task_id, verdict.task, {
        reason: verdict.task === Status.COMPLETE ? null : `run ended: ${reason}`,
        actor: "session-events",
      });
    } else {
      log.warn("run.ended-task-unmoved", {
        task: execution.task_id, exec: runId,
        taskStatus: taskBefore?.status ?? null, verdict: verdict.task,
      });
    }
    if (taskFollows && verdict.task === Status.COMPLETE) {
      // D51/D52: success starts the retry counts over. A task that got
      // through once does not carry the attempts of the run that finally
      // worked — the counts measure one losing streak, not a task's life.
      await repos.tasks.resetRetries(execution.task_id);
    }

    const task = await repos.tasks.get(execution.task_id);
    if (task?.workspace_path) {
      const lease = await repos.leases.get(task.workspace_path);
      if (lease?.execution_id === runId)
        await repos.leases.release(task.workspace_path, { executionId: runId, actor: "session-events" });
    }

    await events.append({
      kind: EventKind.EXECUTION_STATUS,
      subjectType: "execution",
      subjectId: runId,
      payload: { source, ...extra },
    });

    // A finished run frees a lease, a worker slot and provider concurrency, so
    // the queue should move immediately rather than waiting for the watchdog.
    log.info("run.ended", {
      task: execution.task_id, exec: runId,
      provider: execution.model_provider, model: execution.model_id,
      stopReason: reason,
      taskStatus: task?.status ?? verdict.task,
      tokens: usage
        ? {
            input: usage.input_tokens, output: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
            costUsd: usage.providerCostUsd,
          }
        : null,
      sessionId,
    });
    await scheduler?.notify?.("RUN_ENDED");
    return { handled: true, status: task?.status ?? verdict.task };
  }

  async function applyEnd(runId, data, payload) {
    const execution = await repos.executions.get(runId);
    if (!execution) {
      // Not ours: another operator, the TUI, or a run from a previous
      // controller generation. Ignoring is correct — inventing an execution
      // record for it would corrupt the audit trail.
      return { handled: false, reason: "unknown execution" };
    }
    if (execution.finalized_at) {
      // Measured (2026-09-08): the 2026.8.2 corrected `stop` frame landing
      // here used to vanish silently, which is exactly why the premature
      // `length` above stayed invisible for a whole debugging session.
      log.info("run.ended-ignored", {
        exec: runId, stopReason: data?.stopReason ?? null, aborted: Boolean(data?.aborted),
        lateMs: now() - execution.finalized_at,
        hint: "an end frame arrived after the execution was already final — gateway re-emit or corrected verdict",
      });
      return { handled: false, reason: "already final" };
    }

    const verdict = classifyRunEnd(data);
    const sessionKey = payload?.sessionKey ?? null;
    const usage = sessionKey ? pendingUsage.get(sessionKey) : null;
    if (sessionKey) pendingUsage.delete(sessionKey);

    if (usage) {
      const { providerCostUsd, ...tokens } = usage;
      // A subscription plan's USD figure corresponds to no invoice — it is an
      // API price estimate, and POC-3 E8 settled that tokens against the plan
      // window are what bind. For metered providers the provider's own number
      // is the truthful one, so it is used when we have it.
      const resource = await repos.resources.get(execution.model_provider, execution.model_id);
      const metered = resource?.credit_class !== "subscription";
      await repos.executions.recordUsage(
        runId,
        metered && providerCostUsd !== null ? { ...tokens, cost: providerCostUsd } : tokens,
        metered && providerCostUsd !== null ? { costUnit: "usd" } : {},
      );
    }
    // The gateway's own sessionId is the durable identity; the sessionKey we
    // recorded at dispatch is just our own naming (`agent:<agent>:<task>`) and
    // is worth replacing. An INHERITED ref, however, is a real session id from
    // a previous execution that CONTINUE/FORK deliberately points at, and must
    // survive. The two are distinguishable by shape — only our own keys carry
    // the `agent:` prefix — so that is the discriminator rather than a flag
    // threaded through the dispatch path.
    const storedIsOurOwnKey = typeof execution.session_ref === "string" && execution.session_ref.startsWith("agent:");
    if (payload?.sessionId && (!execution.session_ref || storedIsOurOwnKey)) {
      await repos.executions.update(runId, { session_ref: payload.sessionId });
    }

    // D75: a run that ended abnormally (anything but a clean stop or an
    // operator abort) is a transient failure, not a verdict on the work — the
    // shared retry verdict requeues it with backoff instead of parking BLOCKED
    // for a human to press continue (operator request: auto-recovery). When
    // the budget is exhausted, retry.mjs itself parks BLOCKED and names the
    // streak.
    if (
      verdict.execution === ExecutionStatus.FAILED &&
      verdict.task === Status.BLOCKED &&
      !data?.aborted
    ) {
      const outcome = await applyRuntimeFailure(
        { repos, events, config, log, now },
        { task: { id: execution.task_id }, execution, cause: `run ended: ${verdict.reason}`, source: "sessions.subscribe" },
      );
      await scheduler?.notify?.("RUN_ENDED");
      log.info("run.ended", {
        task: execution.task_id, exec: runId,
        provider: execution.model_provider, model: execution.model_id,
        stopReason: verdict.reason, recovery: outcome,
      });
      return { handled: true, recovery: outcome };
    }

    return finalizeRun(execution, verdict, {
      source: "sessions.subscribe",
      reason: verdict.reason,
      usage,
      sessionId: payload?.sessionId ?? null,
      extra: {
        stopReason: verdict.reason,
        aborted: Boolean(data?.aborted),
        startedAt: data?.startedAt ?? null,
        endedAt: data?.endedAt ?? null,
      },
    });
  }

  /**
   * The describe-driven rescue (D72): the gateway's own session projection
   * says the run finished ("done") while the execution here is still
   * DISPATCHED/RUNNING or parked BLOCKED. That is the shape left behind when
   * the lifecycle `end` frame was lost in a subscription gap — TASK-E2854DB9
   * (gateway logged `ended with stopReason=stop`; the controller never saw
   * it) and TASK-2C56D3A8 sat BLOCKED exactly like this.
   *
   * "done" is the ONLY verdict applied automatically. killed/failed/timeout
   * are evidence an operator should read, not a verdict to condemn with: the
   * reconciler rescues, humans condemn.
   */
  async function applyDescribe(execution, session) {
    if (!execution || !session) return { handled: false, reason: "no execution or session" };
    // Re-read: the caller's copy can be stale (the reconciler reads, then a
    // late end event finalizes the row, then this runs). Writing through a
    // stale copy would fire the immutability trigger — the same race D57
    // taught applyEnd to respect, caught here BEFORE any write.
    const fresh = await repos.executions.get(execution.id);
    if (!fresh) return { handled: false, reason: "unknown execution" };
    if (fresh.finalized_at) return { handled: false, reason: "already final" };
    execution = fresh;
    if (session.status !== "done") return { handled: false, reason: `session status ${session.status}` };

    // describe carries the session's token totals. Write them only when we
    // never recorded per-message usage — overwriting a live reading with a
    // session aggregate would be the same lie D17 caught, in reverse.
    if (
      Number.isFinite(session.inputTokens) || Number.isFinite(session.outputTokens)
    ) {
      const current = await repos.executions.get(execution.id);
      if ((current?.tokens_input ?? 0) === 0 && (current?.tokens_output ?? 0) === 0) {
        await repos.executions.recordUsage(execution.id, {
          input_tokens: Number.isFinite(session.inputTokens) ? session.inputTokens : 0,
          output_tokens: Number.isFinite(session.outputTokens) ? session.outputTokens : 0,
        });
      }
    }
    const storedIsOurOwnKey =
      typeof execution.session_ref === "string" && execution.session_ref.startsWith("agent:");
    if (session.sessionId && (!execution.session_ref || storedIsOurOwnKey)) {
      await repos.executions.update(execution.id, { session_ref: session.sessionId });
    }
    if (Number.isFinite(session.endedAt)) {
      await repos.executions.touch(execution.id, session.endedAt);
    }

    return finalizeRun(
      execution,
      { execution: ExecutionStatus.COMPLETE, task: Status.COMPLETE },
      {
        source: "sessions.describe",
        reason: "done",
        sessionId: session.sessionId ?? null,
        extra: {
          stopReason: "done (gateway session projection)",
          startedAt: session.startedAt ?? null,
          endedAt: session.endedAt ?? null,
          abortedLastRun: Boolean(session.abortedLastRun),
        },
      },
    );
  }

  /**
   * A dispatch the gateway accepted and then refused once it tried to start
   * the run — the second `res` frame, surfaced by the adapter as
   * `gateway.late-error` with the execution id it tracked at send time.
   *
   * Mirrors the dispatch watchdog's verdict (execution BLOCKED, task BLOCKED,
   * lease released) but lands in milliseconds with the REAL reason instead of
   * thirty minutes later with "no runtime event". Before this existed the
   * refusal was logged and dropped, and every resume re-dispatched into the
   * same silent wall — the TASK-E28D15F3/TASK-BFA56024 incident (D47).
   */
  async function applyLateError(payload) {
    const runId = executionIdFromRunId(payload?.runId) ?? null;
    const message = payload?.error?.message ?? JSON.stringify(payload?.error ?? {});
    const execution = runId ? await repos.executions.get(runId) : null;
    if (!execution) {
      // Same rule as applyEnd: not ours, so nothing to condemn.
      return { handled: false, reason: "unknown execution" };
    }
    if (execution.finalized_at) return { handled: false, reason: "already final" };
    // Only an execution still waiting for its first sign of life can be
    // condemned by a late refusal. One already RUNNING has a live run whose
    // own events decide its fate; blocking it here would race the truth.
    if (execution.status !== ExecutionStatus.DISPATCHED) {
      return { handled: false, reason: `not awaiting first event (${execution.status})` };
    }

    // Frees the workspace for whichever attempt comes next — a retry in the
    // quota branch, or a revision in the blocked one. Either way this run is
    // over and must not hold the path.
    const releaseLease = async () => {
      const task = await repos.tasks.get(execution.task_id);
      if (task?.workspace_path) {
        const lease = await repos.leases.get(task.workspace_path);
        if (lease?.execution_id === runId) {
          await repos.leases.release(task.workspace_path, { executionId: runId, actor: "gateway-late-error" });
        }
      }
    };

    // D51: a quota refusal that surfaces here used to block the task AND skip
    // applyQuotaSignal — the worst of both: the task died for a reason the
    // scheduler never learned, so the resource stayed AVAILABLE and the next
    // task walked into the same wall. Now the signal is always recorded, and
    // for models whose SHORT reset window is under ten minutes (D52; any
    // provider, not just per-minute ones) the task parks in WAIT_QUOTA for
    // exactly one window instead of dying, up to QUOTA_RETRY_LIMIT times.
    //
    // POC-6 (D63): classification moved into the provider driver — the same
    // generic vocabulary as before (a driver may only ADD to it), plus fatal
    // patterns a window can never fix: groq's 413 "Limit N, Requested M"
    // structural wall and any 402 payment_required. The driver also prices
    // the retry ETA, so a fixed-time window (google RPD) parks until the real
    // wall-clock reset instead of a guessed duration.
    const driver = quotaDriverFor(execution.model_provider);
    const verdict = driver.classifyError({ text: message });
    const quota = verdict?.kind === "quota";
    const providerFatal = verdict?.kind === "fatal" ? verdict : null;
    let retryable = false;
    if (quota) {
      const resetsAt = verdict.resetsAt ?? null;
      const rateLimitType = verdict.rateLimitType ?? null;
      const brain = brains ? await brains.forModel(execution.model_provider, execution.model_id) : null;
      const shortMs = brain?.quotaResetShortMs ?? null;
      retryable = isRetryableWindow(shortMs);
      try {
        await repos.resources.applyQuotaSignal(execution.model_provider, execution.model_id, {
          status: 429,
          // When the message carries no clock and the window is retry-sized,
          // the window itself is the clock — and it must anchor the RESOURCE
          // too: releaseExpiredQuota only flips a QUOTA_EXHAUSTED entry whose
          // next_available_at exists, so a signal without one would wedge the
          // model for every task, not just this one.
          resetsAt: resetsAt ?? (retryable ? now() + shortMs : null),
          rateLimitType,
          message: String(message).slice(0, 300),
        });
      } catch (err) {
        // The signal routes OTHER tasks around the wall; this task's own
        // handling must not depend on it succeeding.
        log.error("quota.signal-failed", { exec: runId, error: String(err.message).slice(0, 200) });
      }

      if (retryable) {
        const current = await repos.tasks.get(execution.task_id);
        const retries = current?.quota_retries ?? 0;
        if (retries < QUOTA_RETRY_LIMIT) {
          // The provider's own reset time wins when it gave one; otherwise
          // the driver prices the window — rolling from the hit, fixed-time
          // at its next wall-clock occurrence — never a bare guess. The
          // signal clock arrives as epoch seconds OR millis, so the driver
          // normalises before comparing to now().
          const eta =
            driver.nextReset(
              { kind: brain?.quotaShortType ?? null, ms: shortMs },
              { nowMs: now(), resetsAt: resetsAt ?? null, lastSignalAt: now() },
            ) ?? now() + shortMs;
          const retryDetail = `quota retry ${retries + 1}/${QUOTA_RETRY_LIMIT}: ${message}`;
          await repos.executions.setStatus(runId, ExecutionStatus.FAILED, {
            result: `dispatch refused after accept: ${message}`,
          });
          await repos.tasks.setStatus(execution.task_id, Status.WAIT_QUOTA, {
            reason: retryDetail,
            waitDetail: retryDetail,
            actor: "gateway-late-error",
          });
          await repos.tasks.bumpQuotaRetry(execution.task_id, eta);
          await releaseLease();
          await events.append({
            kind: EventKind.QUOTA_DECISION,
            subjectType: "task",
            subjectId: execution.task_id,
            payload: {
              source: "gateway.late-error",
              executionId: runId,
              decision: "wait",
              quotaRetry: retries + 1,
              limit: QUOTA_RETRY_LIMIT,
              nextRetryAt: eta,
              error: payload?.error ?? null,
            },
          });
          log.warn("quota.late-retry", {
            task: execution.task_id, exec: runId,
            provider: execution.model_provider, model: execution.model_id,
            attempt: retries + 1, limit: QUOTA_RETRY_LIMIT,
            nextRetryAt: eta,
            error: String(message).slice(0, 300),
          });
          await scheduler?.notify?.("RUN_ENDED");
          return { handled: true, status: Status.WAIT_QUOTA, quotaRetry: retries + 1 };
        }
        // Fall through: the quota retry budget is spent; blocking below names
        // the count so it cannot look identical to a first refusal.
        await blockLateError(
          execution,
          runId,
          payload,
          `quota retries exhausted (${QUOTA_RETRY_LIMIT}x, ${execution.model_provider}/${execution.model_id}): ${message}`,
          { quotaRetriesExhausted: retries },
        );
        return { handled: true, status: Status.BLOCKED, quotaRetriesExhausted: true };
      }
    }

    // Provider-fatal verdicts sit ABOVE the transient path, not inside it: a
    // wall no window can climb (groq's 413 structural input limit, a 402 from
    // a spent trial) parked as "runtime refused" burns five rounds of backoff
    // that all end in the identical refusal — noise that looks like an outage.
    // Block once, with the driver's reason naming the actual fix. No
    // applyQuotaSignal here: the resource keeps its clock-driven state, and
    // the blocked tasks in the queue are the visible evidence an operator
    // acts on (wedges without a release clock are invisible by design —
    // releaseExpiredQuota can't flip what has no next_available_at).
    if (providerFatal) {
      await blockLateError(
        execution,
        runId,
        payload,
        `${providerFatal.reason ?? "provider fatal"} (${execution.model_provider}/${execution.model_id}): ${message}`,
        { providerFatal: true, structural: Boolean(providerFatal.structural) },
      );
      log.warn("quota.provider-fatal", {
        task: execution.task_id, exec: runId,
        provider: execution.model_provider, model: execution.model_id,
        reason: providerFatal.reason ?? null,
        structural: Boolean(providerFatal.structural),
        error: String(message).slice(0, 300),
      });
      return { handled: true, status: Status.BLOCKED, providerFatal: true };
    }

    // D52: a late refusal that is TRANSIENT — a rate limit on a long window,
    // UNAVAILABLE, overloaded — describes a runtime that cannot serve us
    // RIGHT NOW, not work that cannot be done. Blocking on the first frame
    // killed tasks for outages that cleared before an operator looked. These
    // park in WAIT_RESOURCE with exponential backoff and their own, smaller
    // limit: five attempts over ~15 minutes of waiting, then block with the
    // count named. Anything else (a definitive refusal — bad model, bad
    // request) is not going to fix itself and blocks immediately.
    if (quota || isTransientRuntimeError(message)) {
      const current = await repos.tasks.get(execution.task_id);
      const retries = current?.resource_retries ?? 0;
      if (retries < RESOURCE_RETRY_LIMIT) {
        const backoff = resourceRetryBackoffMs(retries);
        const eta = now() + backoff;
        const retryDetail = `runtime refused, retrying in ${Math.round(backoff / 1000)}s (${retries + 1}/${RESOURCE_RETRY_LIMIT}): ${message}`;
        await repos.executions.setStatus(runId, ExecutionStatus.FAILED, {
          result: `dispatch refused after accept: ${message}`,
        });
        await repos.tasks.setStatus(execution.task_id, Status.WAIT_RESOURCE, {
          reason: retryDetail,
          waitDetail: retryDetail,
          actor: "gateway-late-error",
        });
        await repos.tasks.bumpResourceRetry(execution.task_id, eta);
        await releaseLease();
        await events.append({
          kind: EventKind.DISPATCH_DECISION,
          subjectType: "task",
          subjectId: execution.task_id,
          payload: {
            source: "gateway.late-error",
            executionId: runId,
            decision: "wait",
            status: Status.WAIT_RESOURCE,
            resourceRetry: retries + 1,
            limit: RESOURCE_RETRY_LIMIT,
            nextRetryAt: eta,
            error: payload?.error ?? null,
          },
        });
        log.warn("resource.late-retry", {
          task: execution.task_id, exec: runId,
          provider: execution.model_provider, model: execution.model_id,
          attempt: retries + 1, limit: RESOURCE_RETRY_LIMIT,
          backoffMs: backoff,
          quota,
          error: String(message).slice(0, 300),
        });
        await scheduler?.notify?.("RUN_ENDED");
        return { handled: true, status: Status.WAIT_RESOURCE, resourceRetry: retries + 1 };
      }
      await blockLateError(
        execution,
        runId,
        payload,
        `resource retries exhausted (${RESOURCE_RETRY_LIMIT}x): ${message}`,
        { resourceRetriesExhausted: retries },
      );
      return { handled: true, status: Status.BLOCKED, resourceRetriesExhausted: true };
    }

    await blockLateError(execution, runId, payload, `dispatch refused after accept: ${message}`, {});
    return { handled: true, status: Status.BLOCKED };
  }

  /**
   * The BLOCKED tail shared by every late-refusal path that gave up: execution
   * BLOCKED, task BLOCKED with the wait detail visible in the queue, lease
   * released, one audit event. Centralised because the reasons differ (quota
   * budget spent, resource budget spent, definitive refusal) but the
   * mechanics must not — three copies of this would drift exactly the way the
   * signal-recording gap of D51 did.
   */
  async function blockLateError(execution, runId, payload, detail, extra) {
    await repos.executions.setStatus(runId, ExecutionStatus.BLOCKED, { result: detail });
    await repos.tasks.setStatus(execution.task_id, Status.BLOCKED, {
      reason: detail,
      waitDetail: detail,
      actor: "gateway-late-error",
    });
    const task = await repos.tasks.get(execution.task_id);
    if (task?.workspace_path) {
      const lease = await repos.leases.get(task.workspace_path);
      if (lease?.execution_id === runId) {
        await repos.leases.release(task.workspace_path, { executionId: runId, actor: "gateway-late-error" });
      }
    }
    await events.append({
      kind: EventKind.EXECUTION_STATUS,
      subjectType: "execution",
      subjectId: runId,
      payload: { source: "gateway.late-error", ...extra, error: payload?.error ?? null },
    });
    log.warn("dispatch.late-error", {
      task: execution.task_id, exec: runId,
      provider: execution.model_provider, model: execution.model_id,
      error: String(payload?.error?.message ?? payload?.error ?? detail).slice(0, 300),
      ...extra,
    });
    // The freed lease and worker slot mean the queue can move now.
    await scheduler?.notify?.("RUN_ENDED");
  }

  /**
   * Records one gateway message against the execution its session belongs to.
   * Shared by `session.message` and message-shaped `session.tool` payloads so
   * both paths correlate and persist identically (D48).
   *
   * The session key the event carries is the key dispatch SENT — for CONTINUE
   * revisions a composite `…:s<ref>` that session_ref never holds — so it gets
   * its own lookup first. Matching on session_ref alone dropped every mid-run
   * message of the TASK-E28D15F3/TASK-BFA56024 incident: usage survived (it is
   * keyed in memory by this same event key) while the transcript recorded
   * nothing.
   */
  async function recordMessage(key, payload) {
    const msg = payload?.message;
    if (msg?.content === undefined) return false;
    const execId =
      (await repos.messages.executionForSessionKey(key)) ??
      (await repos.messages.executionForSession(key)) ??
      (await repos.messages.executionForSession(payload?.sessionId));
    if (!execId) return false;
    await repos.messages.append(execId, {
      seq: payload?.messageSeq,
      role: msg.role,
      content: msg.content,
      at: msg.timestamp ?? now(),
    });
    // D71: a message IS runtime evidence. The watchdog used to key on
    // dispatch age and parked runs that were streaming the whole time.
    await repos.executions.touch(execId, msg.timestamp ?? now());
    return true;
  }

  /**
   * Persists one structured tool lifecycle frame (`session.tool`, received
   * because connect advertises the `tool-events` cap — D48). The protocol
   * docs name the event but not its shape, so anything not message-shaped is
   * preserved raw as a single transcript turn: a tool result that silently
   * disappears is how a conversation becomes unreadable, and the UI renders
   * unknown blocks rather than hiding them.
   */
  async function recordToolEvent(key, payload) {
    const p = payload ?? {};
    const execId =
      (await repos.messages.executionForSessionKey(key)) ??
      (await repos.messages.executionForSession(key)) ??
      (await repos.messages.executionForSession(p?.sessionId));
    if (!execId) return false;
    log.info("session.tool.received", { exec: execId, keys: Object.keys(p).join(",") });
    const block = { type: "toolEvent" };
    for (const field of ["toolName", "name", "toolCallId", "status", "phase"]) {
      if (p[field] !== undefined) block[field] = p[field];
    }
    block.payload = p;
    // messageSeq belongs to transcript turns and may be absent on lifecycle
    // frames; a millisecond stamp keeps every event distinct and in order
    // instead of colliding on seq 0 and losing all but the first.
    const seq = Number.isFinite(p?.messageSeq) ? p.messageSeq : now();
    await repos.messages.append(execId, {
      seq,
      role: String(p?.role ?? "tool"),
      content: [block],
      at: p?.timestamp ?? now(),
    });
    await repos.executions.touch(execId, p?.timestamp ?? now());
    return true;
  }

  /**
   * Persists one finished tool call from the gateway's `agent` stream
   * (stream:"tool", phase:"result") — the shape measured on the pinned
   * 2026.7.1 gateway, not the `session.tool` family the newer protocol docs
   * describe (D48). This is the transcript's shell-output channel: the
   * assistant's own toolCall block says what the model asked to run, and this
   * turn says what actually came back — exit codes, file writes, errors.
   *
   * Only phase:"result" is recorded: phase:"start" duplicates the toolCall
   * block the assistant turn already carries, and phase:"update" partials are
   * noise once the aggregated result exists.
   */
  async function recordToolResult(payload) {
    const key = payload?.sessionKey ?? payload?.session?.key ?? null;
    const data = payload?.data ?? {};
    const execId =
      (await repos.messages.executionForSessionKey(key)) ??
      (await repos.messages.executionForSession(key)) ??
      (await repos.messages.executionForSession(payload?.sessionId));
    if (!execId) return false;
    const details = data.result?.details ?? {};
    const text = (data.result?.content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    await repos.messages.append(execId, {
      // The gateway's own per-run seq keeps tool results ordered among
      // themselves and distinct from transcript messageSeqs (roles differ, so
      // the (execution, seq, role) key never collides).
      seq: Number.isFinite(payload?.seq) ? payload.seq : now(),
      role: "toolResult",
      content: [{
        type: "toolResult",
        name: data.name ?? null,
        meta: data.meta ?? null,
        isError: Boolean(data.isError),
        exitCode: Number.isFinite(details.exitCode) ? details.exitCode : null,
        durationMs: Number.isFinite(details.durationMs) ? details.durationMs : null,
        text,
      }],
      at: payload?.ts ?? now(),
    });
    await repos.executions.touch(execId, payload?.ts ?? now());
    return true;
  }

  /**
   * The grace-window gate in front of applyEnd for lifecycle `end` frames
   * (see pendingEnds). Clean verdicts pass straight through; non-clean ones
   * wait, and the newest frame for the same run wins — the 2026.8.2 corrected
   * `stop` arriving after a premature `length` must not find the row frozen.
   */
  async function onLifecycleEnd(payload) {
    const runId = executionIdFromRunId(payload?.runId);
    const data = payload?.data ?? {};
    const verdict = classifyRunEnd(data);
    const immediate =
      verdict.execution === ExecutionStatus.COMPLETE || verdict.task === Status.CANCELLED;

    if (runId && pendingEnds.has(runId)) {
      const held = pendingEnds.get(runId);
      clearTimeout(held.timer);
      pendingEnds.delete(runId);
      log.info("run.end-superseded", {
        exec: runId, from: held.data?.stopReason ?? null, to: data.stopReason ?? null,
        hint: "a newer end frame replaced one still inside its grace window",
      });
    }

    if (immediate || !runId || endGraceMs() <= 0) {
      await applyEnd(runId, data, payload);
      return;
    }
    pendingEnds.set(runId, {
      data,
      payload,
      timer: setTimeout(() => {
        pendingEnds.delete(runId);
        applyEnd(runId, data, payload).catch((err) => {
          log.error("session-event.failed", { evtName: "agent(end-flush)", error: String(err.message).slice(0, 300) });
        });
      }, endGraceMs()),
    });
  }

  /** Wired to the adapter's onEvent. Never throws: see the adapter's guard. */
  async function handle(name, payload) {
    try {
      if (name === "gateway.late-error") {
        await applyLateError(payload);
        return;
      }
      if (name === "session.tool") {
        // Newer protocol versions name the tool lifecycle family
        // `session.tool`; the pinned 2026.7.1 gateway uses agent-stream
        // frames instead, but handling both costs nothing and survives an
        // upgrade.
        const key = payload?.sessionKey ?? payload?.session?.key ?? null;
        const done = await recordMessage(key, payload);
        if (!done) await recordToolEvent(key, payload);
        return;
      }
      if (name === "session.message") {
        // Only assistant turns carry usage; the user message that opens a run
        // has none, and overwriting a real reading with nothing would lose it.
        const usage = usageFromMessage(payload);
        const key = payload?.sessionKey ?? payload?.session?.key ?? null;
        if (key && usage && !isEmptyUsage(usage)) pendingUsage.set(key, usage);

        // Keep what the model said. Until this existed the controller recorded
        // only its own instruction and a stopReason, so a transcript could show
        // one side of a conversation and nothing of the other.
        //
        // Resolved by session ref rather than buffered until the run ends: a
        // run that never ends would otherwise lose its transcript, and those
        // are exactly the runs somebody needs to read.
        await recordMessage(key, payload);
        return;
      }
      if (name !== "agent") return;
      if (payload?.stream === "tool") {
        if (payload?.data?.phase === "result") await recordToolResult(payload);
        return;
      }
      if (payload?.stream !== "lifecycle") return;
      // A `start` frame is the first sign of life a dispatched run can give;
      // it counts as activity exactly like a message (D71).
      if (payload?.data?.phase === "start") {
        const startedRunId = executionIdFromRunId(payload?.runId);
        if (startedRunId) await repos.executions.touch(startedRunId, payload.data?.startedAt ?? now());
        return;
      }
      if (payload?.data?.phase !== "end") return;
      await onLifecycleEnd(payload);
      // The structured line is emitted by applyEnd; nothing to add here.
    } catch (err) {
      // Losing one event must not kill the subscription; the reconciler will
      // catch whatever this dropped.
      log.error("session-event.failed", { evtName: name, error: String(err.message).slice(0, 300) });
    }
  }

  /**
   * Subscribes, and re-subscribes on every reconnect.
   *
   * Re-subscribing matters more than it looks: the gateway forgets the
   * subscription when the socket drops, and a controller that subscribed only
   * once at boot would appear healthy while silently receiving nothing.
   */
  async function start() {
    await runtime.connect();
    const res = await runtime.request("sessions.subscribe", {});
    log.info("session-events.subscribed", { result: res });
    return res;
  }

  return {
    handle,
    start,
    applyEnd,
    applyLateError,
    applyDescribe,
    get pendingUsageSize() { return pendingUsage.size; },
  };
}
