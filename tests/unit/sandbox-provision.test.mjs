// D80/D81: provisioning sandbox otomatis — lantai per Brain (grow + trim)
// dan jalur on-demand admission. Yang diuji adalah PAGAR, bukan keberhasilan
// membuat agen: setiap pagar yang diloloskan adalah satu cara armada tumbuh
// atau menyusut tanpa izin, dan itulah keputusan D32 yang dibalik D80 tapi
// tidak dibuang.
import test from "node:test";
import assert from "node:assert/strict";
import { createSandboxProvision } from "../../src/domain/sandbox-provision.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { createApi } from "../../src/api/server.mjs";
import { once } from "node:events";

const TOKEN = "controller-token-for-tests";
const quietLog = { info() {}, warn() {}, error() {} };

function fixture({ brains = [], live = [], resource = { concurrency_limit: 4 }, busyRefs = [] } = {}) {
  const created = [];
  const killed = [];
  const events = [];
  const provision = createSandboxProvision({
    brains: { list: async ({ enabledOnly } = {}) => brains.filter((b) => (enabledOnly ? b.enabled !== false : true)) },
    runtime: {
      listAgents: async () => live.slice(),
      createProbeAgent: async ({ name, workspace, model }) => {
        const agent = { id: name, name, workspace, model: { primary: model } };
        created.push(agent);
        live.push(agent);
        return { id: name, name };
      },
      deleteAgent: async ({ agentId }) => {
        const i = live.findIndex((a) => String(a.id) === agentId);
        if (i >= 0) live.splice(i, 1);
        killed.push(agentId);
        return { removedBindings: 1 };
      },
    },
    repos: {
      resources: { get: async () => resource },
      // Atriansi "sibuk" tanpa membangun task sungguhan: refs sibuk dipetakan
      // lewat worker.agent_ref persis seperti produksi.
      tasks: { list: async () => (busyRefs.length ? [{ id: "T1", worker_id: "W1", project_id: "P1" }] : []) },
      workers: { get: async () => (busyRefs.length ? { agent_ref: busyRefs[0] } : null) },
    },
    events: { append: async (e) => events.push(e) },
    log: quietLog,
  });
  return { provision, created, killed, events, live };
}

const auto = (name) => ({ id: name, name, model: { primary: "zai/glm-4.7" } });

const brain = (over = {}) => ({
  id: "BRN1",
  name: "glm-4-7",
  provider: "zai",
  model: "glm-4.7",
  enabled: true,
  minSandboxes: 0,
  ...over,
});

// --- grow: lantai ------------------------------------------------------------

test("grow: lantai 2 pada armada kosong membuat dua slot deterministik", async () => {
  const f = fixture({ brains: [brain({ minSandboxes: 2 })] });
  const out = await f.provision.reconcileAll();
  assert.equal(out.created, 2);
  assert.deepEqual(
    f.created.map((a) => a.name).sort(),
    ["sem-auto-glm-4-7-1", "sem-auto-glm-4-7-2"],
    "nama slot deterministik — pass berikutnya konvergen, bukan menumpuk",
  );
  assert.ok(f.created.every((a) => a.workspace.startsWith("/")), "workspace absolut");
  assert.ok(f.events.every((e) => e.kind === "brain.sandbox-auto-created"), JSON.stringify(f.events));
});

test("grow: agen operator yang sudah hidup dihitung ke arah lantai", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 2 })],
    live: [{ id: "sem-worker-a", name: "sem-worker-a", model: { primary: "zai/glm-4.7" } }],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.created, 1, "lantai adalah jumlah agen, bukan jumlah agen keeper");
  assert.equal(f.created[0].name, "sem-auto-glm-4-7-1");
});

test("grow: slot yang sudah terisi tidak dibuat ulang", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 2 })],
    live: [auto("sem-auto-glm-4-7-1")],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.created, 1);
  assert.equal(f.created[0].name, "sem-auto-glm-4-7-2", "slot 1 sudah hidup — hanya slot 2 yang kurang");
});

test("grow: concurrency_limit resource memotong lantai", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 3 })],
    resource: { concurrency_limit: 2 },
    live: [auto("sem-a"), auto("sem-b")].map((a) => ({ ...a, name: a.id })),
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.created, 0, "armada model sudah penuh — lantai kalah demi pagar");
  assert.ok(out.results.some((r) => r.why.includes("cap-full")));
});

test("grow: tanpa baris resource, tidak ada provisioning", async () => {
  const f = fixture({ brains: [brain({ minSandboxes: 2 })], resource: null });
  const out = await f.provision.reconcileAll();
  assert.equal(out.created, 0, "operator belum menyatakan model ini boleh punya armada");
  assert.ok(out.results.some((r) => r.why.includes("no-resource-entry")));
});

test("grow: claude-code tidak pernah di-provision otomatis", async () => {
  const f = fixture({
    brains: [brain({ provider: "claude-code", model: "claude-code", acpAgent: "claude-opus", minSandboxes: 2 })],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.created, 0, "agen ACP dipaku routing (D78), tidak ditumbuhkan per model");
  assert.equal(out.results.length, 0, "model claude-code bahkan tidak masuk lingkup pass");
});

// --- trim: kelebihan di atas lantai ------------------------------------------

test("trim: kelebihan idle dipangkas — sbx duluan, lalu slot bernomor besar", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 2 })],
    live: [auto("sem-auto-glm-4-7-1"), auto("sem-auto-glm-4-7-2"), auto("sem-auto-glm-4-7-3"), auto("sem-auto-glm-4-7-sbx-abc")],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.killed, 2);
  assert.deepEqual(f.killed, ["sem-auto-glm-4-7-sbx-abc", "sem-auto-glm-4-7-3"], "ephemeral mati duluan, inti slot 1..N bertahan");
  assert.deepEqual(
    f.live.map((a) => a.name).sort(),
    ["sem-auto-glm-4-7-1", "sem-auto-glm-4-7-2"],
  );
  assert.ok(f.events.some((e) => e.kind === "brain.sandbox-auto-killed"), "jejak audit setara kill operator D78");
});

test("trim: agen sibuk DILEWATI, bukan dipotong dari bawah task", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 0 })],
    live: [auto("sem-auto-glm-4-7-1"), auto("sem-auto-glm-4-7-2")],
    busyRefs: ["sem-auto-glm-4-7-1"],
  });
  const out = await f.provision.reconcileAll();
  assert.deepEqual(f.killed, ["sem-auto-glm-4-7-2"], "aturan busy = aturan kill operator D78");
  const r = out.results[0];
  assert.deepEqual(r.skippedBusy, ["sem-auto-glm-4-7-1"], "yang sibuk dicatat, pass berikutnya menyusul saat idle");
});

test("trim: semua sibuk → tidak ada yang dipotong, dicatat sebagai busy-above-floor", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 0 })],
    live: [auto("sem-auto-glm-4-7-1")],
    busyRefs: ["sem-auto-glm-4-7-1"],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.killed, 0);
  assert.ok(out.results.some((x) => x.why.includes("busy-above-floor")), "konvergensi, bukan kegagalan");
});

test("trim: agen operator dan probe TIDAK PERNAH dipangkas demi lantai", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 1 })],
    live: [
      { id: "sem-worker-op", name: "sem-worker-op", model: { primary: "zai/glm-4.7" } },
      { id: "sem-workspaces-probe-zai-glm-4-7", name: "sem-workspaces-probe-zai-glm-4-7", model: { primary: "zai/glm-4.7" } },
      auto("sem-auto-glm-4-7-1"),
      auto("sem-auto-glm-4-7-2"),
    ],
  });
  const out = await f.provision.reconcileAll();
  assert.deepEqual(f.killed, ["sem-auto-glm-4-7-2", "sem-auto-glm-4-7-1"], "semua milik kita dipangkas, tertib ephemeral-dulu");
  assert.deepEqual(
    f.live.map((a) => a.name).sort(),
    ["sem-worker-op", "sem-workspaces-probe-zai-glm-4-7"],
    "operator + probe tetap hidup meski total di atas lantai — armada non-otomatis bukan urusan lantai",
  );
});

test("trim: lantai efektif model = MAX lantai brain aktif yang berbagi model", async () => {
  const f = fixture({
    brains: [
      brain({ id: "BRN1", minSandboxes: 2 }),
      brain({ id: "BRN2", name: "glm-4-7-alt", minSandboxes: 0 }),
    ],
    live: [auto("sem-auto-glm-4-7-1"), auto("sem-auto-glm-4-7-2")],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.killed, 0, "memangkas demi lantai brain B akan membocorkan lantai brain A (D79: pool milik model)");
});

test("trim: brain dinonaktifkan → lantai 0 → sisa sem-auto idle menyusut", async () => {
  const f = fixture({
    brains: [brain({ enabled: false, minSandboxes: 2 })],
    live: [auto("sem-auto-glm-4-7-1"), auto("sem-auto-glm-4-7-2")],
  });
  const out = await f.provision.reconcileAll();
  assert.equal(out.killed, 2, "disable = lantai hilang; armada otomatis ikut turun");
});

test("trim: model tanpa brain (brain dihapus) tetap dipangkas pass keeper", async () => {
  const f = fixture({ brains: [], live: [auto("sem-auto-glm-4-7-1")] });
  const out = await f.provision.reconcileAll();
  assert.equal(out.killed, 1, "agent sem-auto yatang tetap dalam lingkup pass — dari armada hidup, bukan dari brains");
});

// --- on-demand: admission ----------------------------------------------------

test("on-demand: kandidat tanpa agen membuat satu sandbox, bukan semua lantai", async () => {
  const f = fixture({ brains: [brain({ minSandboxes: 5 })] });
  const out = await f.provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" }, reason: "task T1" });
  assert.equal(out.created, true);
  assert.match(out.agent.name, /^sem-auto-glm-4-7-sbx-/, "prefiks asal-usul terbaca di inventaris");
  assert.equal(f.created.length, 1, "on-demand menumbuhkan JALAN keluar untuk task ini, bukan seluruh lantai");
});

test("on-demand: model tanpa brain aktif, cap penuh, dan tanpa resource tidak membuat apa pun", async () => {
  const noBrain = fixture({});
  assert.equal((await noBrain.provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" } })).why, "no-brain");

  const capFull = fixture({
    brains: [brain()],
    resource: { concurrency_limit: 1 },
    live: [auto("sem-a")],
  });
  assert.equal((await capFull.provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" } })).why, "cap-full");

  const noResource = fixture({ brains: [brain()], resource: null });
  assert.equal((await noResource.provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" } })).why, "no-resource-entry");

  const claude = fixture({
    brains: [brain({ provider: "claude-code", model: "claude-code", acpAgent: "claude-opus" })],
  });
  assert.equal((await claude.provision.maybeProvisionForBrain({ candidate: { provider: "claude-code", model: "claude-code" } })).why, "claude-code");

  assert.equal(noBrain.created.length + capFull.created.length + noResource.created.length + claude.created.length, 0);
});

test("on-demand: kegagalan createProbeAgent kembali sebagai why, tidak throw", async () => {
  const events = [];
  const provision = createSandboxProvision({
    brains: { list: async () => [brain()] },
    runtime: {
      listAgents: async () => [],
      createProbeAgent: async () => {
        throw new Error("gateway says no");
      },
    },
    repos: { resources: { get: async () => ({ concurrency_limit: 4 }) } },
    events: { append: async (e) => events.push(e) },
    log: quietLog,
  });
  const out = await provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" } });
  assert.equal(out.created, false);
  assert.equal(out.why, "create-failed");
  assert.match(out.error, /gateway says no/);
});

// --- end-to-end lewat admission ----------------------------------------------

test("admission: parkir no-agent menumbuhkan sandbox, dan percobaan berikutnya dispatch", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const b = await h.brains.create({ name: "glm-4.7-auto", provider: "zai", model: "glm-4.7" });

  const live = [];
  h.runtime.listAgents = async () => live.slice();
  h.runtime.createProbeAgent = async ({ name, workspace, model }) => {
    const agent = { id: name, name, workspace, model: { primary: model } };
    live.push(agent);
    return { id: name, name };
  };
  h.runtime.dispatch = async (req) => {
    const target = `${req.candidate.provider}/${req.candidate.model}`.toLowerCase();
    if (!live.some((a) => String(a.model?.primary ?? "").toLowerCase() === target)) {
      const err = new Error(`no agent available for ${target}`);
      err.name = "AgentUnavailableError";
      err.provider = req.candidate.provider;
      err.model = req.candidate.model;
      throw err;
    }
    return { runtimeRef: "run-1", sessionRef: "sess-1" };
  };

  const task = await queuedTask(h, {
    project,
    worker,
    title: "auto-provision",
    isolate: true,
    modelPolicy: { preferred: [b.name], class: "normal", category: "coding" },
  });
  await h.scheduler.notify();

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RESOURCE, "tetap parkir — provisioning tidak men-rewrite hasil admission");
  assert.equal(live.length, 1, "sandbox dibuat saat kegagalan, bukan menunggu operator");
  // Dua brain berbagi model zai/glm-4.7 (seed katalog + brain ujian), dan
  // armada adalah milik MODEL — provisioning memilih brain pertama dalam
  // urutan list() (first-wins, konvensi yang sama dengan overview D79).
  assert.match(live[0].name, /^sem-auto-glm-4-7(-|-auto-)(sbx-|$)/);

  // nextRetryAt pendek (3 dtk) — backoff 30 dtk biasa hanya menunda dispatch
  // pertama yang akan berhasil.
  h.clock.advance(4_000);
  await h.scheduler.notify();
  const dispatched = await h.repos.tasks.get(task.id);
  assert.equal(dispatched.status, Status.DISPATCHED, JSON.stringify(dispatched));
});

test("admission: tanpa createProbeAgent, parkir no-agent tetap parkir biasa", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await h.brains.create({ name: "glm-4.7-manual", provider: "zai", model: "glm-4.7" });
  h.runtime.listAgents = async () => [];
  h.runtime.dispatch = async (req) => {
    const err = new Error("no agent available");
    err.name = "AgentUnavailableError";
    err.provider = req.candidate.provider;
    err.model = req.candidate.model;
    throw err;
  };

  const task = await queuedTask(h, {
    project,
    worker,
    title: "no-provisioning",
    isolate: true,
    modelPolicy: { preferred: ["glm-4.7-manual"], class: "normal", category: "coding" },
  });
  await h.scheduler.notify();
  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_RESOURCE, "runtime tanpa provisioning = perilaku pra-D80");
});

// --- API: perubahan lantai direkonsiliasi LANGSUNG (D81) --------------------

test("API: PATCH minSandboxes menumbuhkan DAN memangkas saat itu juga", async () => {
  const h = await buildHarness();
  await seedBasics(h);
  const b = await h.brains.create({ name: "glm-4.7-floor", provider: "zai", model: "glm-4.7" });

  const live = [];
  const killed = [];
  h.runtime.listAgents = async () => live.slice();
  h.runtime.createProbeAgent = async ({ name, workspace, model }) => {
    const agent = { id: name, name, workspace, model: { primary: model } };
    live.push(agent);
    return { id: name, name };
  };
  h.runtime.deleteAgent = async ({ agentId }) => {
    const i = live.findIndex((a) => a.id === agentId);
    if (i >= 0) live.splice(i, 1);
    killed.push(agentId);
    return { removedBindings: 1 };
  };

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

  try {
    // 0 → 2: tumbuh SEBELUM jawaban kembali — operator melihat armada penuh
    // di reload berikutnya, bukan 60 detik kemudian.
    const up = await call("PATCH", `/api/work/brains/${b.id}`, { minSandboxes: 2 });
    assert.equal(up.status, 200);
    assert.equal(live.length, 2, JSON.stringify(live));

    // 2 → 1: kelebihan idle dipangkas saat itu juga.
    const down = await call("PATCH", `/api/work/brains/${b.id}`, { minSandboxes: 1 });
    assert.equal(down.status, 200);
    assert.equal(live.length, 1, JSON.stringify(live));
    assert.deepEqual(killed, ["sem-auto-glm-4-7-floor-2"], "slot bernomor besar dipangkas duluan");

    // 1 → 0: lantai hilang, sisa otomatis ikut turun.
    const zero = await call("PATCH", `/api/work/brains/${b.id}`, { minSandboxes: 0 });
    assert.equal(zero.status, 200);
    assert.equal(live.length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
