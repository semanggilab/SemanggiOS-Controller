// Claude driver (claude-code harness). No new research (POC-6 §2): the
// windows are block-shaped — a 5-hour block and a weekly cap, resetting at
// fixed clock times — and the pool runs the Pro plan. The weekly anchor was
// left unclaimed until measured; D88 measured it (operator, 2026-09-09):
// Senin 02:00 WIB. The 5h block anchor is still NOT a global wall clock (it
// starts per-user), so short stays fixed-time WITHOUT its own descriptor —
// and no live path prices the short window through nextReset (5h is not
// retry-in-place), the D87 text parser owns that anchor.
import { isQuotaErrorMessage, isTransientRuntimeError, parseQuotaReset } from "../quota-windows.mjs";
import { ANTHROPIC_WEEKLY_RESET, makeClassifier, nextResetMs } from "./core.mjs";

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
      fixedReset: ANTHROPIC_WEEKLY_RESET,
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
