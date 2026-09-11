// POC-10 T2 — pool sandbox chat `sem-chat-*`: reuse, provision ulang pasca-kill,
// batas chat_concurrency_limit yang INDEPENDEN dari batas task, dan pemulihan
// kunci nama gateway — plus bukti bahwa keeper task (D81) tidak pernah
// menyentuh armada chat.
//
// Workspace di sini adalah MILIK PROJECT, persis, tanpa akhiran — itu inti
// POC-10 (E1/D92) dan setiap tes yang menyentuh provisioning meng-assert-nya
// eksplisit, supaya tidak ada "perbaikan" di masa depan yang diam-diam
// memindahkan agen chat keluar dari project-nya.
import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../../src/db/index.mjs";
import { createEventLog } from "../../src/domain/events.mjs";
import { createRepositories } from "../../src/domain/repositories.mjs";
import { createChatSandbox } from "../../src/domain/chat-sandbox.mjs";
import { createSandboxProvision } from "../../src/domain/sandbox-provision.mjs";

const quietLog = { info() {}, warn() {}, error() {} };

async function fixture({
  resource = { chat_limit: 2, task_limit: 4 },
  live = [],
  brain = { id: "BRN-1", name: "GLM 4.7 Chat", provider: "zai", model: "glm-4.7", enabled: true },
  createImpl = null,
  listImpl = null,
  visibleOpts = {},
} = {}) {
  const store = await openStore({ driver: "sqlite", location: ":memory:" });
  const events = createEventLog(store);
  const repos = createRepositories(store, events, { log: quietLog });
  // Project SUNGGUHAN, bukan stub: chat_sandboxes.projects FK ON DELETE
  // CASCADE ditegakkan database, dan repo chat menolak project hantu dengan
  // alasan yang sama.
  const project = await repos.projects.create({ name: "Alpha Repo", workspacePath: "/nfs/workspaces/alpha" });
  if (resource) {
    await repos.resources.upsert({
      provider: brain.provider,
      model: brain.model,
      concurrencyLimit: resource.task_limit,
    });
    if (resource.chat_limit !== undefined) {
      await repos.resources.setChatConcurrencyLimit(brain.provider, brain.model, resource.chat_limit);
    }
  }
  const created = [];
  const runtime = {
    listAgents: listImpl ?? (async () => live.slice()),
    createProbeAgent: createImpl ?? (async ({ name, workspace, model }) => {
      const agent = { id: name, name, workspace, model: { primary: model } };
      created.push(agent);
      live.push(agent);
      return { id: name, name };
    }),
  };
  const chat = createChatSandbox({ repos, runtime, events, log: quietLog, ...visibleOpts });
  return { chat, repos, runtime, created, live, events, brain, project };
}

// --- provision & reuse --------------------------------------------------------

test("provision: nama sem-chat-<project>-<brain>, workspace = MILIK PROJECT persis", async () => {
  const f = await fixture();
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.equal(out.name, "sem-chat-alpha-repo-glm-4-7-chat");
  assert.equal(out.workspace, "/nfs/workspaces/alpha", "tanpa akhiran, tanpa probe root — E1/D92");
  assert.equal(f.created[0].model.primary, "zai/glm-4.7");

  const row = await f.repos.chatSandboxes.get(f.project.id, f.brain.id);
  assert.equal(row.agent_id, "sem-chat-alpha-repo-glm-4-7-chat");
  assert.ok((await f.events.list({ kind: "chat.sandbox-provisioned" })).length === 1);
});

test("reuse: sesi kedua pada (project, brain) sama TIDAK menumbuhkan agen baru", async () => {
  const f = await fixture();
  const first = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  const second = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.agentId, first.agentId);
  assert.equal(f.created.length, 1, "satu baris (project, brain) = satu agen gateway (§6)");
});

test("pasca-kill: baris yatang dibuang dan pesan berikutnya memprovisikan ulang", async () => {
  const f = await fixture();
  await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  // Operator kill lewat Process Manager (D78): agen hilang dari armada, baris
  // DB tidak pernah diberi tahu. Pesan berikutnya harus jalan (§11).
  f.live.splice(0, f.live.length);
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.reused, false);
  assert.equal(f.created.length, 2);
  const row = await f.repos.chatSandboxes.get(f.project.id, f.brain.id);
  assert.equal(row.agent_id, f.created[1].id, "baris menunjuk agen yang hidup sekarang");
});

// --- jendela visibilitas create→list (terukur 2–5 dtk di gateway) -----------

test("visibilitas: create dijawab sebelum agen muncul di list → provision MENUNGGU, bukan gagal", async () => {
  const name = "sem-chat-alpha-repo-glm-4-7-chat";
  let listCalls = 0;
  const f = await fixture({
    // createProbeAgent sukses SEGERA tetapi TIDAK memasukkan agen ke live —
    // meniru gateway sungguhan (CHS-E6A3263B): registry hanya mendaftarkan
    // agen beberapa detik kemudian, dan agent.run membaca registry itu.
    createImpl: async ({ name: n }) => ({ id: n, name: n }),
    listImpl: async () => {
      listCalls += 1;
      return listCalls >= 3 ? [{ id: name, name }] : [];
    },
    visibleOpts: { visibleWaitMs: 2_000, visiblePollMs: 5 },
  });
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, true, "polling sampai terlihat, lalu sukses");
  assert.equal(out.reused, false);
  assert.ok(listCalls >= 3, `melewati setidaknya satu putaran kosong (calls=${listCalls})`);
  assert.ok((await f.events.list({ kind: "chat.sandbox-provisioned" })).length === 1);
});

test("visibilitas: lewat batas waktu → gagal jujur, baris TETAP ditulis, pesan berikutnya reuse", async () => {
  const name = "sem-chat-alpha-repo-glm-4-7-chat";
  let visible = false;
  const f = await fixture({
    createImpl: async ({ name: n }) => ({ id: n, name: n }),
    listImpl: async () => (visible ? [{ id: name, name }] : []),
    visibleOpts: { visibleWaitMs: 30, visiblePollMs: 5 },
  });
  const first = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(first.ok, false);
  assert.equal(first.why, "agent-not-yet-visible");
  assert.match(first.error, /send the message again in a moment/);
  assert.ok((await f.events.list({ kind: "chat.sandbox-not-visible" })).length === 1);

  // Baris DB tetap ada: agen itu nyata di gateway, hanya belum terdaftar.
  const row = await f.repos.chatSandboxes.get(f.project.id, f.brain.id);
  assert.equal(row.agent_id, name);

  // Agen akhirnya muncul → pesan berikutnya menemukan jalur reuse, tanpa
  // provisioning ganda dan tanpa event provisioned palsu yang kedua.
  visible = true;
  const second = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true, "tidak ada agen kedua yang diciptakan");
  assert.equal(second.agentId, name);
  assert.ok((await f.events.list({ kind: "chat.sandbox-provisioned" })).length === 0, "event provisioned hanya untuk jalur create");
});

// --- batas: kolom sendiri, independen dari task (§10.3) -----------------------

test("cap-full: batas chat tercapai → tolak, dan batas task TIDAK memengaruhi", async () => {
  const f = await fixture({
    resource: { chat_limit: 1, task_limit: 99 },
    live: [{ id: "sem-chat-lain", name: "sem-chat-lain", model: { primary: "zai/glm-4.7" } }],
  });
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, false);
  assert.equal(out.why, "cap-full");
  assert.equal(out.live, 1);
  assert.equal(f.created.length, 0, "concurrency_limit task 99 tidak membuka slot chat");
});

test("cap hanya menghitung agen sem-chat — armada task tidak memakan kuota chat", async () => {
  const f = await fixture({
    resource: { chat_limit: 1, task_limit: 1 },
    live: [
      { id: "sem-auto-glm-4-7-1", name: "sem-auto-glm-4-7-1", model: { primary: "zai/glm-4.7" } },
      { id: "sem-worker-a", name: "sem-worker-a", model: { primary: "zai/glm-4.7" } },
    ],
  });
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, true, "dua arah independensi: agen task bukan agen chat");
});

test("pagar D80 cermin: tanpa baris resource dan harness ditolak dengan alasan", async () => {
  const noRes = await fixture({ resource: null });
  assert.equal((await noRes.chat.resolveChatSandbox({ project: noRes.project, brain: noRes.brain })).why, "no-resource-entry");

  const harness = await fixture({
    brain: { id: "BRN-CC", name: "claude code", provider: "claude-code", model: "claude-code", acpAgent: "x", enabled: true },
  });
  assert.equal((await harness.chat.resolveChatSandbox({ project: harness.project, brain: harness.brain })).why, "acp-harness");
  assert.equal(noRes.created.length + harness.created.length, 0);
});

// --- pemulihan kunci gateway ---------------------------------------------------

test("kunci nama: deletion-cleanup pending → variasi -r, workspace TETAP milik project", async () => {
  const seen = [];
  let attempt = 0;
  const f = await fixture({
    createImpl: async ({ name, workspace, model }) => {
      seen.push({ name, workspace });
      attempt += 1;
      // Percobaan pertama menolak seperti gateway sungguhan; percobaan ulang
      // (variasi nama) berhasil. Pola variasi "-r<shortId>" bisa mengandung
      // "-rr-" — nama dasar sendiri mengandung "-repo", jadi pengenal di sini
      // adalah nomor percobaan, bukan regex atas nama.
      if (attempt === 1) {
        const err = new Error(`agent "${name}" deletion cleanup is still pending`);
        err.code = "INVALID_REQUEST";
        throw err;
      }
      const agent = { id: name, name, workspace, model: { primary: model } };
      f.live.push(agent);
      return { id: name, name };
    },
  });
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, true, "variasi nama adalah jalan keluar, bukan kegagalan (D81)");
  assert.equal(seen.length, 2, "satu percobaan ulang saja");
  assert.ok(seen[1].name.startsWith("sem-chat-alpha-repo-glm-4-7-chat-r"), "variasi menempel di nama dasarnya");
  assert.equal(seen[1].workspace, "/nfs/workspaces/alpha", "workspace tidak pernah divariasikan");
});

test("kunci nama: percobaan ulang yang gagal kembali sebagai why, tidak throw", async () => {
  const f = await fixture({
    createImpl: async () => {
      const err = new Error(`agent "x" deletion cleanup is still pending`);
      err.code = "INVALID_REQUEST";
      throw err;
    },
  });
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, false);
  assert.equal(out.why, "create-failed", "jalur pesan mendapat jawaban, bukan 500");
});

test("legacy workspace: TIDAK direlokasi — chat tanpa workspace project adalah kegagalan menyamar", async () => {
  let calls = 0;
  const f = await fixture({
    createImpl: async ({ name, workspace }) => {
      calls++;
      const err = new Error(`Legacy workspace setup state requires migration for ${workspace}; run openclaw doctor --fix.`);
      err.code = "UNAVAILABLE";
      throw err;
    },
  });
  const out = await f.chat.resolveChatSandbox({ project: f.project, brain: f.brain });
  assert.equal(out.ok, false);
  assert.equal(out.why, "legacy-workspace-state");
  assert.equal(calls, 1, "tidak ada percobaan ulang — beda sadar dari D80");
  assert.equal(await f.repos.chatSandboxes.get(f.project.id, f.brain.id), null, "tidak ada baris untuk agen yang tidak lahir");
});

// --- keeper task tidak menyentuh armada chat (T2 butir 5) ---------------------

test("keeper D81: reconcileAll tidak pernah memangkas sem-chat-*", async () => {
  const store = await openStore({ driver: "sqlite", location: ":memory:" });
  const events = createEventLog(store);
  const repos = createRepositories(store, events, { log: quietLog });
  await repos.resources.upsert({ provider: "zai", model: "glm-4.7", concurrencyLimit: 4 });
  const chatAgent = { id: "sem-chat-alpha-repo-glm-4-7-chat", name: "sem-chat-alpha-repo-glm-4-7-chat", model: { primary: "zai/glm-4.7" } };
  const live = [chatAgent];
  const brains = {
    list: async () => [
      { id: "BRN-1", name: "glm-4-7", provider: "zai", model: "glm-4.7", enabled: true, minSandboxes: 0 },
    ],
  };
  const runtime = {
    listAgents: async () => live.slice(),
    deleteAgent: async ({ agentId }) => {
      live.splice(live.findIndex((a) => a.id === agentId), 1);
      return { removedBindings: 1 };
    },
  };
  const provision = createSandboxProvision({ brains, runtime, repos, events, log: quietLog });
  const out = await provision.reconcileAll();
  assert.equal(out.killed, 0, "prefiks sem-chat- bukan milik lantai task — AUTO_PREFIX hanya sem-auto-");
  assert.equal(live.length, 1);
});
