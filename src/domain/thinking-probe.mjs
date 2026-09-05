// Empirical, single-model thinking-level probe.
//
// There is no RPC that answers "what reasoning levels does this model
// support" (see thinking-levels.mjs's header) — the only way to find out is
// to actually dispatch a run at each candidate level and read what came
// back. This module is that measurement, kept separate from the HTTP route
// and from gateway-ws.mjs so it can be tested against a fake runtime with no
// network, no timers left dangling, and no database.
//
// SCOPE, DELIBERATELY (2026-09-01 operator decision): a probe run here
// covers exactly ONE (provider, model) pair, never a sweep across every
// onboarded model. At least one live model — groq/qwen/qwen3.6-27b — accepts
// several levels at the RPC and then hangs until the watchdog reclaims it
// (config/thinking-levels.json). A bulk probe would multiply that cost by
// every model in the fleet; a caller who wants more than one model probed
// calls this once per model, on purpose, so the cost is visible per call
// rather than hidden inside a single button press.
//
// SAFETY: every candidate level runs through `runtime.probeLevel`, which
// carries its own bounded per-level timeout (gateway-ws.mjs). A level that
// doesn't finish in time is recorded as excluded and the probe moves on —
// it is never retried and never allowed to block the remaining candidates.

export const CANDIDATE_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "max", "adaptive"]);

/**
 * A level counts as a usable signal only when the run actually completed —
 * an RPC refusal, a timeout (D14: "could not observe it", which for a probe
 * is treated as "don't trust it"), a missing `agent.wait`, or a run that the
 * gateway accepted and then failed to start all exclude the level. An
 * unmeasured level is not the same as a working one, and the Brain form
 * should never offer a guess dressed up as a measured catalog entry.
 *
 * A run that completed but reported no usage stays INCLUDED: some providers
 * (google/gemini through the OpenAI-compatible path) never report usage, and
 * excluding their levels would blank the whole catalog. Usage decides the
 * effort evidence, not inclusion.
 */
// Statuses a finished run actually reports, measured rather than assumed:
// "ok" on the live cluster (zai/glm-5.2 probe, D47), "completed" in the
// pinned-version fixtures. Anything else — "error" for a run refused at
// start, "unknown", a future gateway's new word — is an unmeasured level.
// A whitelist that blanks on an unknown word is deliberate: an empty probe
// result gets noticed immediately, while an included-but-broken level ships
// a dispatch refusal into every task that picks it.
export const COMPLETED_STATUSES = new Set(["ok", "completed"]);

function classifySample(level, result) {
  if (!result.ok) {
    return { level, included: false, reason: `refused: ${result.error ?? "unknown error"}` };
  }
  if (result.status === "timeout") {
    return {
      level,
      included: false,
      reason: "did not complete within the probe timeout — treated as unsafe (possible hang)",
    };
  }
  if (result.status === "unsupported") {
    return { level, included: false, reason: "agent.wait not supported on this gateway — cannot confirm completion" };
  }
  // Measured on the cluster (D47): a level the gateway refuses at run START
  // still gets the dispatch request answered — the run is accepted, refused
  // half a second later, and agent.wait reports status "error" within seconds
  // with no usage ever arriving. Before this check, that read as "completed
  // but reported no usable usage" and put `max` back in the zai/glm-5.2
  // catalog even though every dispatch carrying it is refused.
  if (!COMPLETED_STATUSES.has(result.status)) {
    return { level, included: false, reason: `run did not complete normally (status: ${result.status})` };
  }
  const outputTokens = Number.isFinite(result.usage?.output_tokens) ? result.usage.output_tokens : null;
  if (outputTokens === null) {
    return { level, included: true, outputTokens: null, reason: "completed but reported no usable usage" };
  }
  return { level, included: true, outputTokens, reason: null };
}

/**
 * Runs the candidate vocabulary sequentially against one (provider, model)
 * via an already-resolved live agent, and derives a levels/effortMode/
 * evidence triple from what was actually observed.
 *
 * Sequential, not parallel: concurrent probes against the SAME agent would
 * share its one session slot, and a hang on one level would then look like
 * a hang on every level running alongside it.
 *
 * `onLevelDone(sample, samplesSoFar)` is optional incremental progress —
 * the HTTP route uses it to persist a partial result after every level
 * rather than only at the very end, so a probe interrupted partway (process
 * restart, operator giving up on a hung level) still leaves behind whatever
 * it measured.
 */
export async function probeThinkingLevels({
  runtime,
  agentId,
  candidateLevels = CANDIDATE_LEVELS,
  perLevelTimeoutMs = 60_000,
  onLevelDone = null,
  now = () => Date.now(),
}) {
  if (!runtime?.probeLevel) throw new Error("this runtime does not support thinking-level probing");
  if (!agentId) throw new Error("agentId is required");

  const samples = [];
  for (const level of candidateLevels) {
    const startedAt = now();
    const result = await runtime.probeLevel({ agentId, thinking: level, timeoutMs: perLevelTimeoutMs });
    const sample = { ...classifySample(level, result), status: result.status, latencyMs: result.latencyMs, startedAt };
    samples.push(sample);
    if (onLevelDone) {
      try {
        await onLevelDone(sample, samples.slice(), deriveCatalogEntry(samples));
      } catch {
        /* a progress-callback failure must not abort the probe itself */
      }
    }
  }

  return { ...deriveCatalogEntry(samples), samples };
}

/**
 * Turns the samples collected so far into the shape thinking-levels.mjs's
 * `upsert` expects. Exported separately from the loop above so a partial
 * run (interrupted after level 3 of 7) still has a meaningful, honestly
 * partial entry rather than nothing at all.
 */
function deriveCatalogEntry(samples) {
  const levels = samples.filter((s) => s.included).map((s) => s.level);
  const measured = samples.filter((s) => s.included && Number.isFinite(s.outputTokens));

  let effortMode = "preference";
  const evidenceParts = [];
  if (measured.length >= 2) {
    const values = measured.map((s) => s.outputTokens);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Mirrors the bar the manual n=3 seed evidence already clears (e.g.
    // glm-5.2: 137 -> 284, more than 2x) rather than inventing a new one —
    // small single-sample noise should not read as a guaranteed effort dial.
    const guaranteed = max - min >= 20 && max >= min * 1.15;
    effortMode = guaranteed ? "guaranteed" : "preference";
    evidenceParts.push(`auto-probed n=1: ${measured.map((s) => `${s.level} ${s.outputTokens}`).join(" -> ")} output tokens`);
  } else if (measured.length === 1) {
    evidenceParts.push(`auto-probed n=1: only ${measured[0].level} reported usable usage — not enough to judge effort`);
  } else {
    evidenceParts.push("auto-probed: no level reported usable output-token data yet");
  }

  const excluded = samples.filter((s) => !s.included);
  if (excluded.length > 0) {
    evidenceParts.push(`excluded: ${excluded.map((s) => `${s.level} (${s.reason})`).join("; ")}`);
  }
  if (excluded.some((s) => s.reason?.includes("possible hang"))) {
    evidenceParts.push("DANGEROUS: at least one level did not complete within its timeout — do not send it.");
  }

  return { levels, effortMode, evidence: evidenceParts.join(" — ").slice(0, 500) };
}
