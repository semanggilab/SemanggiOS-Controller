// Google driver (Gemini API). The measured reason it exists (POC-6 §3.1):
//
//   RPD resets at MIDNIGHT PACIFIC — a wall-clock moment, DST-aware — while
//   RPM/TPM roll per minute. The D51 columns priced both as plain durations,
//   so a drained daily cap could park for up to 24h past the real reset (or
//   release a day early). The fixedReset descriptor answers that exactly.
//
// Free-tier RPM/RPD are per model (read from the AI Studio rate-limit page,
// 2026-09-06) — the driver carries the four the pool actually uses; anything
// else stays null ("verify in AI Studio") rather than guessing a sibling's
// numbers. TPM 250K is common to all four and far above the ~10.4K agent
// prompt, so the honest limiter for the pool is RPD, not input size.
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

const MINUTE = 60_000;
const DAY = 24 * 3_600_000;

/** Per-model free-tier rates; keys are matched loosely against brain.model. */
export const GOOGLE_FREE_RATES = [
  { match: /2[._-]?5[._-]?flash[._-]?lite/, rates: { rpm: 10, rpd: 20 } },
  { match: /3[._-]?1[._-]?flash[._-]?lite/, rates: { rpm: 15, rpd: 500 } },
  { match: /3[._-]?5[._-]?flash[._-]?lite/, rates: { rpm: 15, rpd: 500 } },
  { match: /3[._-]?7[._-]?flash(?!.*lite)/, rates: { rpm: 5, rpd: 20 } },
];

function ratesFor(model) {
  const raw = String(model ?? "").toLowerCase();
  const found = GOOGLE_FREE_RATES.find((entry) => entry.match.test(raw));
  if (!found) return { rpm: null, rpd: null, tpm: null, tpd: null };
  return { ...found.rates, tpm: 250_000, tpd: null };
}

export const googleDriver = {
  id: "google",

  defaults({ model } = {}) {
    return {
      quotaTier: "free",
      shortMs: MINUTE,
      longMs: DAY,
      shortType: "rolling",
      longType: "fixed-time",
      fixedReset: { atHourLocal: 0, timeZone: "America/Los_Angeles" },
      rates: ratesFor(model),
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  classifyError: makeClassifier(
    {
      quota: [
        // Google's phrasing carries no HTTP code in the text and no
        // "rate limit" words: "Resource has been exhausted ... RESOURCE_EXHAUSTED"
        // (measured, D51). The generic base already covers it; this entry
        // documents the vocabulary at its owner.
        /RESOURCE_EXHAUSTED/i,
      ],
    },
    { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset },
  ),
};
