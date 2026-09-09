import { test } from "node:test";
import assert from "node:assert/strict";
import { codexDriver, quotaDriverFor } from "../../src/domain/quota-drivers/index.mjs";

test("Codex subscription driver stays generic until E6 measures its windows", () => {
  assert.equal(quotaDriverFor("codex"), codexDriver);
  assert.deepEqual(codexDriver.defaults(), {
    quotaTier: "subscription",
    shortMs: null,
    longMs: null,
    shortType: null,
    longType: null,
    fixedReset: null,
    rates: { rpm: null, rpd: null, tpm: null, tpd: null },
  });
  assert.equal(codexDriver.classifyError({ status: 401, text: "expired" }).kind, "fatal");
  assert.equal(codexDriver.classifyError({ status: 429, text: "usage limit" }).kind, "quota");
});
