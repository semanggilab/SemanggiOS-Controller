// POC-6 core: window arithmetic shared by every quota driver.
//
// The two columns D51 gave the Brain (shortMs/longMs) answer "how long is the
// window" but not "when does it next reset" — and those are different questions
// once providers are honest about their semantics. Google's daily RPD resets at
// a wall-clock moment (midnight Pacific, DST aware); Groq's windows roll from
// the first consumption; Cerebras refills a bucket continuously. This module
// turns a window descriptor + signal context into the next-reset epoch, so the
// callers (admission, session-events) never have to know which provider they
// are pricing (D63).

/** Token buckets refill continuously; without a ledger we pace one short window. */
export const TOKEN_BUCKET_PACE_CAP_MS = 60_000;

/**
 * D88: jangkar mingguan langganan Anthropic, diukur operator (2026-09-09):
 * limit mingguan reset Senin 02:00 WIB (Asia/Jakarta, tanpa DST). Descriptor
 * tunggal ini dipakai driver claude-code (defaults → brains), jangkar fallback
 * quota-windows, dan migrasi backfill — tiga pintu, satu tabel kebenaran.
 */
export const ANTHROPIC_WEEKLY_RESET = Object.freeze({ atHourLocal: 2, timeZone: "Asia/Jakarta", day: 1 });

/** Kinds a window descriptor may carry (POC-6 §3.7 taxonomy). */
export const SHORT_WINDOW_KINDS = Object.freeze(["rolling", "fixed-time", "token-bucket", "credits"]);
export const LONG_WINDOW_KINDS = Object.freeze([...SHORT_WINDOW_KINDS, "credits-anniversary"]);

/**
 * Provider clock values arrive as epoch seconds OR millis — measured on the zai
 * signal (POC-3 E8), where 1.7e9 seconds always looked "in the past" to a
 * 1.7e12 now(). Normalise before any comparison.
 */
export function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Local wall-clock parts of an instant in a named zone (nul deps: Intl). */
function localWall(epochMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  // Some ICU builds render midnight as hour "24" under hour12:false; %24 makes
  // it 0 without touching anything else.
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/**
 * Epoch of a local wall-clock time in a named zone, DST-safe without a tz
 * database: compute the zone's offset at a reference instant, apply it, then
 * verify by formatting back — across a transition the offsets differ, and one
 * correction step converges because transitions move the clock by whole hours.
 */
function epochAtLocalWall({ year, month, day, hour }, timeZone, refEpochMs) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  const refWall = localWall(refEpochMs, timeZone);
  const refOffset =
    Date.UTC(refWall.year, refWall.month - 1, refWall.day, refWall.hour, refWall.minute, refWall.second) - refEpochMs;
  let candidate = asIfUtc - refOffset;
  const wall = localWall(candidate, timeZone);
  const offsetAtCandidate =
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - candidate;
  if (offsetAtCandidate !== refOffset) candidate = asIfUtc - offsetAtCandidate;
  return candidate;
}

/**
 * Next occurrence of a fixed reset ({ atHourLocal, timeZone, day? }), in epoch
 * ms after `nowMs`. `day` is 0=Sunday..6=Saturday local time; without it the
 * reset is daily. Google's RPD midnight is the reason this exists — "24 hours
 * after the hit" (the rolling fallback) can be a whole day wrong on either
 * side of the DST boundary.
 */
export function nextFixedResetMs(fixedReset, nowMs) {
  const timeZone = String(fixedReset?.timeZone ?? "UTC");
  const atHour = Number.isFinite(Number(fixedReset?.atHourLocal)) ? Number(fixedReset.atHourLocal) : 0;
  const wall = localWall(nowMs, timeZone);

  const at = (dayOffset) => epochAtLocalWall(
    { year: wall.year, month: wall.month, day: wall.day + dayOffset, hour: atHour },
    timeZone,
    nowMs,
  );

  if (fixedReset?.day == null) {
    let candidate = at(0);
    if (candidate <= nowMs) candidate = at(1);
    return candidate;
  }

  // Weekly-style anchors: walk up to 7 days out. Date.UTC overflows month and
  // year correctly, so day + offset never needs its own calendar math.
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = at(offset);
    if (candidate <= nowMs) continue;
    const weekday = fmt.format(new Date(candidate));
    const want = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(fixedReset.day)];
    if (weekday === want) return candidate;
  }
  return null;
}

/**
 * The one ETA rule every driver shares (POC-6 §4.1):
 *
 *   signal > prediction — a provider-given resetsAt in the future wins (D51);
 *   fixed-time   → next wall-clock occurrence, DST-aware;
 *   token-bucket → pace one short window max; without a token ledger a full
 *                  TPD "window" would park a model for a day on an RPM hiccup;
 *   rolling / credits / credits-anniversary → anchor + window, where the
 *                  anchor is the signal time (known) and the fallback is now
 *                  (conservative: never earlier than the truth can be).
 *
 * Returns epoch ms, or null when the window itself is unknown.
 */
export function nextResetMs(window, { nowMs, lastSignalAt, resetsAt, cycleAnchor } = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const signal = normalizeEpochMs(resetsAt);
  if (signal !== null && signal > now) return signal;

  const ms = Number(window?.ms);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const kind = String(window?.kind ?? "rolling");
  const anchor = Number.isFinite(Number(lastSignalAt)) ? Number(lastSignalAt) : now;

  if (kind === "fixed-time" && window.fixedReset) {
    return nextFixedResetMs(window.fixedReset, now);
  }
  if (kind === "token-bucket") {
    return now + Math.min(ms, TOKEN_BUCKET_PACE_CAP_MS);
  }
  if (kind === "credits-anniversary" && Number.isFinite(Number(cycleAnchor)) && Number(cycleAnchor) > 0) {
    return Number(cycleAnchor) + Math.ceil(Math.max(0, now - Number(cycleAnchor)) / ms) * ms;
  }
  return anchor + ms;
}

/**
 * Build a classifyError from a base vocabulary plus provider additions.
 *
 * The base is deliberately the FULL generic quota vocabulary (the D52-era
 * isQuotaErrorMessage superset): a driver may ADD fatal patterns (groq's 413
 * structural wall, cerebras' 402) but must never NARROW what counts as quota —
 * a provider renaming its rate-limit phrasing is not a licence to start
 * blocking tasks as definitive failures.
 */
export function makeClassifier({ fatal = [], quota = [] } = {}, base) {
  return function classifyError({ status, text } = {}) {
    const raw = String(text ?? "");
    const fatalRules = [...fatal];
    // 402/401 from an API is billing/auth, not load: it does not reset and no
    // backoff fixes it (measured: cerebras 402 payment_required, D62).
    if (Number(status) === 402 || /\b402\b.*payment|payment_required/i.test(raw)) {
      fatalRules.push({ pattern: /./, reason: "payment required: provider billing, not load — add credits or disable this brain" });
    }
    if (Number(status) === 401 || /\b401\b.*unauthorized/i.test(raw)) {
      fatalRules.push({ pattern: /./, reason: "unauthorized: credentials rejected by provider" });
    }
    for (const rule of fatalRules) {
      if (rule.pattern.test(raw)) return { kind: "fatal", reason: rule.reason, structural: Boolean(rule.structural) };
    }
    for (const pattern of quota) {
      if (pattern.test(raw)) {
        const reset = base?.parseQuotaReset ? base.parseQuotaReset(raw) : { resetsAt: null, rateLimitType: null };
        return { kind: "quota", resetsAt: reset.resetsAt, rateLimitType: reset.rateLimitType };
      }
    }
    if (base?.isQuotaErrorMessage ? base.isQuotaErrorMessage(raw) : false) {
      const reset = base?.parseQuotaReset ? base.parseQuotaReset(raw) : { resetsAt: null, rateLimitType: null };
      return { kind: "quota", resetsAt: reset.resetsAt, rateLimitType: reset.rateLimitType };
    }
    if (base?.isTransientRuntimeError?.(raw)) return { kind: "transient" };
    return null;
  };
}
