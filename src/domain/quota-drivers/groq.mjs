// Groq driver (free tier). Windows roll from first consumption — but the
// finding that shaped this driver is structural, not temporal (D62):
//
//   413 "Request Entity Too Large ... Limit 7000, Requested 20011"
//   x-should-retry: false
//
// The agent prompt (~10.4K tokens) simply exceeds the 7K ITPM every qwen model
// allows on the free tier. No window reset changes that, so burning the
// ten-attempt retry budget on it is noise: classify it fatal so the task
// blocks immediately with a reason that names the real fix (paid tier, or a
// prompt budget — POC-6 §6).
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

const MINUTE = 60_000;
const DAY = 24 * 3_600_000;

export const groqDriver = {
  id: "groq",

  defaults() {
    return {
      quotaTier: "free",
      shortMs: MINUTE,
      longMs: DAY,
      shortType: "rolling",
      longType: "rolling",
      fixedReset: null,
      // tpm is the MEASURED 7000, not the nominal 8000 — the 413 body names
      // the effective input limit (D62), and pricing retries against the
      // advertised number is how the wall went unnoticed.
      rates: { rpm: 30, rpd: 1_000, tpm: 7_000, tpd: 200_000 },
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  classifyError: makeClassifier(
    {
      fatal: [
        {
          pattern: /limit\s*\d+,\s*requested\s*\d+/i,
          reason:
            "prompt exceeds the provider input-token window (groq free ITPM ~7K, x-should-retry:false): " +
            "the request can never fit as sent — needs a smaller prompt or a paid tier",
          structural: true,
        },
      ],
    },
    { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset },
  ),
};
