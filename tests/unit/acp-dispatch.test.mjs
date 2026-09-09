// D88 — Brain harness didispatch lewat `acp.spawn`, tidak pernah lewat `agent`.
//
// KENAPA TES INI ADA
//
// Diukur pada gateway 2026.8.2: sebuah agen dengan `runtime.type="acp"` yang
// dijalankan lewat method `agent` tetap dieksekusi oleh model embedded. Kontrak
// ACP-nya diterima, disimpan, hot-reload, diiklankan — lalu diabaikan, tanpa
// satu baris log. Run seperti itu melewati sandbox, `.claude-home`, dan
// interposer gerbang izin, sambil memakai kuota provider lain.
//
// Karena kegagalannya SUNYI, tidak ada gunanya menguji "acp.spawn berhasil".
// Yang diuji di sini adalah hal yang tidak boleh terjadi: frame `agent` untuk
// sebuah Brain harness, dalam keadaan apa pun — termasuk saat acp.spawn gagal.
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayRuntime, GatewayContractError } from "../../src/runtime/gateway-ws.mjs";

const ACP_METHODS = ["agent.run", "connect", "agents.list", "acp.spawn"];

function fakeSocketFactory({ methods = ACP_METHODS, onRequest, agents = [] } = {}) {
  const sent = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = {};
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n-1" } }),
        });
        this.emit("open", {});
      });
    }
    addEventListener(name, fn) {
      (this.listeners[name] ??= []).push(fn);
    }
    emit(name, ev) {
      for (const fn of this.listeners[name] ?? []) fn(ev);
    }
    send(raw) {
      const frame = JSON.parse(raw);
      sent.push(frame);
      if (frame.method === "connect") {
        setTimeout(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 4, features: { methods }, auth: { scopes: ["operator.admin"] } },
            }),
          });
        }, 1);
        return;
      }
      setTimeout(() => {
        if (frame.method === "agents.list") {
          this.emit("message", { data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { agents } }) });
          return;
        }
        const result = onRequest?.(frame) ?? {
          ok: true,
          payload: { status: "accepted", childSessionKey: "agent:claude-opus:acp:uuid-1", runId: "run-acp-1" },
        };
        this.emit("message", { data: JSON.stringify({ type: "res", id: frame.id, ...result }) });
      }, 1);
    }
    close() {
      this.readyState = 3;
      this.emit("close", { reason: "test" });
    }
  }
  return { FakeWS, sent };
}

const harnessDispatch = {
  task: { id: "TASK-9", project_id: "PRJ" },
  execution: { id: "TASK-9#1", session_ref: null, revision_no: 1 },
  candidate: { provider: "claude-code", model: "claude-code", acpAgent: "claude-opus", mode: "acp", thinking: "high" },
  worker: { id: "W1", agent_ref: "sdmk-kader-architect", role: "architect" },
  workspacePath: "/nfs/workspaces/alpha",
  instruction: "kerjakan ini",
};

test("D88: harness memakai acp.spawn, bukan agent", async () => {
  const { FakeWS, sent } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const out = await rt.dispatch(harnessDispatch);

  const methods = sent.map((f) => f.method);
  assert.ok(methods.includes("acp.spawn"));
  assert.ok(!methods.includes("agent"), "frame `agent` MUST TIDAK PERNAH terkirim untuk Brain harness");
  assert.ok(!methods.includes("agent.run"));

  const frame = sent.find((f) => f.method === "acp.spawn");
  assert.equal(frame.params.agentId, "claude-opus", "harness yang disebut, bukan agen worker");
  assert.equal(frame.params.ownerAgentId, "sem-acp-owner");
  assert.equal(frame.params.cwd, "/nfs/workspaces/alpha");
  // P4-11: satu execution adalah satu percobaan. Tanpa kunci ini, pengiriman
  // ulang setelah balasan hilang melahirkan run harness KEDUA — kuota Claude
  // kedua, dan efek samping kedua di workspace.
  assert.equal(frame.params.idempotencyKey, "TASK-9#1");
  // Effort dipaku di launcher acpx; mengirimnya dari sini menciptakan sumber
  // kebenaran kedua yang bisa berselisih dengan yang benar-benar berjalan.
  assert.equal(frame.params.thinking, undefined);
  assert.equal(frame.params.model, undefined);

  assert.equal(out.sessionKey, "agent:claude-opus:acp:uuid-1");
  assert.equal(out.sessionRef, "agent:claude-opus:acp:uuid-1");
  assert.equal(out.runtimeRef, "run-acp-1");
  await rt.close();
});

test("D88: CONTINUE menyambung sesi harness lewat resumeSessionId", async () => {
  const { FakeWS, sent } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const out = await rt.dispatch({
    ...harnessDispatch,
    execution: { id: "TASK-9#2", session_ref: "agent:claude-opus:acp:uuid-1", revision_no: 1 },
  });
  const frame = sent.find((f) => f.method === "acp.spawn");
  assert.equal(frame.params.resumeSessionId, "agent:claude-opus:acp:uuid-1");
  // Sesi yang disambung tetap sesi yang sama; menukarnya dengan kunci baru akan
  // memutus rantai CONTINUE tanpa ada yang menyadarinya.
  assert.equal(out.sessionRef, "agent:claude-opus:acp:uuid-1");
  await rt.close();
});

test("D88: acp.spawn yang gagal TIDAK jatuh ke `agent`", async () => {
  const { FakeWS, sent } = fakeSocketFactory({
    onRequest: (frame) =>
      frame.method === "acp.spawn"
        ? { ok: false, error: { code: "FORBIDDEN", message: "acp disabled by policy (acp_disabled)" } }
        : undefined,
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(() => rt.dispatch(harnessDispatch));
  // Inti D85/D86: run yang "berhasil" di tempat yang salah lebih buruk daripada
  // task yang terparkir.
  assert.ok(!sent.some((f) => f.method === "agent" || f.method === "agent.run"));
  await rt.close();
});

test("D88: gateway tanpa acp.spawn menolak dispatch, bukan mencoba `agent`", async () => {
  const { FakeWS, sent } = fakeSocketFactory({ methods: ["agent.run", "connect", "agents.list"] });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () => rt.dispatch(harnessDispatch),
    (err) => {
      assert.ok(err instanceof GatewayContractError);
      assert.match(err.message, /acp\.spawn/);
      return true;
    },
  );
  assert.ok(!sent.some((f) => f.method === "agent" || f.method === "agent.run"));
  await rt.close();
});

test("D88: Brain harness tanpa acpAgent ditolak dengan menyebut yang harus diisi", async () => {
  const { FakeWS, sent } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () =>
      rt.dispatch({
        ...harnessDispatch,
        candidate: { ...harnessDispatch.candidate, acpAgent: null, brain: { id: "B1", name: "claude-opus-high" } },
      }),
    (err) => {
      assert.match(err.message, /acpAgent/);
      assert.match(err.message, /claude-opus-high/, "pesan MUST menyebut Brain mana yang salah");
      return true;
    },
  );
  assert.ok(!sent.some((f) => f.method === "acp.spawn"));
  await rt.close();
});

test("D88: Brain biasa tidak berubah — tetap lewat agent.run", async () => {
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [{ id: "poc3-worker", workspace: "/nfs/w", model: { primary: "zai/glm-4.7" } }],
    onRequest: (frame) => (frame.method === "agent.run" ? { ok: true, payload: { runId: "run-1" } } : undefined),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({
    task: { id: "TASK-1", project_id: "PRJ" },
    execution: { id: "TASK-1#1", session_ref: null, revision_no: 1 },
    candidate: { provider: "zai", model: "glm-4.7", mode: "interactive" },
    worker: { id: "W1", agent_ref: "poc3-worker" },
    workspacePath: "/nfs/w",
    instruction: "do the thing",
  });
  assert.ok(sent.some((f) => f.method === "agent.run"));
  assert.ok(!sent.some((f) => f.method === "acp.spawn"));
  await rt.close();
});
