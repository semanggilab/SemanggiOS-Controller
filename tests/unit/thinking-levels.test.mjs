// Katalog thinking-levels dan endpoint uji koneksi Brain.
//
// Yang diuji: refresh menyinkron dari berkas (bukan dari udara), dan endpoint
// test-koneksi melaporkan "tidak ada agen" secara jujur alih-alih pura-pura
// menguji sesuatu yang tidak bisa diuji tanpa agen nyata.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

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

test("refresh menyinkron katalog thinking-levels dari berkas seed", async () => {
  const h = await buildHarness();
  const result = await h.thinkingLevels.refresh();
  assert.ok(result.synced >= 5, `hanya ${result.synced} entri tersinkron`);

  const glm52 = await h.thinkingLevels.get("zai", "glm-5.2");
  assert.deepEqual(glm52.levels, ["off", "low", "high", "max"]);
  assert.equal(glm52.effortMode, "guaranteed");

  const gemini = await h.thinkingLevels.get("google", "gemini-3.1-flash-lite");
  assert.equal(gemini.effortMode, "preference", "gemini terukur mengabaikan effort — harus tetap preference");
});

test("upsert menolak level yang bukan array dan effortMode yang tidak dikenal", async () => {
  const h = await buildHarness();
  await assert.rejects(() => h.thinkingLevels.upsert({ provider: "x", model: "y", levels: "high" }), /array/);
  await assert.rejects(
    () => h.thinkingLevels.upsert({ provider: "x", model: "y", levels: [], effortMode: "sometimes" }),
    /effortMode/,
  );
});

test("GET /api/work/gateway/thinking-levels menjawab lewat HTTP", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const res = await api.call("GET", "/api/work/gateway/thinking-levels?provider=zai&model=glm-5.2");
    assert.equal(res.status, 200);
    assert.equal(res.body.levels.length, 1);
    assert.deepEqual(res.body.levels[0].levels, ["off", "low", "high", "max"]);
  } finally {
    await api.close();
  }
});

test("POST /api/work/brains/{id}/test melaporkan tidak ada agen, bukan gagal diam-diam", async () => {
  const h = await buildHarness();
  const { brain } = await (async () => {
    const b = await h.brains.create({ name: "tanpa-agen", provider: "zai", model: "glm-9.9-belum-ada", level: "normal" });
    return { brain: b };
  })();
  const api = await startApi(h);
  try {
    const res = await api.call("POST", `/api/work/brains/${brain.id}/test`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "no-agent");
    assert.match(res.body.message, /No agent is currently provisioned/);
  } finally {
    await api.close();
  }
});

test("GET /api/work/gateway/models tidak pernah melempar meski runtime tidak mendukungnya", async () => {
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
