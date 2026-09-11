// POC-10 T5 — poller penyelesaian giliran chat: baris brain RUNNING disegel
// DONE dari transkrip gateway (chat.history), bukan dari frame res dispatch
// yang pada gateway fork hanya mengatakan "accepted" (diukur di CHS-E6A3263B:
// baris DONE berisi kosong karena jawaban tidak pernah ada di situ).
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";
import { createChatCompletion, extractReplyText, findTurnReply } from "../../src/domain/chat-completion.mjs";

async function fixture({ history = {}, turnTimeoutMs = 600_000 } = {}) {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const brain = await h.brains.create({ name: "glm-chat", provider: "zai", model: "glm-4.7" });
  const session = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "operator-a" });

  const runtime = {
    request: async (method, params) => {
      if (method !== "chat.history") throw new Error(`unexpected method ${method}`);
      const found = history[params.sessionKey];
      if (found === undefined) throw new Error("no such session");
      return found;
    },
  };
  const completion = createChatCompletion({
    repos: h.repos,
    events: h.events,
    runtime,
    log: { info() {}, warn() {}, error() {} },
    now: h.clock.now,
    config: { turnTimeoutMs },
  });
  return { ...h, session, completion, runtime, history };
}

/** Baris brain PENDING + operator DONE, lalu majukan ke RUNNING + ref. */
async function inflightTurn(f, { ref = "agent:sem-chat-x:chat:S1" } = {}) {
  await f.repos.chatMessages.append({ sessionId: f.session.id, role: "operator", content: "halo" });
  const msg = await f.repos.chatMessages.append({ sessionId: f.session.id, role: "brain", content: "", status: "PENDING" });
  await f.repos.chatMessages.updateDelivery(msg.id, { status: "RUNNING" });
  await f.repos.chatSessions.setGatewayRef(f.session.id, ref);
  return msg.id;
}

test("selesai: balasan sesudah pesan user kita → DONE dengan teks <final> yang dibersihkan", async () => {
  const f = await fixture();
  const id = await inflightTurn(f);
  f.history["agent:sem-chat-x:chat:S1"] = {
    messages: [
      { role: "assistant", content: "jawaban giliran LAMA" }, // milik giliran sebelumnya — posisi, bukan keberadaan
      { role: "user", content: "halo", idempotencyKey: "CHM-LAIN:user" },
      { role: "user", content: "halo", idempotencyKey: `${id}:user` },
      { role: "assistant", content: [{ type: "text", text: " <final>Halo operator.<!-- marker --></final>" }] },
    ],
  };

  const out = await f.completion.completeOnce();
  assert.equal(out.done, 1);
  const row = await f.repos.chatMessages.get(id);
  assert.equal(row.status, "DONE");
  assert.equal(row.content, "Halo operator.", "<final> dan komentar HTML dilepas");
  assert.ok((await f.events.list({ kind: "chat.message-completed" })).length === 1);
});

test("menunggu: user message kita belum tercatat → baris tetap RUNNING, bukan gagal", async () => {
  const f = await fixture();
  const id = await inflightTurn(f);
  f.history["agent:sem-chat-x:chat:S1"] = { messages: [{ role: "assistant", content: "lama" }] };

  const out = await f.completion.completeOnce();
  assert.equal(out.waiting, 1);
  assert.equal((await f.repos.chatMessages.get(id)).status, "RUNNING");
});

test("timeout: giliran tua tanpa jawaban → FAILED jujur, termasuk yatim PENDING tanpa ref", async () => {
  const f = await fixture({ turnTimeoutMs: 1_000 });
  const id = await inflightTurn(f);
  const orphan = await f.repos.chatMessages.append({ sessionId: f.session.id, role: "brain", content: "", status: "PENDING" });
  f.history["agent:sem-chat-x:chat:S1"] = { messages: [] };

  f.clock.advance(2_000);
  const out = await f.completion.completeOnce();
  assert.equal(out.failed, 2);
  for (const row of [await f.repos.chatMessages.get(id), await f.repos.chatMessages.get(orphan.id)]) {
    assert.equal(row.status, "FAILED");
    assert.match(row.error, /timed out/);
  }
  assert.ok((await f.events.list({ kind: "chat.message-timed-out" })).length === 2);
});

test("chat.history error → menunggu: socket sesaat bukan vonis giliran", async () => {
  const f = await fixture();
  const id = await inflightTurn(f);
  f.runtime.request = async () => { throw new Error("socket hung up"); };

  const out = await f.completion.completeOnce();
  assert.equal(out.waiting, 1);
  assert.equal((await f.repos.chatMessages.get(id)).status, "RUNNING");
});

test("vonis gateway: kalimat tetap 'The agent run failed…' → FAILED, bukan DONE", async () => {
  // Cerebras/qwen-3-8-27b dan groq/qwen-medium (2026-09-11): run gagal di
  // sisi provider dan gateway fork menutupnya dengan SATU pesan asisten
  // berkalimat tetap. Tanpa vonis ini, kalimat kegagalan dibungkus DONE dan
  // operator membacanya sebagai balasan brain.
  const f = await fixture();
  const id = await inflightTurn(f);
  f.history["agent:sem-chat-x:chat:S1"] = {
    messages: [
      { role: "user", content: "halo", idempotencyKey: `${id}:user` },
      { role: "assistant", content: "The agent run failed before producing a reply." },
    ],
  };

  const out = await f.completion.completeOnce();
  assert.equal(out.failed, 1);
  const row = await f.repos.chatMessages.get(id);
  assert.equal(row.status, "FAILED");
  assert.match(row.error, /failed before producing a reply/);
  assert.equal(row.content, "", "teks vonis tidak pernah jadi konten jawaban");
  assert.ok((await f.events.list({ kind: "chat.message-failed" })).length === 1);
});

test("findTurnReply: idempotencyKey polos (tanpa :user) tetap dicocokkan; asisten kosong dilewati", () => {
  const messages = [
    { role: "user", content: "q", idempotencyKey: "CHM-A" },
    { role: "assistant", content: [{ type: "text", text: "" }] }, // blok teks kosong — bukan jawaban
    { role: "assistant", content: [{ type: "text", text: "ini jawabannya" }] },
  ];
  assert.equal(findTurnReply(messages, "CHM-A")?.content[0].text, "ini jawabannya");
  assert.equal(findTurnReply(messages, "CHM-B"), null, "giliran lain tidak mengklaim jawaban");
});

test("extractReplyText: string polos tanpa <final> tetap utuh; <final> menang atas blok sesudahnya", () => {
  assert.equal(extractReplyText("hanya teks biasa"), "hanya teks biasa");
  assert.equal(extractReplyText([{ type: "text", text: "<final>a</final>" }, { type: "text", text: "b" }]), "a");
  assert.equal(extractReplyText(" <final>x</final><!-- noise --> "), "x");
});
