// Model Map (D66): gabungan resources + thinking_levels, endpoint tulisnya,
// dan flip kepemilikan seed thinking-levels.
//
// Tiga hal yang diuji:
//   1. merge menggabungkan dua tabel pada kunci (provider, model) tanpa
//      menyembunyikan baris yang hanya ada di satu sisi — baris satu sisi
//      itulah yang memarkir task saat dirutekan.
//   2. tulis operator lewat PATCH resource / PUT thinking-levels: admin-only,
//      tervalidasi, tercatat di event_log, dan TIDAK menyentuh bidang live
//      (availability, next_available_at).
//   3. restart tidak lagi menimpa suntingan operator: seed thinking-levels
//      hanya berjalan saat tabel kosong (dulu: file menang setiap boot).
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.mjs";
import { createController } from "../../src/app.mjs";
import { mergeModelMap } from "../../src/domain/model-map.mjs";
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

// --- merge ---------------------------------------------------------------------

test("merge menggabungkan dua sisi pada (provider, model) dan menandai sumbernya", () => {
  const rows = mergeModelMap(
    [
      {
        provider: "zai",
        model: "glm-5.2",
        credit_class: "metered",
        concurrency_limit: 2,
        quota_policy: {},
        window_kind: null,
        availability: "AVAILABLE",
        next_available_at: null,
        last_quota_signal: null,
        updated_at: 100,
      },
    ],
    [
      { provider: "zai", model: "glm-5.2", levels: ["off", "max"], effortMode: "guaranteed", evidence: "n=3", updatedAt: 200 },
    ],
  );
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, "zai");
  assert.deepEqual(r.sources, ["resource", "thinking-levels"]);
  assert.equal(r.concurrencyLimit, 2);
  assert.deepEqual(r.levels, ["off", "max"]);
  assert.equal(r.evidence, "n=3");
});

test("merge menganggap kunci case-insensitive tetapi baris satu sisi tetap tampil", () => {
  const rows = mergeModelMap(
    [{ provider: "ZAI", model: "glm-5.2", credit_class: "metered", concurrency_limit: 2, quota_policy: {}, availability: "AVAILABLE", updated_at: 1 }],
    [
      { provider: "zai", model: "glm-5.2", levels: ["off"], effortMode: "guaranteed", evidence: null, updatedAt: 2 },
      { provider: "google", model: "gemini-9", levels: ["off"], effortMode: "preference", evidence: "ignored", updatedAt: 3 },
    ],
  );
  // Ejaan sisi resource menang untuk identitas baris; kunci tetap satu.
  assert.deepEqual(rows.map((r) => `${r.provider}/${r.model}`), ["google/gemini-9", "ZAI/glm-5.2"]);
  const gemini = rows[0];
  assert.deepEqual(gemini.sources, ["thinking-levels"]);
  assert.equal(gemini.creditClass, null, "sisi resource yang tidak ada tampil sebagai null, bukan disembunyikan");
  const glm = rows[1];
  assert.deepEqual(glm.sources, ["resource", "thinking-levels"]);
});

// --- GET /api/work/model-map ---------------------------------------------------

test("GET /api/work/model-map menjawab gabungan kedua tabel", async () => {
  const h = await buildHarness();
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.2", concurrencyLimit: 2 });
  await h.thinkingLevels.upsert({ provider: "zai", model: "glm-5.2", levels: ["off", "low"], effortMode: "guaranteed" });
  const api = await startApi(h);
  try {
    const res = await api.call("GET", "/api/work/model-map");
    assert.equal(res.status, 200);
    const glm = res.body.models.find((m) => m.model === "glm-5.2");
    assert.ok(glm, "glm-5.2 ada di daftar");
    assert.deepEqual(glm.sources, ["resource", "thinking-levels"]);
    assert.deepEqual(glm.levels, ["off", "low"]);
    assert.equal(glm.concurrencyLimit, 2);
  } finally {
    await api.close();
  }
});

// --- PATCH /api/work/resources?provider=&model= ----------------------------------

test("PATCH resource mengubah kebijakan tanpa menyentuh sinyal live, dan tercatat di event_log", async () => {
  const h = await buildHarness();
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.2", concurrencyLimit: 2 });
  // Sinyal live seolah-olah dari 429 nyata: inilah yang TIDAK boleh ikut berubah.
  await h.repos.resources.setAvailability("zai", "glm-5.2", "QUOTA_EXHAUSTED", { nextAvailableAt: 999_999 });
  // Model id groq mengandung "/" — alasan provider/model menjadi query param,
  // bukan path segment (tidak akan selamat dari proxy catch-all AgentOS).
  await h.repos.resources.upsert({ provider: "groq", model: "qwen/qwen3.6-27b", concurrencyLimit: 4 });

  const api = await startApi(h);
  try {
    const res = await api.call("PATCH", "/api/work/resources?provider=zai&model=glm-5.2", { concurrencyLimit: 4, creditClass: "subscription" });
    assert.equal(res.status, 200);
    assert.equal(res.body.resource.concurrencyLimit, 4);
    assert.equal(res.body.resource.creditClass, "subscription");
    assert.equal(res.body.resource.availability, "QUOTA_EXHAUSTED", "availability live ikut terbawa, bukan direset");
    assert.equal(res.body.resource.nextAvailableAt, 999_999);

    const slashed = await api.call("PATCH", "/api/work/resources?provider=groq&model=qwen%2Fqwen3.6-27b", { concurrencyLimit: 2 });
    assert.equal(slashed.status, 200, "model id yang mengandung / tetap bisa dipatch");
    assert.equal(slashed.body.resource.concurrencyLimit, 2);

    const events = await h.events.list({ subjectType: "resource", subjectId: "zai/glm-5.2" });
    assert.ok(events.some((e) => e.kind === "resource.policy" && e.payload.concurrencyLimit === 4));
  } finally {
    await api.close();
  }
});

test("PATCH resource menolak field tak dikenal, nilai mustahil, dan baris yang tidak ada", async () => {
  const h = await buildHarness();
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.2", concurrencyLimit: 2 });
  const api = await startApi(h);
  try {
    assert.equal((await api.call("PATCH", "/api/work/resources?provider=zai&model=glm-5.2", { concurencyLimit: 3 })).status, 400);
    assert.equal((await api.call("PATCH", "/api/work/resources?provider=zai&model=glm-5.2", { concurrencyLimit: 1.5 })).status, 400);
    assert.equal((await api.call("PATCH", "/api/work/resources?provider=zai&model=glm-5.2", { creditClass: "gratis" })).status, 400);
    assert.equal((await api.call("PATCH", "/api/work/resources?provider=zai&model=tidak-ada", { concurrencyLimit: 3 })).status, 404);
    // yang ditolak tidak mengubah apa pun
    assert.equal((await h.repos.resources.get("zai", "glm-5.2")).concurrency_limit, 2);
  } finally {
    await api.close();
  }
});

// --- PUT /api/work/thinking-levels ----------------------------------------------

test("PUT thinking-levels menyimpan baris + event, dan menuntut evidence untuk preference", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const ok = await api.call("PUT", "/api/work/thinking-levels", {
      provider: "zai",
      model: "glm-9.9",
      levels: ["off", "low"],
      effortMode: "guaranteed",
      evidence: "manual: measured off a live run outside the probe flow",
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.level.levels, ["off", "low"]);

    const noEvidence = await api.call("PUT", "/api/work/thinking-levels", {
      provider: "zai",
      model: "glm-9.9",
      levels: ["off"],
      effortMode: "preference",
      evidence: null,
    });
    assert.equal(noEvidence.status, 400, "klaim preference tanpa evidence ditolak");

    const events = await h.events.list({ subjectType: "model", subjectId: "zai/glm-9.9" });
    assert.ok(events.some((e) => e.kind === "thinking-levels.updated"));
  } finally {
    await api.close();
  }
});

// --- flip kepemilikan seed (D66) -------------------------------------------------

test("restart tidak menimpa suntingan operator pada thinking-levels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semanggi-modelmap-"));
  const db = join(dir, "controller.db");
  try {
    // Boot pertama: tabel kosong → seed dari berkas config (masih terjadi).
    const c1 = await createController({ storeLocation: db, routing: {}, runtime: {} });
    await c1.thinkingLevels.upsert({
      provider: "zai",
      model: "glm-5.2",
      levels: ["off"],
      effortMode: "guaranteed",
      evidence: "operator edit via Model Map",
    });

    // "Restart": controller baru pada berkas DB yang sama. Sebelum D66, boot
    // menjalankan refresh() penuh dan baris ini kembali menjadi isi berkas
    // seed tanpa jejak.
    const c2 = await createController({ storeLocation: db, routing: {}, runtime: {} });
    const row = await c2.thinkingLevels.get("zai", "glm-5.2");
    assert.deepEqual(row.levels, ["off"], "suntingan operator bertahan melewati restart");
    assert.equal(row.evidence, "operator edit via Model Map");
    await c1.store.close();
    await c2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
