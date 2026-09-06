// Z.ai driver (GLM Coding Plan). The plan prices CREDITS, not requests or raw
// tokens: (in×m_in + cached×m_cached + out×m_out)/10000 per model. The pool
// runs Lite — 2,000 credits / 5 hours and 10,000 / week (POC-6 §3.4).
//
// Window semantics from the plan's own wording:
//   5-hour  "credit quota resets 5 hours after consumption"  → rolling, per
//           credit, from consumption — priced here as one rolling window,
//           which is the conservative envelope of per-credit replenishment;
//   weekly  "activated upon subscription; resets every 7 days" → anniversary
//           cycle. The controller never learns the subscription anchor, so
//           without a provider signal this window is priced as its full
//           duration from the hit — conservative, and usually moot because
//           the gateway signal carries resetsAt+rateLimitType (POC-3 E8:
//           {"resetsAt":…,"rateLimitType":"five_hour"}).
//
// The plan also routes silently (glm-5.2/5.1 → glm-5.3), so no per-model
// rates exist to store — concurrency, not RPM, is the plan's request lever.
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * 24 * 3_600_000;

export const zaiDriver = {
  id: "zai",

  defaults() {
    return {
      quotaTier: "lite",
      shortMs: FIVE_HOURS,
      longMs: WEEK,
      shortType: "credits",
      longType: "credits-anniversary",
      fixedReset: null,
      rates: { rpm: null, rpd: null, tpm: null, tpd: null },
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  classifyError: makeClassifier(
    {
      quota: [
        // The five_hour / weekly signals arrive with their own clock; the base
        // parse salvages resetsAt+rateLimitType from the payload text.
        /rateLimitType/i,
      ],
    },
    { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset },
  ),
};
