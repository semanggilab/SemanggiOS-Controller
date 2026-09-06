// Claude driver (claude-code harness). No new research (POC-6 §2): the
// windows are block-shaped — a 5-hour block and a weekly cap, resetting at
// fixed clock times — and the pool runs the Pro plan. The exact weekly anchor
// hour is not recorded here, so longType is fixed-time WITHOUT a descriptor:
// nextReset then falls back to the conservative rolling envelope, which is
// honest ("up to one full window") until the anchor is measured. When someone
// measures it, the fix is one descriptor — the point of the driver shape.
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { makeClassifier, nextResetMs } from "./core.mjs";

const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * 24 * 3_600_000;

export const claudeCodeDriver = {
  id: "claude-code",

  defaults() {
    return {
      quotaTier: "pro",
      shortMs: FIVE_HOURS,
      longMs: WEEK,
      shortType: "fixed-time",
      longType: "fixed-time",
      fixedReset: null,
      rates: { rpm: null, rpd: null, tpm: null, tpd: null },
    };
  },

  nextReset(window, ctx) {
    return nextResetMs(window, ctx);
  },

  classifyError: makeClassifier(
    {
      quota: [/session limit|usage limit/i],
    },
    { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset },
  ),
};
