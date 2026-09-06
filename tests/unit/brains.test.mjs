// Brain: kombinasi (provider, model, thinking, effort) yang diberi nama.
//
// Yang diuji di sini bukan CRUD, melainkan invarian yang menjaga agar Brain
// tetap jujur: klaim effort harus punya bukti, provider/model tidak boleh
// berubah setelah agen dibuat untuknya, dan level per role tidak boleh
// diturunkan diam-diam dari profil project.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  Level,
  levelForProfile,
  resolveLevel,
  brainsFromRoutingConfig,
  DEFAULT_ROLE_LEVELS,
} from "../../src/domain/brains.mjs";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body, { token = TOKEN } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

// --- level -------------------------------------------------------------------

test("profil project memetakan ke level", () => {
  assert.equal(levelForProfile("balanced"), Level.NORMAL);
  assert.equal(levelForProfile("fast"), Level.LOW);
  assert.equal(levelForProfile("quality"), Level.CRITICAL);
  // Profil yang tidak dikenal jatuh ke normal, bukan ke yang termurah:
  // menebak ke bawah adalah downgrade diam-diam (P4-03).
  assert.equal(levelForProfile("entah-apa"), Level.NORMAL);
});

test("default bercerita per (template, profile, role) — spec §4.0", () => {
  // Golongan penentu arah: selalu critical, apa pun profilnya.
  assert.equal(resolveLevel({ template: "software", role: "analyst", profile: "fast" }), Level.CRITICAL);
  assert.equal(resolveLevel({ template: "software", role: "architect", profile: "quality" }), Level.CRITICAL);
  assert.equal(resolveLevel({ template: "content", role: "strategist", profile: "fast" }), Level.CRITICAL);
  // Golongan produksi: normal, naik ke critical hanya di quality.
  assert.equal(resolveLevel({ template: "software", role: "builder", profile: "balanced" }), Level.NORMAL);
  assert.equal(resolveLevel({ template: "software", role: "builder", profile: "fast" }), Level.NORMAL);
  assert.equal(resolveLevel({ template: "software", role: "builder", profile: "quality" }), Level.CRITICAL);
  // Golongan penilai: naik satu tingkat dari profil.
  assert.equal(resolveLevel({ template: "software", role: "learner", profile: "balanced" }), Level.CRITICAL);
  assert.equal(resolveLevel({ template: "software", role: "learner", profile: "fast" }), Level.NORMAL);
  assert.equal(resolveLevel({ template: "research", role: "reviewer", profile: "balanced" }), Level.CRITICAL);
  // Golongan verifikasi: mengikuti profil.
  assert.equal(resolveLevel({ template: "frontend", role: "tester", profile: "fast" }), Level.LOW);
  assert.equal(resolveLevel({ template: "frontend", role: "browser", profile: "quality" }), Level.CRITICAL);
  // (software, fast) dan (software, quality) memang dua kebutuhan berbeda.
  assert.notEqual(
    resolveLevel({ template: "software", role: "builder", profile: "fast" }),
    resolveLevel({ template: "software", role: "builder", profile: "quality" }),
  );
});

test("setelan admin menang atas bawaan template", () => {
  const overrides = { learner: Level.LOW };
  assert.equal(
    resolveLevel({ template: "software", role: "learner", profile: "balanced", overrides }),
    Level.LOW,
    "operator boleh menurunkan sesuatu yang bawaannya critical",
  );
});

test("snapshot milik project menang atas global dan bawaan", () => {
  const overrides = { builder: Level.CRITICAL };
  assert.equal(
    resolveLevel({ template: "software", role: "builder", profile: "balanced", overrides, projectOverrides: { builder: Level.LOW } }),
    Level.LOW,
    "begitu project menyimpan mapping-nya sendiri, global tidak lagi bicara",
  );
  assert.equal(
    resolveLevel({ template: "software", role: "builder", profile: "balanced", projectOverrides: { builder: Level.LOW } }),
    Level.LOW,
  );
});

test("role yang tidak dikenal ikut profil project", () => {
  assert.equal(resolveLevel({ template: "software", role: "penulis-pidato", profile: "quality" }), Level.CRITICAL);
});

test("setiap (template, profile) menyebut setiap role eksplisit", () => {
  // Tabel bersarang template → profile → role; himpunan role per template
  // harus identik di semua profile — kalau tidak, role itu hilang diam-diam
  // pada profile tertentu, dan levelnya ditebak saat runtime.
  for (const [template, byProfile] of Object.entries(DEFAULT_ROLE_LEVELS)) {
    const roleSets = Object.values(byProfile).map((m) => [...Object.keys(m)].sort().join(","));
    assert.ok(roleSets.length >= 3, `${template} tampak kurang lengkap`);
    for (const set of roleSets) {
      assert.equal(set, roleSets[0], `${template}: himpunan role tidak seragam antar profile`);
    }
    for (const [profile, roles] of Object.entries(byProfile)) {
      for (const [role, level] of Object.entries(roles)) {
        assert.ok(Object.values(Level).includes(level), `${template}.${profile}.${role} tidak sah: ${level}`);
      }
    }
  }
});

// --- invarian Brain ----------------------------------------------------------

test("klaim preferensi wajib menyertakan buktinya", async () => {
  const h = await buildHarness();
  await assert.rejects(
    () => h.brains.create({ name: "gemini-high", provider: "google", model: "gemini-3.1-flash-lite", thinking: "high", effortMode: "preference" }),
    /effortEvidence/,
    "menandai preferensi tanpa alasan membuatnya tidak bisa ditinjau ulang saat provider berubah",
  );
  const ok = await h.brains.create({
    name: "gemini-high", provider: "google", model: "gemini-3.1-flash-lite",
    thinking: "high", effortMode: "preference",
    effortEvidence: "n=3: off 533 vs high 316 token, sebaran 9-479",
  });
  assert.equal(ok.effortMode, "preference");
});

test("entri yang belum dikarakterisasi dianggap jaminan, bukan preferensi", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({ name: "baru", provider: "zai", model: "glm-5.2", thinking: "high" });
  assert.equal(b.effortMode, "guaranteed", "klaim yang belum diuji adalah klaim yang harus diuji");
});

test("provider dan model tidak bisa diubah", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({ name: "deep", provider: "zai", model: "glm-5.2", thinking: "max" });
  await assert.rejects(
    () => h.brains.update(b.id, { model: "glm-5.1" }),
    /immutable|orphan/,
    "agen di-provision per (project, role, brain); mengubah model akan membuat setiap agen menunjuk model yang salah",
  );
  // Yang boleh berubah: level, kategori, deskripsi, aktif/tidak.
  const after = await h.brains.update(b.id, { level: Level.CRITICAL, description: "untuk arsitektur berat" });
  assert.equal(after.level, Level.CRITICAL);
});

test("brain dicari lewat nama maupun id", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({ name: "Daily Coding", provider: "zai", model: "glm-5.1", thinking: "low" });
  assert.equal(b.name, "daily-coding", "nama dinormalkan supaya bisa dipakai di URL dan perintah Slack");
  assert.equal((await h.brains.get("daily-coding")).id, b.id);
  assert.equal((await h.brains.get(b.id)).name, "daily-coding");
});

test("kandidat disaring per level dan hanya yang aktif", async () => {
  const h = await buildHarness();
  await h.brains.create({ name: "a", provider: "zai", model: "glm-5.2", thinking: "max", level: Level.CRITICAL });
  await h.brains.create({ name: "b", provider: "zai", model: "glm-5.1", thinking: "low", level: Level.NORMAL });
  const off = await h.brains.create({ name: "c", provider: "zai", model: "glm-5.3", thinking: "low", level: Level.CRITICAL });
  await h.brains.update(off.id, { enabled: false });

  // Harness menyemai katalog contoh, jadi saring ke nama yang dibuat tes ini.
  const mine = new Set(["a", "b", "c"]);
  const critical = (await h.brains.candidatesFor({ level: Level.CRITICAL })).filter((x) => mine.has(x.name));
  assert.deepEqual(critical.map((x) => x.name), ["a"], "yang dimatikan tidak boleh ikut terpilih");
});

test("kategori menyempitkan kandidat, bukan menjadi syarat", async () => {
  // Ditemukan hidup: versi pertama memakai `category = NULL` yang di SQL tidak
  // pernah benar, sehingga setiap brain berkategori tersaring habis dan daftar
  // kandidat selalu kosong.
  const h = await buildHarness();
  await h.brains.create({ name: "berkategori", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL, category: "coding" });
  await h.brains.create({ name: "umum", provider: "zai", model: "glm-5.1", thinking: "low", level: Level.NORMAL });

  const mine = (list) => list.filter((x) => ["berkategori", "umum"].includes(x.name)).map((x) => x.name).sort();

  assert.deepEqual(mine(await h.brains.candidatesFor({ level: Level.NORMAL })), ["berkategori", "umum"]);
  assert.deepEqual(
    mine(await h.brains.candidatesFor({ level: Level.NORMAL, category: "coding" })),
    ["berkategori", "umum"],
    "yang tanpa kategori tetap ikut",
  );
  assert.deepEqual(
    mine(await h.brains.candidatesFor({ level: Level.NORMAL, category: "research" })),
    ["umum"],
    "yang berkategori lain tersaring",
  );
});

// --- migrasi dari katalog ----------------------------------------------------

test("katalog routing nyata bisa diangkat jadi Brain", async () => {
  const { readFileSync } = await import("node:fs");
  const routing = JSON.parse(readFileSync(new URL("../../config/routing.json", import.meta.url), "utf8"));
  const seeds = brainsFromRoutingConfig(routing);

  assert.ok(seeds.length >= 10, `hanya ${seeds.length} brain dari katalog`);

  // Level diturunkan dari routes: entri yang dipakai di jalur critical adalah
  // Brain critical, meski ia juga muncul di jalur normal.
  const max = seeds.find((s) => s.name === "glm-5.2-max");
  assert.equal(max.level, Level.CRITICAL);
  const low = seeds.find((s) => s.name === "glm-5.2-low");
  assert.equal(low.level, Level.NORMAL, "glm-5.2-low hanya muncul di documentation/normal");

  // effortMode dan buktinya ikut terbawa — itu yang membuat Brain jujur.
  const gemini = seeds.find((s) => s.name === "gemini-flash-high");
  assert.equal(gemini.effortMode, "preference");
  assert.match(gemini.effortEvidence, /TIDAK diterapkan/);
});

test("menyemai katalog nyata lolos seluruh validasi Brain", async () => {
  const { readFileSync } = await import("node:fs");
  const routing = JSON.parse(readFileSync(new URL("../../config/routing.json", import.meta.url), "utf8"));
  const h = await buildHarness();
  // Harness memakai katalog contoh, jadi tabelnya masih kosong untuk nama ini.
  let created = 0;
  for (const seed of brainsFromRoutingConfig(routing)) {
    if (await h.brains.get(seed.name)) continue;
    await h.brains.create(seed);
    created += 1;
  }
  assert.ok(created > 0);
  const all = await h.brains.list();
  for (const b of all) {
    if (b.effortMode === "preference") assert.ok(b.effortEvidence, `${b.name} preferensi tanpa bukti`);
  }
});

test("architect selalu critical, dan ia memang tidak ada di AgentOS", async () => {
  const { ROLES_NOT_IN_AGENTOS } = await import("../../src/domain/brains.mjs");
  // Diperiksa langsung di workspace-presets.ts: sepuluh role tersedia dan tidak
  // satu pun Architect. Skill Builder bahkan menjauh dari desain secara
  // eksplisit ("prefer direct code changes over speculative planning"), dan
  // Learner hanya MENCATAT keputusan arsitektur, tidak membuatnya.
  assert.ok(ROLES_NOT_IN_AGENTOS.includes("architect"));

  // Kesalahan desain adalah yang paling mahal dibatalkan, jadi ia critical
  // apa pun profil projectnya — termasuk saat project disetel "fast".
  for (const profile of ["fast", "balanced", "quality"]) {
    for (const template of ["software", "frontend", "backend"]) {
      assert.equal(
        resolveLevel({ template, role: "architect", profile }),
        Level.CRITICAL,
        `${template}/${profile} seharusnya tetap critical untuk architect`,
      );
    }
  }

  // Tetapi operator tetap boleh menurunkannya secara sadar.
  assert.equal(
    resolveLevel({ template: "software", role: "architect", profile: "fast", overrides: { architect: Level.NORMAL } }),
    Level.NORMAL,
  );
});

// ── connection test route: claude-code is harness-routed, not model-matched ─
//
// Regression for a real bug measured on the cluster: `POST .../brains/{id}/
// test` matched live agents on `model.primary === "${provider}/${model}"`.
// For every ordinary provider that is correct. For `claude-code` it can NEVER
// match — no live agent literally reports model "claude-code/claude-code";
// the harness is reached through a named ACP agent instead (`acpAgent` in
// routing.json, e.g. "claude-opus"). So a claude Brain read as "no agent
// provisioned" even with a healthy, running harness — the same distinction
// agent-registry.mjs's `isHarnessRouted` already makes for dispatch, just
// missing from this route.

test("connection test resolves a claude-code Brain by its acpAgent, not by model", async () => {
  const h = await buildHarness();
  const brain = await h.brains.create({
    name: "claude-opus-brain",
    provider: "claude-code",
    model: "claude-code",
    mode: "acp",
    acpAgent: "claude-opus",
  });
  h.runtime.listAgents = async () => [
    // Deliberately carries no model matching "claude-code/claude-code" —
    // that agent will never exist. Its id is the acpAgent name instead.
    { id: "claude-opus", model: { primary: "anthropic/claude-opus-5" } },
  ];
  h.runtime.testAgent = async ({ agentId }) => ({ ok: true, status: "completed", agentId });
  const api = await startApi(h);
  try {
    const res = await api.call("POST", `/api/work/brains/${brain.id}/test`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.agentId, "claude-opus");
  } finally {
    await api.close();
  }
});

test("connection test reports a claude-code Brain with no pinned acpAgent honestly", async () => {
  const h = await buildHarness();
  const brain = await h.brains.create({
    name: "claude-unpinned",
    provider: "claude-code",
    model: "claude-code",
    mode: "acp",
  });
  h.runtime.listAgents = async () => [{ id: "claude-opus", model: { primary: "anthropic/claude-opus-5" } }];
  const api = await startApi(h);
  try {
    const res = await api.call("POST", `/api/work/brains/${brain.id}/test`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "no-agent");
    assert.match(res.body.message, /no ACP agent pinned/);
  } finally {
    await api.close();
  }
});

test("connection test still matches an ordinary provider by model.primary", async () => {
  const h = await buildHarness();
  const brain = await h.brains.create({ name: "glm-brain", provider: "zai", model: "glm-5.2" });
  h.runtime.listAgents = async () => [{ id: "glm-agent", model: { primary: "zai/glm-5.2" } }];
  h.runtime.testAgent = async ({ agentId }) => ({ ok: true, status: "completed", agentId });
  const api = await startApi(h);
  try {
    const res = await api.call("POST", `/api/work/brains/${brain.id}/test`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.agentId, "glm-agent");
  } finally {
    await api.close();
  }
});

test("POST .../brains/test connection-tests an unsaved draft the same way", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [{ id: "claude-opus", model: { primary: "anthropic/claude-opus-5" } }];
  h.runtime.testAgent = async ({ agentId }) => ({ ok: true, status: "completed", agentId });
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/brains/test", {
      provider: "claude-code",
      model: "claude-code",
      acpAgent: "claude-opus",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.agentId, "claude-opus");
  } finally {
    await api.close();
  }
});

test("update acpAgent on a claude-code brain persists the value", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({
    name: "my-claude-brain",
    provider: "claude-code",
    model: "claude-code",
    level: Level.CRITICAL,
    mode: "acp",
    acpAgent: "claude-opus",
  });
  const after = await h.brains.update(b.id, { acpAgent: "claude-opus-5" });
  assert.equal(after.acpAgent, "claude-opus-5");
  const cleared = await h.brains.update(b.id, { acpAgent: null });
  assert.equal(cleared.acpAgent, null);
});

test("update acpAgent on a non-claude brain is rejected", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({
    name: "my-glm-brain",
    provider: "zai",
    model: "glm-5.2",
    thinking: "max",
    level: Level.CRITICAL,
  });
  await assert.rejects(
    () => h.brains.update(b.id, { acpAgent: "claude-opus" }),
    /claude-code/,
    "acpAgent di luar claude-code adalah konfigurasi yang tidak akan pernah dipakai",
  );
});

test("update mode menolak nilai di luar interactive/acp/batch", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({
    name: "my-mode-brain",
    provider: "zai",
    model: "glm-5.2",
    thinking: "high",
    level: Level.NORMAL,
  });
  await assert.rejects(
    () => h.brains.update(b.id, { mode: "turbo" }),
    /interactive, acp or batch/,
  );
  const ok = await h.brains.update(b.id, { mode: "interactive" });
  assert.equal(ok.mode, "interactive");
});

// --- deletion ---------------------------------------------------------------

test("menghapus brain melepas pemakuannya dan melaporkan sel yang kembali ke default", async () => {
  const h = await buildHarness();
  const gone = await h.brains.create({
    name: "retired-brain",
    provider: "aliyuncs",
    model: "qwen3.5-max",
    level: Level.NORMAL,
  });
  const kept = await h.brains.create({
    name: "staying-brain",
    provider: "zai",
    model: "glm-5.2",
    level: Level.NORMAL,
  });
  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainId: gone.id, actor: "satria" },
    { brains: h.brains },
  );
  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainId: kept.id, actor: "satria" },
    { brains: h.brains },
  );

  const result = await h.brains.delete(gone.id);
  assert.equal(result.brain.id, gone.id);
  assert.deepEqual(result.clearedMappings, [], "pemakaian terakhir ditimpa oleh kept — tidak ada yang dilepas");

  // Sel yang HANYA memaku brain yang dihapus harus dilepas dan dilaporkan.
  await h.brainMap.set(
    { template: "research", role: "writer", level: Level.NORMAL, brainId: kept.id, actor: "satria" },
    { brains: h.brains },
  );
  const result2 = await h.brains.delete(kept.id);
  assert.equal(result2.brain.id, kept.id);
  assert.deepEqual(
    result2.clearedMappings.map((m) => `${m.template}/${m.role}/${m.level}`),
    ["software/builder/normal", "research/writer/normal"],
  );
  assert.equal(await h.brains.get(gone.id), null);
  assert.equal(await h.brains.get(kept.id), null);
  assert.equal((await h.brainMap.list({})).length, 0);
});

test("menghapus brain yang tidak ada ditolak", async () => {
  const h = await buildHarness();
  await assert.rejects(() => h.brains.delete("BRN-NOPE"), /unknown brain/);
  await assert.rejects(() => h.brains.delete("no-such-name"), /unknown brain/);
});

test("DELETE /api/work/brains/{id} is admin-only and names what it cleared", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const brain = await h.brains.create({
      name: "api-deleted-brain",
      provider: "aliyuncs",
      model: "qwen3.5-max",
      level: Level.NORMAL,
    });
    await h.brainMap.set(
      { template: "content", role: "writer", level: Level.NORMAL, brainId: brain.id, actor: "satria" },
      { brains: h.brains },
    );

    const { token } = await h.operators.create({ name: "budi", role: "operator" });
    const forbidden = await api.call("DELETE", `/api/work/brains/${brain.id}`, undefined, { token });
    assert.equal(forbidden.status, 403);

    const unknown = await api.call("DELETE", "/api/work/brains/BRN-NOPE");
    assert.equal(unknown.status, 404);

    const ok = await api.call("DELETE", `/api/work/brains/${brain.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.brain.name, "api-deleted-brain");
    assert.deepEqual(
      ok.body.clearedMappings.map((m) => `${m.template}/${m.role}/${m.level}`),
      ["content/writer/normal"],
    );
  } finally {
    await api.close();
  }
});
