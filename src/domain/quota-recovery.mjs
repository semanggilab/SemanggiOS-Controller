// D84 — quota recovery probe: measure "usable again" instead of guessing it.
//
// The wedge that motivated this: OpenClaw 2026.8.2 quota refusals arrive as
// TEXT ("⚠️ Usage limit reached for 5 hour. Your limit will reset at …")
// with no structured resetsAt, so applyQuotaSignal wrote
// next_available_at = NULL and releaseExpiredQuota — which only flips rows
// whose timestamp has passed — never released the model again. glm-5.2 sat
// QUOTA_EXHAUSTED for hours after the provider recovered, and "Run again"
// answered "policy-approved models are quota-exhausted" (measured
// 2026-09-08). The anchor gap is closed in applyQuotaSignal itself (a
// clockless signal now prices the provider's short window from the hit);
// this probe closes the OTHER gap — an anchor, however derived, is a guess
// about when the provider recovers, and the only honest measurement of
// "bisa digunakan" is a dispatch.
//
// Discipline: one minimal throwaway run per exhausted model per pass, on an
// existing live agent for that exact model (probe agents preferred — they
// are disposable and exist to be poked). claude-code is never probed (the
// ACP harness is not model-matched, same discipline as D78/D80); a model
// with live dispatches is not probed (the real run is the honest probe, and
// a refusal it meets re-anchors through the late-error path); a row whose
// anchor is imminent is left to the window pass. A probe FAILURE never
// extends a live future anchor — a sliding envelope would postpone release
// forever, one probe at a time.
import { nullLogger } from "./logger.mjs";
import { isQuotaErrorMessage } from "./quota-windows.mjs";

export function createQuotaRecovery({ repos, runtime, config = {}, now = () => Date.now(), log = nullLogger }) {
  // A row releasing within this horizon is the window pass's business —
  // probing it buys at most a few minutes and spends a real completion.
  const horizonMs = config.quotaProbeHorizonMs ?? 10 * 60_000;
  const timeoutMs = config.quotaProbeTimeoutMs ?? 90_000;
  // Cadence floor independent of the timer: a manual run() call must not
  // turn into a probe storm.
  const cooldownMs = config.quotaProbeCooldownMs ?? 10 * 60_000;
  // Repeated still-exhausted verdicts pace themselves: a truly weekly wall
  // probed flat-out is a thousand refused dispatches a week per model, so the
  // cooldown doubles per consecutive failure, capped here. Recovery resets it.
  const maxCooldownMs = config.quotaProbeMaxCooldownMs ?? 6 * 3_600_000;
  const lastProbeAt = new Map();
  const consecutiveFailures = new Map();

  /** Best agent to poke for a model: existing probe agents first (disposable,
   *  born to be poked), then any live agent serving the exact model. */
  function agentFor(live, provider, model) {
    const needle = `${provider}/${model}`.toLowerCase();
    const matching = live.filter((a) => String(a?.model?.primary ?? "").toLowerCase() === needle);
    return matching.find((a) => /^sem-workspaces-probe-/.test(String(a?.id ?? ""))) ?? matching[0] ?? null;
  }

  async function run() {
    const out = { probed: [], recovered: [], reanchored: [] };
    if (typeof runtime?.listAgents !== "function" || typeof runtime?.testAgent !== "function") return out;
    const rows = (await repos.resources.list().catch(() => [])).filter((r) => r.availability === "QUOTA_EXHAUSTED");
    if (rows.length === 0) return out;
    const live = await runtime.listAgents().catch(() => []);

    for (const r of rows) {
      // ACP harness: no live agent ever reports model "claude-code/…" and
      // probing an orchestrator proves the orchestrator, not the harness.
      if (r.provider === "claude-code") continue;
      const key = `${r.provider}/${r.model}`;
      const failures = consecutiveFailures.get(key) ?? 0;
      const effectiveCooldown = Math.min(cooldownMs * 2 ** failures, maxCooldownMs);
      if (now() - (lastProbeAt.get(key) ?? 0) < effectiveCooldown) continue;
      if (r.next_available_at != null && r.next_available_at <= now() + horizonMs) continue;
      // A model with dispatches in flight measures itself: a wall it hits
      // re-anchors via the late-error path, a success flips nothing (it was
      // never exhausted to begin with).
      if ((await repos.resources.activeCount(r.provider, r.model)) > 0) continue;
      const agent = agentFor(live, r.provider, r.model);
      if (!agent) continue;

      lastProbeAt.set(key, now());
      out.probed.push(key);
      const result = await runtime.testAgent({ agentId: agent.id, thinking: null, timeoutMs }).catch((err) => ({
        ok: false,
        error: String(err?.message ?? err),
      }));
      if (result.ok) {
        consecutiveFailures.set(key, 0);
        await repos.resources.setAvailability(r.provider, r.model, "AVAILABLE", { source: "recovery-probe" });
        log.info("quota.recovery-probe", {
          provider: r.provider,
          model: r.model,
          verdict: "available",
          agentId: agent.id,
          latencyMs: result.latencyMs ?? null,
        });
        out.recovered.push(key);
        continue;
      }
      const text = String(result.error ?? "");
      const stillExhausted = isQuotaErrorMessage(text);
      consecutiveFailures.set(key, stillExhausted ? failures + 1 : 0);
      if (stillExhausted && (r.next_available_at == null || r.next_available_at <= now())) {
        // Clockless or expired anchor only — never extend a live one. The
        // hardened applyQuotaSignal prices the short window from the hit.
        await repos.resources.applyQuotaSignal(r.provider, r.model, { status: 429, message: text });
        out.reanchored.push(key);
      }
      log.info("quota.recovery-probe", {
        provider: r.provider,
        model: r.model,
        verdict: stillExhausted ? "still-exhausted" : "error",
        agentId: agent.id,
        error: text.slice(0, 160),
      });
    }
    return out;
  }

  return { run };
}
