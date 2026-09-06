// The fallback driver: today's behaviour, unchanged.
//
// An unknown provider must not break the moment it appears in the gateway —
// the generic driver prices windows from the Brain's two ms columns and
// classifies errors with the provider-agnostic vocabulary that predates POC-6.
// It is also the honest floor: every real driver is a specialisation of this.
import { QUOTA_WINDOWS_BY_PROVIDER, isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

export const genericDriver = {
  id: "generic",

  defaults({ provider } = {}) {
    const windows = QUOTA_WINDOWS_BY_PROVIDER[String(provider ?? "").toLowerCase()] ?? null;
    return {
      quotaTier: null,
      shortMs: windows?.shortMs ?? null,
      longMs: windows?.longMs ?? null,
      shortType: windows ? "rolling" : null,
      longType: windows ? "rolling" : null,
      fixedReset: null,
      rates: { rpm: null, rpd: null, tpm: null, tpd: null },
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  // Built with makeClassifier so the fallback and every specialisation share
  // one floor: 402/401 auto-fatal, then the full D52 vocabulary. A hand-rolled
  // copy here is how the 401 rule went missing for the generic driver while
  // every named driver had it.
  classifyError: makeClassifier(
    {},
    { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset },
  ),
};
