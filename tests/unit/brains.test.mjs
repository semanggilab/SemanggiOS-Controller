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
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

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

test("D64: kategori sudah tidak ada — kandidat adalah pool per level", async () => {
  // Kolom category dihapus karena jalur dispatch tidak pernah mengoper
  // kategori (Brain Map template×role×level yang memutus). Test ini menjaga
  // penghapusannya: create dengan category tidak lagi dikenali, dan
  // candidatesFor tidak punya parameter penyaring kategori sama sekali.
  const h = await buildHarness();
  await h.brains.create({ name: "eks-kategori", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL });
  await h.brains.create({ name: "umum", provider: "zai", model: "glm-5.1", thinking: "low", level: Level.NORMAL });

  const mine = (list) => list.filter((x) => ["eks-kategori", "umum"].includes(x.name)).map((x) => x.name).sort();
  assert.deepEqual(mine(await h.brains.candidatesFor({ level: Level.NORMAL })), ["eks-kategori", "umum"]);
  // Sejarahnya: versi pertama filter kategori memakai `category = NULL` yang
  // di SQL tidak pernah benar — brain berkategori tersaring habis. Kini
  // parameternya sendiri sudah tidak ada; mengirimnya tidak berbuat apa-apa.
  assert.deepEqual(mine(await h.brains.candidatesFor({ level: Level.NORMAL, category: "anything" })), [
    "eks-kategori",
    "umum",
  ]);
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

// ── connection test auto-provisioning (D65) ─────────────────────────────────
//
// Measured on the cluster (2026-09-06): the first cut of D65 swallowed every
// ensureProbeAgent failure and answered with the stale "No agent is currently
// provisioned … pin one via Brain Map" message — so a gateway-side EACCES
// (probe workspace root owned by root; the gateway bootstraps workspaces as
// uid 1000) read as "go create an agent by hand", the exact runaround D65
// exists to remove. These tests pin the honest contract.

test("connection test auto-provisions a probe agent when none exists, then tests it", async () => {
  const h = await buildHarness();
  const brain = await h.brains.create({ name: "codestral-brain", provider: "mistral-custom", model: "codestral-latest" });
  const live = [{ id: "glm-agent", model: { primary: "zai/glm-5.2" } }];
  h.runtime.listAgents = async () => live;
  const created = [];
  h.runtime.createProbeAgent = async ({ name, workspace, model }) => {
    created.push({ name, workspace, model });
    live.push({ id: name, model: { primary: model } });
    return { id: name, name };
  };
  h.runtime.testAgent = async ({ agentId }) => ({ ok: true, status: "completed", agentId });
  const api = await startApi(h);
  try {
    const res = await api.call("POST", `/api/work/brains/${brain.id}/test`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.provisioned, true);
    assert.equal(res.body.agentId, created[0].name);
    assert.equal(created[0].model, "mistral-custom/codestral-latest");
    assert.match(created[0].name, /^sem-workspaces-probe-mistral-custom-/);
    // Mount contract: host and container paths are identical — a relative
    // workspace is an agent that works nowhere (the pre-fix fallback was).
    assert.ok(created[0].workspace.startsWith("/"), "probe workspace must be absolute");
    assert.ok(created[0].workspace.endsWith("/probe/mistral-custom"));
  } finally {
    await api.close();
  }
});

test("a probe agent missing from the re-list is still tested by the id the gateway returned", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => []; // advertisement lags create forever here
  h.runtime.createProbeAgent = async ({ name }) => ({ id: name, name });
  const tested = [];
  h.runtime.testAgent = async ({ agentId }) => {
    tested.push(agentId);
    return { ok: false, status: "error", error: "agent is not runnable" };
  };
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/brains/test", { provider: "zai", model: "glm-5.2" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.provisioned, true);
    assert.deepEqual(tested, [res.body.agentId]);
    assert.match(res.body.agentId, /^sem-workspaces-probe-zai-/);
  } finally {
    await api.close();
  }
});

test("connection test surfaces an agents.create failure instead of the stale no-agent message", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [];
  h.runtime.createProbeAgent = async () => {
    throw new Error(
      '{"code":"UNAVAILABLE","message":"Error: EACCES: permission denied, mkdir ' +
        "'/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/probe/mistral-custom': code=EACCES\"}",
    );
  };
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/brains/test", {
      provider: "mistral-custom",
      model: "codestral-latest",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "provision-failed");
    assert.match(res.body.message, /EACCES/);
    assert.match(res.body.message, /chown/);
    assert.doesNotMatch(res.body.message, /pin one via Brain Map/);
  } finally {
    await api.close();
  }
});

test("a runtime without probe-agent provisioning reports that gap, not a missing agent", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [];
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/brains/test", { provider: "zai", model: "glm-9.9" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "provision-failed");
    assert.match(res.body.message, /no probe-agent provisioning/);
  } finally {
    await api.close();
  }
});

// ── Process Manager (D78) ────────────────────────────────────────────────────
//
// Sandbox = agent gateway + workspace-nya. Daftarnya agent-centric karena
// itulah yang dimutasi Test (probe D65) dan Create; atribusi project/task
// datang dari worker; RUNNING berarti ada task DISPATCHED/RUNNING parkir di
// sana — dan kill hanya legal untuk yang lain, ATURANNYA DI SERVER (pola D67).

test("sandbox list: hanya agent milik brain, IDLE vs RUNNING, dengan atribusi task", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h); // worker.agent_ref = "doc-worker"
  const brain = await h.brains.create({ name: "glm-brain", provider: "zai", model: "glm-5.2", thinking: "max", level: Level.NORMAL });
  h.runtime.listAgents = async () => [
    { id: "doc-worker", name: "doc-worker", workspace: "/nfs/workspaces/alpha", model: { primary: "zai/glm-5.2" } },
    { id: "sem-workspaces-probe-zai-glm-5-2", name: "sem-workspaces-probe-zai-glm-5-2", model: { primary: "zai/glm-5.2" } },
    { id: "lain", model: { primary: "google/gemini-flash" } }, // brain lain — tidak ikut
  ];
  const api = await startApi(h);
  try {
    // Bekas task terminal di worker itu → atribusi IDLE lewat fallback
    // latestByWorker (task HIDUP yang menentukan RUNNING, tapi task terakhir
    // yang menjawab "sandbox ini dipakai untuk apa").
    const prior = await queuedTask(h, { project, worker, title: "dokumentasi lama" });
    // QUEUED→COMPLETE ilegal (task yang belum pernah dikerjakan tidak bisa
    // "selesai"); bekas task yang jujur lewat dispatch.
    await h.repos.tasks.setStatus(prior.id, Status.DISPATCHED);
    await h.repos.tasks.setStatus(prior.id, Status.COMPLETE);

    let res = await api.call("GET", `/api/work/brains/${brain.id}/sandboxes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sandboxes.length, 2, JSON.stringify(res.body.sandboxes));
    const idle = res.body.sandboxes.find((s) => s.agentId === "doc-worker");
    assert.equal(idle.status, "IDLE");
    assert.equal(idle.probe, false);
    assert.equal(idle.taskId, prior.id, "atribusi IDLE = task terakhir di worker itu");
    assert.equal(idle.projectId, project.id);
    assert.equal(res.body.sandboxes.find((s) => s.agentId === "sem-workspaces-probe-zai-glm-5-2").probe, true);

    // Task DISPATCHED di worker ber-agent itu → RUNNING + atribusi.
    const task = await queuedTask(h, { project, worker, title: "menulis docs" });
    await h.repos.tasks.setStatus(task.id, Status.DISPATCHED);
    res = await api.call("GET", `/api/work/brains/${brain.id}/sandboxes`);
    const busy = res.body.sandboxes.find((s) => s.agentId === "doc-worker");
    assert.equal(busy.status, "RUNNING");
    assert.equal(busy.taskId, task.id);
    assert.equal(busy.projectId, project.id);
  } finally {
    await api.close();
  }
});

test("kill sandbox: IDLE dihapus lewat agents.delete; RUNNING ditolak 409 dengan task-nya", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const brain = await h.brains.create({ name: "glm-brain", provider: "zai", model: "glm-5.2", level: Level.NORMAL });
  const live = [{ id: "doc-worker", model: { primary: "zai/glm-5.2" } }];
  h.runtime.listAgents = async () => live;
  const deleted = [];
  h.runtime.deleteAgent = async ({ agentId }) => {
    deleted.push(agentId);
    return { removedBindings: 2 };
  };
  const api = await startApi(h);
  try {
    const bad = await api.call("POST", `/api/work/brains/${brain.id}/sandboxes/kill`, { agentId: "bukan-agent-ini" });
    assert.equal(bad.status, 404, "bukan sandbox brain ini");

    const task = await queuedTask(h, { project, worker });
    // Jalur sah state machine: QUEUED → DISPATCHED → RUNNING (D75 menambah
    // tepi mundur, bukan lompatan maju).
    await h.repos.tasks.setStatus(task.id, Status.DISPATCHED);
    await h.repos.tasks.setStatus(task.id, Status.RUNNING);
    const conflict = await api.call("POST", `/api/work/brains/${brain.id}/sandboxes/kill`, { agentId: "doc-worker" });
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error, new RegExp(task.id));
    assert.deepEqual(deleted, [], "RUNNING tidak pernah sampai ke agents.delete");

    await h.repos.tasks.setStatus(task.id, Status.COMPLETE);
    const ok = await api.call("POST", `/api/work/brains/${brain.id}/sandboxes/kill`, { agentId: "doc-worker" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.killed, true);
    assert.equal(ok.body.removedBindings, 2);
    assert.deepEqual(deleted, ["doc-worker"]);
  } finally {
    await api.close();
  }
});

test("create sandbox: nama berprefiks sem-, workspace absolut, model milik brain; claude-code ditolak", async () => {
  const h = await buildHarness();
  const brain = await h.brains.create({ name: "glm-brain", provider: "zai", model: "glm-5.2", level: Level.NORMAL });
  const acp = await h.brains.create({ name: "claude-brain", provider: "claude-code", model: "claude-code", mode: "acp", acpAgent: "claude-opus", level: Level.NORMAL });
  const created = [];
  h.runtime.listAgents = async () => [];
  h.runtime.createProbeAgent = async ({ name, workspace, model }) => {
    created.push({ name, workspace, model });
    return { id: name, name };
  };
  const api = await startApi(h);
  try {
    const reject = await api.call("POST", `/api/work/brains/${brain.id}/sandboxes`, { name: "box-1" });
    assert.equal(reject.status, 400, "tanpa prefiks sem- ditolak (diskriminator asal D32)");

    const relative = await api.call("POST", `/api/work/brains/${brain.id}/sandboxes`, { name: "semanggi-box-1", workspace: "workspaces/relatif" });
    assert.equal(relative.status, 400, "workspace relatif adalah agent yang bekerja di mana-mana (pelajaran D65)");

    const acpReject = await api.call("POST", `/api/work/brains/${acp.id}/sandboxes`, { name: "semanggi-claude" });
    assert.equal(acpReject.status, 400);
    assert.match(acpReject.body.error, /ACP harness/);

    const ok = await api.call("POST", `/api/work/brains/${brain.id}/sandboxes`, { name: "Semanggi Box Alpha!" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.sandbox.name, "semanggi-box-alpha", "nama dislugkan");
    assert.equal(ok.body.sandbox.model, "zai/glm-5.2", "model dikunci ke brain");
    assert.ok(ok.body.sandbox.workspace.startsWith("/"), "workspace default absolut");
    assert.deepEqual(created.map((c) => c.name), ["semanggi-box-alpha"]);
  } finally {
    await api.close();
  }
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
