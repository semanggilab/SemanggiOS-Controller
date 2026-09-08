// D80: provisioning sandbox otomatis — lantai per Brain (keeper) dan jalur
// on-demand admission. Yang diuji adalah PAGAR, bukan keberhasilan membuat
// agen: setiap pagar yang diloloskan adalah satu cara armada tumbuh tanpa
// izin, dan itulah keputusan D32 yang dibalik D80 tapi tidak dibuang.
import test from "node:test";
import assert from "node:assert/strict";
import { createSandboxProvision } from "../../src/domain/sandbox-provision.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

const quietLog = { info() {}, warn() {}, error() {} };

function fixture({ brains = [], live = [], resource = { concurrency_limit: 4 } } = {}) {
  const created = [];
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
    },
    repos: { resources: { get: async () => resource } },
    events: { append: async (e) => events.push(e) },
    log: quietLog,
  });
  return { provision, created, events, live };
}

const brain = (over = {}) => ({
  id: "BRN1",
  name: "glm-4-7",
  provider: "zai",
  model: "glm-4.7",
  enabled: true,
  minSandboxes: 0,
  ...over,
});

// --- keeper: lantai ----------------------------------------------------------

test("keeper: lantai 2 pada armada kosong membuat dua slot deterministik", async () => {
  const f = fixture({ brains: [brain({ minSandboxes: 2 })] });
  const out = await f.provision.enforceMinimums({ actor: "keeper" });
  assert.equal(out.created, 2);
  assert.deepEqual(
    f.created.map((a) => a.name).sort(),
    ["sem-auto-glm-4-7-1", "sem-auto-glm-4-7-2"],
    "nama slot deterministik — pass berikutnya konvergen, bukan menumpuk",
  );
  assert.ok(f.created.every((a) => a.workspace.startsWith("/")), "workspace absolut");
  assert.ok(f.events.every((e) => e.kind === "brain.sandbox-auto-created"), JSON.stringify(f.events));
});

test("keeper: agen operator yang sudah hidup dihitung ke arah lantai", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 2 })],
    live: [{ id: "sem-worker-a", name: "sem-worker-a", model: { primary: "zai/glm-4.7" } }],
  });
  const out = await f.provision.enforceMinimums();
  assert.equal(out.created, 1, "lantai adalah jumlah agen, bukan jumlah agen keeper");
  assert.equal(f.created[0].name, "sem-auto-glm-4-7-1");
});

test("keeper: slot yang sudah terisi tidak dibuat ulang", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 2 })],
    live: [{ id: "x", name: "sem-auto-glm-4-7-1", model: { primary: "zai/glm-4.7" } }],
  });
  const out = await f.provision.enforceMinimums();
  assert.equal(out.created, 1);
  assert.equal(f.created[0].name, "sem-auto-glm-4-7-2", "slot 1 sudah hidup — hanya slot 2 yang kurang");
});

test("keeper: concurrency_limit resource memotong lantai", async () => {
  const f = fixture({
    brains: [brain({ minSandboxes: 3 })],
    resource: { concurrency_limit: 2 },
    live: [
      { id: "a", name: "sem-a", model: { primary: "zai/glm-4.7" } },
      { id: "b", name: "sem-b", model: { primary: "zai/glm-4.7" } },
    ],
  });
  const out = await f.provision.enforceMinimums();
  assert.equal(out.created, 0, "armada model sudah penuh — lantai kalah demi pagar");
  assert.equal(out.perBrain[0].why, "cap-full");
});

test("keeper: tanpa baris resource, tidak ada provisioning", async () => {
  const f = fixture({ brains: [brain({ minSandboxes: 2 })], resource: null });
  const out = await f.provision.enforceMinimums();
  assert.equal(out.created, 0, "operator belum menyatakan model ini boleh punya armada");
  assert.equal(out.perBrain[0].why, "no-resource-entry");
});

test("keeper: claude-code tidak pernah di-provision otomatis", async () => {
  const f = fixture({
    brains: [brain({ provider: "claude-code", model: "claude-code", acpAgent: "claude-opus", minSandboxes: 2 })],
  });
  const out = await f.provision.enforceMinimums();
  assert.equal(out.created, 0, "agen ACP dipaku routing (D78), tidak ditumbuhkan per model");
  assert.equal(f.created.length, 0);
});

test("keeper: brain nonaktif dan lantai 0 dilewati", async () => {
  const f = fixture({ brains: [brain({ enabled: false, minSandboxes: 2 }), brain({ id: "BRN2", minSandboxes: 0 })] });
  const out = await f.provision.enforceMinimums();
  assert.equal(out.created, 0);
});

// --- on-demand: admission ----------------------------------------------------

test("on-demand: kandidat tanpa agen membuat satu sandbox, bukan semua lantai", async () => {
  const f = fixture({ brains: [brain({ minSandboxes: 5 })] });
  const out = await f.provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" }, reason: "task T1" });
  assert.equal(out.created, true);
  assert.match(out.agent.name, /^sem-auto-glm-4-7-/, "prefiks asal-usul terbaca di inventaris");
  assert.equal(f.created.length, 1, "on-demand menumbuhkan JALAN keluar untuk task ini, bukan seluruh lantai");
});

test("on-demand: model tanpa brain aktif, cap penuh, dan tanpa resource tidak membuat apa pun", async () => {
  const noBrain = fixture({});
  assert.equal((await noBrain.provision.maybeProvisionForBrain({ candidate: { provider: "zai", model: "glm-4.7" } })).why, "no-brain");

  const capFull = fixture({
    brains: [brain()],
    resource: { concurrency_limit: 1 },
    live: [{ id: "a", name: "sem-a", model: { primary: "zai/glm-4.7" } }],
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
  assert.ok(dispatched.wait_reason == null || dispatched.wait_reason === "");
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
