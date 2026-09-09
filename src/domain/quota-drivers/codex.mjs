// POC-8 starts honest: ChatGPT subscription windows are not assumed to match
// Claude's. E6 will replace these nulls only after the limit and reset signal
// have been measured through the deployed ACP path.
import { genericDriver } from "./generic.mjs";

export const codexDriver = {
  id: "codex",
  providerKeys: ["codex"],

  defaults() {
    return {
      quotaTier: "subscription",
      shortMs: null,
      longMs: null,
      shortType: null,
      longType: null,
      fixedReset: null,
      rates: { rpm: null, rpd: null, tpm: null, tpd: null },
    };
  },

  nextReset(window, ctx) {
    return genericDriver.nextReset(window, ctx);
  },

  classifyError(input) {
    return genericDriver.classifyError(input);
  },
};
