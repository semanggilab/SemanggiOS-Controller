// POC-10 T3 — permukaan HTTP chat (spec §8) di atas server sungguhan.
//
// Kontrak termahal yang dipegang di sini: 409 confirmReset (§10.2), penolakan
// mismatch projectId (§7.3), upload hanya teks di akar sesi (§7.5), dan nol
// baris tasks/executions dari seluruh alur percakapan.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.mjs";
import { createChatDispatch } from "../../src/domain/chat-dispatch.mjs";
import { nullLogger } from "../../src/domain/logger.mjs";
import { buildHarness } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function setupApi() {
  const h = await buildHarness();
  // Workspace nyata di tmpdir: route upload melakukan mkdir rekursif, dan
  // "/nfs/..." seedBasics tidak bisa dibuat di dalam container tes.
  const project = await h.repos.projects.create({
    name: "alpha",
    workspacePath: mkdtempSync(join(tmpdir(), "semanggi-chat-")),
  });
  const brain = await h.brains.get("gemini-flash");

  // Chat dispatch di-inject di atas harness: chatSandbox stub + runtime
  // dispatchChat stub — suite ini menguji KONTRAK HTTP, bukan gateway.
  const sandboxState = { ok: true, reused: true, agentId: "ag-1", name: "sem-chat" };
  h.chatSandbox = { resolveChatSandbox: async () => ({ ...sandboxState }) };
  h.runtime.dispatchChat = async () => ({
    runtimeRef: "run-1",
    sessionRef: "gw-sess-1",
    reply: "the brain answers",
    raw: {},
  });
  h.chatDispatch = createChatDispatch({
    repos: h.repos,
    events: h.events,
    chatSandbox: h.chatSandbox,
    runtime: h.runtime,
    brainFor: async (s) => h.brains.get(s.brain_id),
    now: h.clock.now,
    log: nullLogger,
  });

  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body, { token = TOKEN } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const callRaw = async (method, path, bytes) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
      body: bytes,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const close = () => new Promise((r) => server.close(r));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const waitForBrain = async (sessionId, { tries = 25 } = {}) => {
    for (let i = 0; i < tries; i += 1) {
      const detail = await call("GET", `/api/work/chat/sessions/${sessionId}`);
      const last = detail.body.messages.at(-1);
      if (last?.role === "brain" && last.status !== "PENDING" && last.status !== "RUNNING") return detail.body;
      await settle();
    }
    throw new Error("brain message never settled");
  };
  return { h, project, brain, call, callRaw, close, waitForBrain };
}

test("session CRUD over HTTP: create with explicit brain, list, read, patch", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
      title: "first room",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.session.status, "ACTIVE");
    assert.equal(created.body.session.gatewaySessionRef, null);
    assert.equal(created.body.brainDefault, false);
    const id = created.body.session.id;

    const listed = await api.call("GET", `/api/work/chat/sessions?projectId=${api.project.id}`);
    assert.equal(listed.body.sessions.length, 1);
    assert.equal(listed.body.sessions[0].title, "first room");

    const detail = await api.call("GET", `/api/work/chat/sessions/${id}`);
    assert.deepEqual(detail.body.messages, []);

    const patched = await api.call("PATCH", `/api/work/chat/sessions/${id}`, { status: "ARCHIVED" });
    assert.equal(patched.body.session.status, "ARCHIVED");
  } finally {
    await api.close();
  }
});

test("session default brain resolves without an explicit brainId (grid > catalog fallback)", async (t) => {
  const api = await setupApi();
  try {
    const res = await api.call("POST", "/api/work/chat/sessions", { projectId: api.project.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.brainDefault, true);
    const brain = await api.h.brains.get(res.body.session.brainId);
    assert.ok(brain, "resolved default must be a real brain row");
  } finally {
    await api.close();
  }
});

test("posting a message settles to a brain reply and touches no task tables", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
    });
    const id = created.body.session.id;

    const sent = await api.call("POST", `/api/work/chat/sessions/${id}/messages`, {
      projectId: api.project.id,
      text: "hello brain",
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.operatorMessage.status, "DONE");
    assert.equal(sent.body.message.status, "PENDING");

    const detail = await api.waitForBrain(id);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages.at(-1).role, "brain");
    assert.equal(detail.messages.at(-1).status, "DONE");
    assert.equal(detail.messages.at(-1).content, "the brain answers");

    const tasks = await api.h.repos.tasks.list({});
    assert.equal(tasks.length, 0);
    const executions = await api.h.store.all(`SELECT * FROM executions`);
    assert.equal(executions.length, 0);
  } finally {
    await api.close();
  }
});

test("project mismatch is refused (§7.3)", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
    });
    const other = await api.h.repos.projects.create({ name: "beta", workspacePath: "/nfs/workspaces/beta" });
    const res = await api.call("POST", `/api/work/chat/sessions/${created.body.session.id}/messages`, {
      projectId: other.id,
      text: "sneaky question",
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("belongs to project"));
  } finally {
    await api.close();
  }
});

test("brain switch: 409 without confirmReset, ref dropped and transcript kept with it", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
    });
    const id = created.body.session.id;
    await api.call("POST", `/api/work/chat/sessions/${id}/messages`, { projectId: api.project.id, text: "before switch" });
    await api.waitForBrain(id);
    const otherBrain = await api.h.brains.get("glm-5.2-max");

    const refused = await api.call("POST", `/api/work/chat/sessions/${id}/brain`, { brainId: otherBrain.id });
    assert.equal(refused.status, 409);
    assert.ok(refused.body.error.includes("confirmReset"));
    const afterRefusal = await api.call("GET", `/api/work/chat/sessions/${id}`);
    assert.equal(afterRefusal.body.session.brainId, api.brain.id, "brain_id unchanged by the refusal");
    assert.ok(afterRefusal.body.session.gatewaySessionRef, "ref unchanged by the refusal");

    const switched = await api.call("POST", `/api/work/chat/sessions/${id}/brain`, {
      brainId: otherBrain.id,
      confirmReset: true,
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.session.brainId, otherBrain.id);
    assert.equal(switched.body.session.gatewaySessionRef, null);

    const detail = await api.call("GET", `/api/work/chat/sessions/${id}`);
    assert.equal(detail.body.messages.length, 2, "transcript survives the context reset");
  } finally {
    await api.close();
  }
});

test("uploads: text lands under the session root; binary and foreign paths refused", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
    });
    const id = created.body.session.id;

    const ok = await api.callRaw("POST", `/api/work/chat/sessions/${id}/uploads?name=notes.md`, Buffer.from("# notes"));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.path, `chat/${id}/uploads/notes.md`);

    const bin = await api.callRaw("POST", `/api/work/chat/sessions/${id}/uploads?name=worm.exe`, Buffer.from("MZ"));
    assert.equal(bin.status, 400);

    const nul = await api.callRaw("POST", `/api/work/chat/sessions/${id}/uploads?name=fake.txt`, Buffer.from("a\0b"));
    assert.equal(nul.status, 400);

    // Lampiran di luar akar sesi ditolak pesan — pesan itu sendiri tidak lahir.
    const bad = await api.call("POST", `/api/work/chat/sessions/${id}/messages`, {
      projectId: api.project.id,
      text: "see this",
      attachments: ["tmp/uploads/stolen.md"],
    });
    assert.equal(bad.status, 400);
  } finally {
    await api.close();
  }
});

test("archived session refuses new messages and uploads", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
    });
    const id = created.body.session.id;
    await api.call("PATCH", `/api/work/chat/sessions/${id}`, { status: "ARCHIVED" });
    const msg = await api.call("POST", `/api/work/chat/sessions/${id}/messages`, { text: "anyone?" });
    assert.equal(msg.status, 409);
    const up = await api.callRaw("POST", `/api/work/chat/sessions/${id}/uploads?name=x.md`, Buffer.from("x"));
    assert.equal(up.status, 409);
  } finally {
    await api.close();
  }
});

test("eligibility gate lives on the server: prose yes, commands and greetings no", async (t) => {
  const api = await setupApi();
  try {    const ask = async (text) =>
      (await api.call("GET", `/api/work/chat/eligible?text=${encodeURIComponent(text)}`)).body.eligible;
    assert.equal(await ask("what do you think about event sourcing?"), true);
    assert.equal(await ask("/work build the thing"), false);
    assert.equal(await ask("status TASK-4F59F63A"), false);
    assert.equal(await ask("cancel TASK-4F59F63A"), false);
    assert.equal(await ask("halo"), false);
  } finally {
    await api.close();
  }
});

test("delete: service token (admin) succeeds, plain operator token is 403", async (t) => {
  const api = await setupApi();
  try {    const created = await api.call("POST", "/api/work/chat/sessions", {
      projectId: api.project.id,
      brainId: api.brain.id,
    });
    const id = created.body.session.id;

    const { token } = await api.h.operators.create({ name: "non-admin", role: "operator" });
    const refused = await api.call("DELETE", `/api/work/chat/sessions/${id}`, null, { token });
    assert.equal(refused.status, 403);

    const done = await api.call("DELETE", `/api/work/chat/sessions/${id}`);
    assert.equal(done.status, 200);
    const gone = await api.call("GET", `/api/work/chat/sessions/${id}`);
    assert.equal(gone.status, 404);
  } finally {
    await api.close();
  }
});
