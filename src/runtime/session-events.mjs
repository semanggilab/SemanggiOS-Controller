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
import { ExecutionStatus, Status } from "../domain/state-machine.mjs";
import { nullLogger } from "../domain/logger.mjs";

/**
 * Maps a run outcome onto the execution/task pair.
 *
 * `aborted` is deliberately checked before `stopReason`: an aborted run may
 * still report stopReason "stop", and treating a cancellation as success would
 * mark work complete that nobody finished.
 */
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

export function createSessionEventSink({ repos, events, runtime, scheduler, now = () => Date.now(), log = nullLogger }) {
  // Keyed by sessionKey, NOT runId.
  //
  // This is the bug that made every completed execution report zero tokens:
  // `session.message` carries no `runId` at all. It has sessionKey, sessionId,
  // messageId and messageSeq — so usage has to be correlated through the
  // session, and the lifecycle `end` event (which has both) closes the loop.
  const pendingUsage = new Map();

  async function applyEnd(runId, data, payload) {
    const execution = await repos.executions.get(runId);
    if (!execution) {
      // Not ours: another operator, the TUI, or a run from a previous
      // controller generation. Ignoring is correct — inventing an execution
      // record for it would corrupt the audit trail.
      return { handled: false, reason: "unknown execution" };
    }
    if (execution.finalized_at) return { handled: false, reason: "already final" };

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

    await repos.executions.setStatus(runId, verdict.execution, { result: verdict.reason });
    await repos.tasks.setStatus(execution.task_id, verdict.task, {
      reason: verdict.task === Status.COMPLETE ? null : `run ended: ${verdict.reason}`,
      actor: "session-events",
    });

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
      payload: {
        source: "sessions.subscribe",
        stopReason: verdict.reason,
        aborted: Boolean(data?.aborted),
        startedAt: data?.startedAt ?? null,
        endedAt: data?.endedAt ?? null,
      },
    });

    // A finished run frees a lease, a worker slot and provider concurrency, so
    // the queue should move immediately rather than waiting for the watchdog.
    log.info("run.ended", {
      task: execution.task_id, exec: runId,
      provider: execution.model_provider, model: execution.model_id,
      stopReason: verdict.reason, aborted: Boolean(data?.aborted),
      taskStatus: verdict.task,
      durationMs: data?.startedAt && data?.endedAt ? data.endedAt - data.startedAt : null,
      tokens: usage
        ? {
            input: usage.input_tokens, output: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
            costUsd: usage.providerCostUsd,
          }
        : null,
      sessionId: payload?.sessionId ?? null,
    });
    await scheduler?.notify?.("RUN_ENDED");
    return { handled: true, status: verdict.task };
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
    const runId = payload?.runId ?? null;
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

    const detail = `dispatch refused after accept: ${message}`;
    await repos.executions.setStatus(runId, ExecutionStatus.BLOCKED, { result: detail });
    await repos.tasks.setStatus(execution.task_id, Status.BLOCKED, {
      reason: detail,
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
      payload: { source: "gateway.late-error", error: payload?.error ?? null },
    });

    log.warn("dispatch.late-error", {
      task: execution.task_id, exec: runId,
      provider: execution.model_provider, model: execution.model_id,
      error: String(message).slice(0, 300),
    });
    // The freed lease and worker slot mean the queue can move now.
    await scheduler?.notify?.("RUN_ENDED");
    return { handled: true, status: Status.BLOCKED };
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
    return true;
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
      if (payload?.data?.phase !== "end") return;
      const result = await applyEnd(payload.runId, payload.data, payload);
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

  return { handle, start, applyEnd, applyLateError, get pendingUsageSize() { return pendingUsage.size; } };
}
