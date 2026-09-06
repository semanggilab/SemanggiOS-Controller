// Mistral driver (API "free mode"). Added for the pool's sixth provider
// (POC-6 §3.6): the models magistral / codestral / mistral-small are already
// registered via AgentOS, so the gateway catalog supplies context windows and
// nothing here blocks on research.
//
// Rate dimensions per model are requests-per-SECOND and tokens-per-minute —
// no daily request cap exists, which favours a pool; the binding long-run
// limit is the included monthly usage (a billing-cycle budget, same class as
// zai's weekly credits). Concrete numbers are only visible in the admin panel
// (docs were restructured, the old tier page is gone), so every rate stays
// null until an operator reads them — the driver ships the SEMANTICS now and
// the numbers when measured.
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

const MINUTE = 60_000;
const MONTH = 30 * 24 * 3_600_000;

export const mistralDriver = {
  id: "mistral",

  defaults() {
    return {
      quotaTier: "free",
      shortMs: MINUTE,
      longMs: MONTH,
      shortType: "rolling",
      longType: "credits-anniversary",
      fixedReset: null,
      rates: { rpm: null, rpd: null, tpm: null, tpd: null },
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  classifyError: makeClassifier({}, { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset }),
};
