// POC-10 T3 — pengiriman pesan chat (spec §5, §8, §12.6).
//
// Jangkar: dua baris transkrip per giliran (operator DONE, brain PENDING →
// DONE/FAILED); konteks T4 menempel pada pengiriman TAPI TIDAK pada transkrip;
// kunci CONTINUE disimpan sekali lalu dipakai ulang; kegagalan sandbox/gateway
// menjadi baris FAILED, tidak pernah throw; dan sepanjang semua itu TIDAK ADA
// baris tasks/executions yang lahir.
import test from "node:test";
import assert from "node:assert/strict";
import { createChatDispatch } from "../../src/domain/chat-dispatch.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";
import { nullLogger } from "../../src/domain/logger.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function flush(h, messageId, { until = "DONE", tries = 25 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const m = await h.repos.chatMessages.get(messageId);
    if (m.status === until || m.status === "FAILED") return m;
    await settle();
  }
  throw new Error(`message never left PENDING: ${JSON.stringify(await h.repos.chatMessages.get(messageId))}`);
}

async function setup({ sandbox = { ok: true, reused: true, agentId: "ag-1", name: "sem-chat" } } = {}) {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const brain = await h.brains.get("gemini-flash");
  const session = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "test" });

  const dispatched = [];
  const runtime = {
    dispatchChat: async (params) => {
      dispatched.push(params);
      if (runtime.failWith) throw new Error(runtime.failWith);
      return { runtimeRef: "run-1", sessionRef: runtime.sessionRef ?? "gw-sess-1", reply: runtime.reply ?? "pong", raw: {} };
    },
  };
  const chatSandbox = { resolveChatSandbox: async () => ({ ...sandbox }) };
  const chatDispatch = createChatDispatch({
    repos: h.repos,
    events: h.events,
    chatSandbox,
    runtime,
    brainFor: async (s) => h.brains.get(s.brain_id),
    now: h.clock.now,
    log: nullLogger,
  });
  return { h, project, worker, brain, session, chatDispatch, dispatched, runtime };
}

test("one turn writes operator DONE + brain PENDING, then the background fills DONE", async () => {
  const t = await setup();
  const { operatorMessage, brainMessage } = await t.chatDispatch.sendMessage({ session: t.session, text: "hi there" });
  assert.equal(operatorMessage.role, "operator");
  assert.equal(operatorMessage.status, "DONE");
  assert.equal(brainMessage.role, "brain");
  assert.equal(brainMessage.status, "PENDING");

  const done = await flush(t.h, brainMessage.id);
  assert.equal(done.status, "DONE");
  assert.equal(done.content, "pong");

  const transcript = await t.h.repos.chatMessages.list(t.session.id);
  assert.equal(transcript.length, 2);
  assert.deepEqual(transcript.map((m) => m.role), ["operator", "brain"]);
});

test("no task or execution row is ever born from a conversation", async () => {
  const t = await setup();
  const { brainMessage } = await t.chatDispatch.sendMessage({ session: t.session, text: "hello" });
  await flush(t.h, brainMessage.id);
  const tasks = await t.h.repos.tasks.list({});
  assert.equal(tasks.length, 0);
  const executions = await t.h.store.all(`SELECT * FROM executions`);
  assert.equal(executions.length, 0);
});

test("first dispatch stores the gateway ref once; the second CONTINUEs it", async () => {
  const t = await setup();
  const first = await t.chatDispatch.sendMessage({ session: t.session, text: "one" });
  await flush(t.h, first.brainMessage.id);
  const stored = await t.h.repos.chatSessions.get(t.session.id);
  assert.equal(stored.gateway_session_ref, "gw-sess-1");

  const fresh = await t.h.repos.chatSessions.get(t.session.id);
  const second = await t.chatDispatch.sendMessage({ session: fresh, text: "two" });
  await flush(t.h, second.brainMessage.id);
  assert.equal(t.dispatched.length, 2);
  // Kunci pertama adalah kunci segar; yang kedua HARUS ref tersimpan —
  // itulah CONTINUE-nya (pesan pertama boleh kunci apa pun, yang kedua
  // tidak boleh kunci segar lagi).
  assert.notEqual(t.dispatched[0].sessionKey, "gw-sess-1");
  assert.equal(t.dispatched[1].sessionKey, "gw-sess-1");
});

test("T4 context rides the dispatch message but never the transcript", async () => {
  const t = await setup();
  const task = await t.h.repos.tasks.create({
    projectId: t.project.id,
    workerId: t.worker.id,
    title: "ctx target",
    modelPolicy: { role: "documentation", level: "normal" },
  });
  await t.h.repos.tasks.setStatus(task.id, Status.QUEUED);

  const { brainMessage } = await t.chatDispatch.sendMessage({ session: t.session, text: `what about ${task.id}` });
  await flush(t.h, brainMessage.id);
  assert.equal(t.dispatched.length, 1);
  assert.ok(t.dispatched[0].message.includes(task.id), "context block is in the dispatch payload");
  assert.ok(t.dispatched[0].message.includes("Context injected by Semanggi"));

  const transcript = await t.h.repos.chatMessages.list(t.session.id);
  const operatorRow = transcript.find((m) => m.role === "operator");
  assert.equal(operatorRow.content, `what about ${task.id}`);
  assert.ok(!operatorRow.content.includes("Context injected"));
});

test("attachments ride the dispatch as paths, appended after the text", async () => {
  const t = await setup();
  const { brainMessage } = await t.chatDispatch.sendMessage({
    session: t.session,
    text: "please review these",
    attachments: [`chat/${t.session.id}/uploads/a.md`, `chat/${t.session.id}/uploads/b.md`],
  });
  await flush(t.h, brainMessage.id);
  assert.ok(t.dispatched[0].message.includes("[attachments:"));
  assert.ok(t.dispatched[0].message.includes("a.md"));
});

test("sandbox refusal becomes a FAILED brain row — never a throw", async () => {
  const t = await setup({ sandbox: { ok: false, why: "cap-full", live: 1, cap: 1 } });
  const { brainMessage } = await t.chatDispatch.sendMessage({ session: t.session, text: "hi" });
  const failed = await flush(t.h, brainMessage.id, { until: "FAILED" });
  assert.equal(failed.status, "FAILED");
  assert.ok(failed.error.includes("sandbox:cap-full"));
  assert.equal(t.dispatched.length, 0);
});

test("gateway failure becomes a FAILED brain row with the error text", async () => {
  const t = await setup();
  t.runtime.failWith = "gateway exploded";
  const { brainMessage } = await t.chatDispatch.sendMessage({ session: t.session, text: "hi" });
  const failed = await flush(t.h, brainMessage.id, { until: "FAILED" });
  assert.equal(failed.status, "FAILED");
  assert.ok(failed.error.includes("gateway exploded"));
});

test("missing brain row is a FAILED row, not a crash", async () => {
  const t = await setup();
  const orphan = await t.h.repos.chatSessions.create({
    projectId: t.project.id,
    brainId: "no-such-brain",
    actor: "test",
  });
  const { brainMessage } = await t.chatDispatch.sendMessage({ session: orphan, text: "hi" });
  const failed = await flush(t.h, brainMessage.id, { until: "FAILED" });
  assert.equal(failed.status, "FAILED");
  assert.ok(failed.error.includes("missing brain"));
});
