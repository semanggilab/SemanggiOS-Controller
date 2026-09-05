// Cache of the gateway's models.list answer (persisted for reuse — see
// gateway-models.mjs). What matters here: the cache serves stale-but-fast
// reads by default, "refresh" is the only path that pays for a live RPC,
// and a model the gateway stops advertising actually disappears rather than
// lingering forever.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("replaceAll persists the gateway's answer, normalised", async () => {
  const h = await buildHarness();
  await h.gatewayModels.replaceAll([
    { id: "glm-5.2", provider: "ZAI", name: "GLM 5.2", reasoning: true, available: true },
    { id: "glm-4.7", provider: "zai", reasoning: false },
  ]);
  const rows = await h.gatewayModels.list();
  assert.equal(rows.length, 2);
  const glm52 = rows.find((r) => r.id === "glm-5.2");
  assert.equal(glm52.provider, "zai", "provider is normalised lowercase, like thinking_levels");
  assert.equal(glm52.reasoning, true);
  assert.equal(glm52.available, true);
});

test("replaceAll is a full overwrite: a model the gateway stops reporting disappears", async () => {
  const h = await buildHarness();
  await h.gatewayModels.replaceAll([
    { id: "glm-5.2", provider: "zai" },
    { id: "glm-4.7", provider: "zai" },
  ]);
  assert.equal((await h.gatewayModels.list()).length, 2);

  await h.gatewayModels.replaceAll([{ id: "glm-5.2", provider: "zai" }]);
  const rows = await h.gatewayModels.list();
  assert.equal(rows.length, 1, "glm-4.7 is gone, not left stale from the previous refresh");
  assert.equal(rows[0].id, "glm-5.2");
});

test("replaceAll skips entries with no usable provider/model rather than throwing", async () => {
  const h = await buildHarness();
  await h.gatewayModels.replaceAll([{ id: "", provider: "zai" }, { id: "glm-5.2", provider: "" }, null, {}]);
  assert.deepEqual(await h.gatewayModels.list(), []);
});

test("GET /api/work/gateway/models serves the cache, never the live gateway", async () => {
  const h = await buildHarness();
  let liveCalls = 0;
  h.runtime.listModels = async () => {
    liveCalls += 1;
    return [{ id: "glm-5.2", provider: "zai" }];
  };
  await h.gatewayModels.replaceAll([{ id: "glm-4.7", provider: "zai", name: "cached already" }]);
  const api = await startApi(h);
  try {
    const res = await api.call("GET", "/api/work/gateway/models");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.models.map((m) => m.id), ["glm-4.7"]);
    assert.equal(liveCalls, 0, "a plain GET must never hit the gateway");
  } finally {
    await api.close();
  }
});

test("POST /api/work/gateway/models/refresh hits the gateway and persists the result for later GETs", async () => {
  const h = await buildHarness();
  h.runtime.listModels = async () => [{ id: "glm-5.2", provider: "zai", reasoning: true }];
  const api = await startApi(h);
  try {
    const refreshed = await api.call("POST", "/api/work/gateway/models/refresh", {});
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body.models.map((m) => m.id), ["glm-5.2"]);

    const after = await api.call("GET", "/api/work/gateway/models");
    assert.deepEqual(after.body.models.map((m) => m.id), ["glm-5.2"], "the refreshed answer is what later GETs now serve");
  } finally {
    await api.close();
  }
});

test("GET /api/work/gateway/models never throws even with an empty cache", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const res = await api.call("GET", "/api/work/gateway/models");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.models, []);
  } finally {
    await api.close();
  }
});
