import test from "node:test";
import assert from "node:assert/strict";
import { startupRetryDelayMs, withStartupRetry } from "../../src/runtime/startup-retry.mjs";

test("startup retry uses capped exponential delays", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => startupRetryDelayMs(n, { baseMs: 10, maxMs: 50 })),
    [10, 20, 40, 50, 50]);
});

test("startup retry survives dependencies that become ready late", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await withStartupRetry("redis", async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNREFUSED");
    return "ready";
  }, {
    attempts: 4,
    baseMs: 10,
    maxMs: 50,
    sleep: async (ms) => sleeps.push(ms),
    log: { warn() {} },
  });
  assert.equal(result, "ready");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("startup retry surfaces the final error when a finite limit is configured", async () => {
  let calls = 0;
  await assert.rejects(() => withStartupRetry("postgres", async () => {
    calls += 1;
    throw new Error("still unavailable");
  }, { attempts: 2, sleep: async () => {}, log: { warn() {} } }), /still unavailable/);
  assert.equal(calls, 2);
});
