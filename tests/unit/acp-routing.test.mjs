// D85 — sebuah Brain harness (claude-code) MUST dirutekan ke agen ACP yang
// dipakunya, dan MUST TIDAK PERNAH jatuh ke agen lain.
//
// KENAPA TES INI ADA
//
// Terukur di cluster 2026-09-08, TASK-5A24B39E: task dirutekan ke Brain
// `claude-opus-high` (acpAgent `claude-opus`) dan dijalankan oleh
// `sdmk-kader-architect` pada `zai/glm-5.2`. Controller mencatatnya
// `via: "exact"` — pencocokan dianggap berhasil.
//
// Yang membongkarnya adalah pesan kuota yang kembali: "Usage limit reached
// for 5 hour. Your limit will reset at …" adalah kalimat ZAI, bukan
// Anthropic, dan langganan Claude operator sedang sehat. Run itu memakai
// kuota provider lain sambil melewati seluruh kontrak POC-3 — sandbox,
// .claude-home, dan interposer gerbang izin — tanpa satu baris log pun.
//
// Sebabnya satu baris: `wantModel` dimatikan untuk harness tanpa ada yang
// menggantikannya, sehingga `preferAgentId` milik worker selalu lolos.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRegistry } from "../../src/runtime/agent-registry.mjs";

const WS = "/nfs/workspaces/alpha";

/** Armada tiruan: satu agen role (GLM) dan satu agen harness ACP. */
function fleet({ withHarness = true } = {}) {
  const agents = [
    { id: "sdmk-kader-architect", model: { primary: "zai/glm-5.2" }, workspace: WS, thinkingLevels: ["off", "low", "high"] },
  ];
  if (withHarness) {
    agents.push({ id: "claude-opus", model: { primary: "anthropic/claude-opus" }, workspace: WS, thinkingLevels: null });
  }
  return createAgentRegistry({ runtime: { request: async () => ({ agents }) } });
}

const harnessCandidate = (acpAgent = "claude-opus") => ({
  provider: "claude-code",
  model: "claude-code",
  acpAgent,
  mode: "acp",
  thinking: "high",
  effortMode: "preference",
});

test("D85: harness dirutekan ke agen yang namanya dipaku acpAgent", async () => {
  const registry = fleet();
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: harnessCandidate(),
    preferAgentId: "sdmk-kader-architect",
  });
  assert.equal(agent?.id, "claude-opus", "acpAgent yang menentukan, bukan agen worker");
});

test("D85: agen worker TIDAK boleh menang untuk Brain harness — regresi TASK-5A24B39E", async () => {
  // Armada tanpa agen harness: inilah keadaan cluster saat bug terjadi.
  const registry = fleet({ withHarness: false });
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: harnessCandidate(),
    preferAgentId: "sdmk-kader-architect",
  });
  // null, BUKAN sdmk-kader-architect. Tidak ada agen ACP = tidak bisa
  // dirutekan; menyerahkannya ke agen GLM adalah persis salah-rute yang
  // menghabiskan kuota ZAI dan melewati gerbang izin.
  assert.equal(agent, null);
});

test("D85: jalur override juga tidak boleh menyerahkan harness ke agen asing", async () => {
  const registry = fleet({ withHarness: false });
  // `ignoreModel: true` adalah jalur override admin — sengaja berhenti
  // memeriksa model, jadi justru di sinilah agen asing paling mudah lolos.
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: harnessCandidate(),
    preferAgentId: "sdmk-kader-architect",
    ignoreModel: true,
  });
  assert.equal(agent, null, "override model tidak mengubah agen mana yang sah untuk harness");
});

test("D85: Brain harness tanpa acpAgent tidak cocok dengan apa pun", async () => {
  const registry = fleet();
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: harnessCandidate(null),
    preferAgentId: "sdmk-kader-architect",
  });
  assert.equal(agent, null, "tanpa nama agen ACP, tidak ada yang boleh menerima run ini");
});

test("D85: kegagalan menyebut nama agen ACP, bukan model yang tidak akan pernah ada", async () => {
  const registry = fleet({ withHarness: false });
  await assert.rejects(
    () => registry.resolveOrThrow({ workspacePath: WS, candidate: harnessCandidate(), ignoreModel: false }),
    (err) => {
      assert.match(err.message, /claude-opus/, "pesan MUST menyebut agen ACP yang dicari");
      // Pesan operator dibaca saat sesuatu sedang salah; tata bahasanya
      // bagian dari kejelasannya.
      assert.ok(!/\bno the\b/.test(err.message), `frasa janggal "no the ...": ${err.message}`);
      assert.ok(
        !/providing claude-code\/claude-code/.test(err.message),
        "MUST TIDAK menyuruh operator mencari agen bermodel claude-code/claude-code — model itu tidak akan pernah ada",
      );
      return true;
    },
  );
});

test("D85: Brain non-harness tidak berubah perilaku", async () => {
  const registry = fleet();
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: { provider: "zai", model: "glm-5.2", thinking: "high", effortMode: "guaranteed" },
    preferAgentId: "sdmk-kader-architect",
  });
  assert.equal(agent?.id, "sdmk-kader-architect", "pencocokan model biasa tetap seperti sebelumnya");
});

// --- D88: agen pipa ACP tidak boleh menerima run biasa ----------------------
//
// Sejak D88, gateway memuat tiga agen yang ADA hanya untuk pipa ACP: pemilik
// sesi `sem-acp-owner` dan satu entri per harness (`claude-opus`,
// `claude-sonnet`). Tidak satu pun menyetel model sendiri, jadi gateway
// mengiklankan mereka dengan model ambient default — diukur 2026-09-09:
// ketiganya melapor `google/gemini-3.1-flash-lite` di workspace sdmk-kader,
// persis sama dengan agen kerja gemini yang sah di sana.
//
// Tanpa pagar, sebuah Brain gemini biasa bisa mendarat di `claude-opus`, dan
// yang lebih buruk di `sem-acp-owner` — yang sengaja `sandbox.mode: "off"`,
// sehingga run itu kehilangan sandbox tanpa ada yang memutuskannya.

/** Armada seperti cluster setelah D88: agen kerja + agen pipa, model sama. */
function fleetWithPlumbing() {
  const agents = [
    { id: "sdmk-kader-analyst", model: { primary: "google/gemini-3.1-flash-lite" }, workspace: WS },
    { id: "claude-opus", model: { primary: "google/gemini-3.1-flash-lite" }, workspace: WS },
    { id: "sem-acp-owner", model: { primary: "google/gemini-3.1-flash-lite" }, workspace: WS },
  ];
  return createAgentRegistry({
    runtime: {
      request: async () => ({ agents }),
      listAcpAgents: async () => ["claude", "claude-opus", "claude-sonnet"],
    },
    acpOwnerAgentId: "sem-acp-owner",
  });
}

const geminiCandidate = { provider: "google", model: "gemini-3.1-flash-lite", effortMode: "preference" };

test("D88: Brain biasa mendarat di agen kerja, bukan di agen pipa", async () => {
  const registry = fleetWithPlumbing();
  const agent = await registry.resolve({ workspacePath: WS, candidate: geminiCandidate });
  assert.equal(agent?.id, "sdmk-kader-analyst");
});

test("D88: preferAgentId pun tidak bisa menunjuk agen pipa", async () => {
  const registry = fleetWithPlumbing();
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: geminiCandidate,
    preferAgentId: "claude-opus",
  });
  assert.equal(agent?.id, "sdmk-kader-analyst", "pilihan operator tidak bisa melegalkan agen pipa");
});

test("D88: jalur override juga menolak agen pipa", async () => {
  const registry = fleetWithPlumbing();
  // `ignoreModel: true` sengaja berhenti memeriksa model — justru di sinilah
  // `sem-acp-owner` (tanpa sandbox) paling mudah lolos.
  const agent = await registry.resolve({
    workspacePath: WS,
    candidate: { provider: "zai", model: "glm-5.2" },
    preferAgentId: "sem-acp-owner",
    ignoreModel: true,
  });
  assert.notEqual(agent?.id, "sem-acp-owner");
  assert.notEqual(agent?.id, "claude-opus");
});

// --- D85: jalur pemulihan sinyal kuota yang salah alamat ----------------------
//
// Kerusakan susulan dari salah-rute harness: penolakan kuota GLM tercatat
// terhadap resource `claude-code/claude-code`, sehingga langganan Claude yang
// SEHAT terparkir sampai 2026-09-15 membawa pesan milik ZAI. PATCH resource
// sengaja tidak menyentuh sinyal live (D66), jadi tanpa endpoint ini satu-
// satunya perbaikan adalah UPDATE tangan — yang aturan 6 §4.1 larang.
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function apiFor(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("D85: clear-quota mengembalikan resource yang salah diparkir, dan mencatatnya", async () => {
  const h = await buildHarness();
  await h.repos.resources.upsert({ provider: "claude-code", model: "claude-code", concurrencyLimit: 2 });
  // Persis keadaan cluster: pesan ZAI tercatat pada resource claude-code.
  await h.repos.resources.setAvailability("claude-code", "claude-code", "QUOTA_EXHAUSTED", {
    nextAvailableAt: Date.now() + 7 * 86_400_000,
    signal: "⚠️ Usage limit reached for 5 hour. Your limit will reset at 2026-09-09 03:34:02",
  });
  const api = await apiFor(h);
  try {
    const res = await api.call("POST", "/api/work/resources/clear-quota?provider=claude-code&model=claude-code");
    assert.equal(res.status, 200);
    assert.equal(res.body.cleared, true);
    // Keadaan SEBELUM ikut dilaporkan: sebuah pembersihan yang tidak menyebut
    // apa yang dibersihkan tidak bisa ditinjau ulang.
    assert.match(res.body.before.signal, /Usage limit reached/);
    assert.equal(res.body.resource.availability, "AVAILABLE");

    const row = await h.repos.resources.get("claude-code", "claude-code");
    assert.equal(row.availability, "AVAILABLE");
    assert.equal(row.next_available_at, null);

    const events = await h.events.list({ subjectType: "resource", subjectId: "claude-code/claude-code" });
    assert.ok(events.some((e) => e.payload?.availability === "AVAILABLE"), "pembersihan MUST tercatat di event_log");
  } finally {
    await api.close();
  }
});

test("D85: clear-quota pada resource yang sudah AVAILABLE tidak berpura-pura bekerja", async () => {
  const h = await buildHarness();
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.3", concurrencyLimit: 2 });
  const api = await apiFor(h);
  try {
    const res = await api.call("POST", "/api/work/resources/clear-quota?provider=zai&model=glm-5.3");
    assert.equal(res.body.cleared, false);
    assert.match(res.body.reason, /already AVAILABLE/);
  } finally {
    await api.close();
  }
});

test("D85: resource yang tidak dikenal ditolak 404, bukan dibuat diam-diam", async () => {
  const h = await buildHarness();
  const api = await apiFor(h);
  try {
    const res = await api.call("POST", "/api/work/resources/clear-quota?provider=nope&model=nope");
    assert.equal(res.status, 404);
  } finally {
    await api.close();
  }
});
