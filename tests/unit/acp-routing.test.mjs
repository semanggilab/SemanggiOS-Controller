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
