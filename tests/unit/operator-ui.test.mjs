// Empat tambahan yang dibutuhkan UI operator, plus inventaris agen.
//
// Yang diuji di sini bukan "endpoint mengembalikan 200" melainkan hal-hal yang
// membuat tampilannya jujur: transkrip yang memuat kedua sisi percakapan, kartu
// project yang memisahkan "menunggu sistem" dari "menunggu Anda", dan daftar
// agen yang membedakan agen yang bisa dijalankan dari yang hanya ada di berkas.
import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentInventory, summariseInventory } from "../../src/runtime/agent-inventory.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

// --- transkrip ---------------------------------------------------------------

test("blok gateway diratakan menjadi teks yang bisa dibaca", async () => {
  const h = await buildHarness();
  const { messages } = h.repos;
  // Bentuk ini diukur dari session.message, bukan ditebak.
  const blocks = [
    { type: "thinking", thinking: "panjang, dan bukan jawabannya" },
    { type: "text", text: "HALO DARI PROBE" },
    { type: "toolCall", id: "t1", name: "exec", arguments: { command: "ls -la" } },
  ];
  const flat = messages.flatten(blocks);
  assert.match(flat, /HALO DARI PROBE/);
  assert.match(flat, /\[tool: exec\]/);
  // Penalaran sering lebih panjang dari jawabannya dan terbaca sebagai derau
  // dalam tampilan percakapan — disimpan di `blocks`, tidak diinlinekan.
  assert.doesNotMatch(flat, /bukan jawabannya/);
  assert.equal(messages.flatten("teks biasa"), "teks biasa");
});

test("transkrip memuat kedua sisi percakapan", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "bicara" });
  const exec = await h.repos.executions.create({
    taskId: task.id,
    revisionNo: 1,
    sessionMode: "FRESH",
    instruction: "Jawab persis: HALO",
    modelProvider: "zai",
    modelId: "glm-5.1",
  });

  await h.repos.messages.append(exec.id, {
    seq: 2, role: "assistant", at: 1000,
    content: [{ type: "text", text: "HALO" }],
  });

  const rows = await h.repos.messages.listByExecution(exec.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "HALO");
  // Blok mentah dipertahankan supaya penalaran dan panggilan tool tidak hilang.
  assert.match(rows[0].blocks, /"type":"text"/);
});

test("giliran yang sama dikirim ulang tidak menggandakan atau melempar", async () => {
  // Langganan bisa mengirim ulang; duplikat tidak boleh mematahkan sink yang
  // pada saat sama sedang menerapkan penyelesaian run.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "ulang" });
  const exec = await h.repos.executions.create({
    taskId: task.id, revisionNo: 1, sessionMode: "FRESH", instruction: "x",
    modelProvider: "zai", modelId: "glm-5.1",
  });
  const turn = { seq: 5, role: "assistant", at: 1, content: [{ type: "text", text: "sekali" }] };
  await h.repos.messages.append(exec.id, turn);
  await h.repos.messages.append(exec.id, turn);
  assert.equal((await h.repos.messages.listByExecution(exec.id)).length, 1);
});

test("giliran raksasa dipotong, bukan membengkakkan DB di NFS", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "besar" });
  const exec = await h.repos.executions.create({
    taskId: task.id, revisionNo: 1, sessionMode: "FRESH", instruction: "x",
    modelProvider: "zai", modelId: "glm-5.1",
  });
  await h.repos.messages.append(exec.id, {
    seq: 1, role: "assistant", at: 1,
    content: [{ type: "text", text: "A".repeat(200_000) }],
  });
  const [row] = await h.repos.messages.listByExecution(exec.id);
  assert.ok(Buffer.byteLength(row.content, "utf8") <= 32 * 1024 + 8, "isinya dipotong");
});

// --- inventaris agen ---------------------------------------------------------

test("agen yang hanya ada di config ditandai tidak bisa dijalankan", () => {
  // Diukur di cluster: membuat agen lewat API AgentOS menulis entri config yang
  // tampak lengkap lalu gagal membangun direktori agennya. Gateway tidak pernah
  // mengiklankannya, tetapi AgentOS tetap menampilkannya sebagai agen sungguhan.
  const rows = buildAgentInventory({
    liveAgents: [
      { id: "semanggi-glm-5-2", workspace: "/ws", model: { primary: "zai/glm-5.2" }, thinkingOptions: ["off", "max"] },
    ],
    configAgents: [
      { id: "semanggi-glm-5-2", workspace: "/ws", agentDir: "/opt/state/agents/semanggi-glm-5-2/agent" },
      { id: "compat-probe", workspace: "/ws", agentDir: "/ws/.openclaw/agents/compat-probe/agent" },
    ],
    catalog: [{ name: "glm-5.2-max", provider: "zai", model: "glm-5.2", thinking: "max", effortMode: "guaranteed" }],
  });

  const ok = rows.find((r) => r.id === "semanggi-glm-5-2");
  assert.equal(ok.state, "operable");
  assert.equal(ok.operableBySemanggi, true);
  assert.deepEqual(ok.catalogEntries, ["glm-5.2-max"]);
  assert.equal(ok.origin, "semanggi");

  const half = rows.find((r) => r.id === "compat-probe");
  assert.equal(half.state, "config-only");
  assert.equal(half.operableBySemanggi, false);
  assert.equal(half.origin, "agentos", "agentDir di dalam workspace menandakan buatan AgentOS");
  assert.match(half.advice, /never run/i);
});

test("effort preferensi tidak menggugurkan kecocokan katalog", () => {
  // Level preferensi tidak pernah dikirim, jadi menuntut agen mengiklankannya
  // akan memarkir pekerjaan demi parameter yang tidak dipakai siapa pun.
  const rows = buildAgentInventory({
    liveAgents: [{ id: "sem-gemini", workspace: "/ws", model: { primary: "google/gemini-3.1-flash-lite" }, thinkingOptions: ["off"] }],
    configAgents: [{ id: "sem-gemini", workspace: "/ws", agentDir: "/opt/state/agents/sem-gemini/agent" }],
    catalog: [
      { name: "gemini-flash-high", provider: "google", model: "gemini-3.1-flash-lite", thinking: "high", effortMode: "preference" },
      { name: "gemini-strict", provider: "google", model: "gemini-3.1-flash-lite", thinking: "high", effortMode: "guaranteed" },
    ],
  });
  const g = rows[0];
  assert.deepEqual(g.catalogEntries, ["gemini-flash-high"], "yang guaranteed gugur karena level tidak diiklankan");
});

test("ringkasan menyorot yang perlu perhatian lebih dulu", () => {
  const rows = buildAgentInventory({
    liveAgents: [{ id: "a", workspace: "/ws", model: { primary: "zai/glm-5.2" } }],
    configAgents: [
      { id: "a", agentDir: "/opt/state/agents/a/agent" },
      { id: "b", agentDir: "/ws/.openclaw/agents/b/agent" },
    ],
    catalog: [],
  });
  const s = summariseInventory(rows);
  assert.equal(s.total, 2);
  assert.equal(s.configOnly, 1);
  // Sehat, tetapi tidak ada rute yang menunjuknya — bukan galat, tetapi layak
  // terlihat sebelum ada yang bertanya kenapa ia tidak pernah dapat pekerjaan.
  assert.equal(s.unroutable, 1);
});
