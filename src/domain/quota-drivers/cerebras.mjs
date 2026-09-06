// Cerebras driver. Cerebras does not sell windows — it refills buckets:
// two parallel token buckets (uncached and total) replenish continuously at
// tokens/second, with RPM 5 and a 1M daily cap on the trial the pool runs
// (POC-6 §3.3). "When can I go again" is therefore "when enough tokens have
// accrued", which nextResetMs caps at one pace window: without a token ledger
// (a Phase-2 concern) parking for a full TPD would wedge a model for a day on
// an RPM hiccup.
//
// The account currently answers 402 payment_required (D62) — fatal, not
// load: it does not reset and no backoff fixes it. The base classifier
// handles 402; this driver exists so the policy is stated where it belongs.
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

const MINUTE = 60_000;
const DAY = 24 * 3_600_000;

export const cerebrasDriver = {
  id: "cerebras",

  defaults() {
    return {
      quotaTier: "free-trial",
      shortMs: MINUTE,
      longMs: DAY,
      shortType: "token-bucket",
      longType: "rolling",
      fixedReset: null,
      // tpm carries the UNCACHED bucket (the binding one for big prompts);
      // the total bucket (90K) lives in the POC-6 doc until a ledger exists.
      rates: { rpm: 5, rpd: null, tpm: 30_000, tpd: 1_000_000 },
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  classifyError: makeClassifier({}, { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset }),
};
