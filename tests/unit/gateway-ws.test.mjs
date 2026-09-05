// Gateway WS dispatch adapter.
//
// Driven by a fake WebSocket that speaks the frame contract read from the
// OpenClaw source, so the handshake and dispatch logic are exercised without a
// cluster.
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayRuntime, parseGatewayQuota, GatewayContractError } from "../../src/runtime/gateway-ws.mjs";
import { AgentUnavailableError } from "../../src/runtime/agent-registry.mjs";

/** Minimal WebSocket double implementing the gateway's frame exchange. */
function fakeSocketFactory({
  methods = ["agent.run", "connect", "agents.list"],
  onRequest,
  sendChallenge = true,
  failConnect = null,
  // The fleet the gateway would report. Default: one agent in the dispatch
  // workspace configured with exactly the routed model.
  agents = [{ id: "poc3-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } }],
  // Scopes the gateway reports as granted, which is what the adapter reads.
  helloAuth = null,
} = {}) {
  const sent = [];
  const instances = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = {};
      instances.push(this);
      queueMicrotask(() => {
        if (sendChallenge) this.emit("message", { data: JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n-1" } }) });
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
            data: JSON.stringify(
              failConnect
                ? { type: "res", id: frame.id, ok: false, error: failConnect }
                : { type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 4, features: { methods }, ...(helloAuth ? { auth: helloAuth } : {}) } },
            ),
          });
        }, 1);
        return;
      }
      setTimeout(() => {
        if (frame.method === "agents.list") {
          this.emit("message", { data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { agents } }) });
          return;
        }
        const result = onRequest?.(frame) ?? { ok: true, payload: { runId: "run-123" } };
        this.emit("message", { data: JSON.stringify({ type: "res", id: frame.id, ...result }) });
      }, 1);
    }
    close() {
      this.readyState = 3;
      this.emit("close", { reason: "test" });
    }
  }
  return { FakeWS, sent, instances };
}

const baseDispatch = {
  task: { id: "TASK-1", project_id: "PRJ" },
  execution: { id: "TASK-1#1", session_ref: null },
  candidate: { provider: "zai", model: "glm-4.7", mode: "interactive" },
  worker: { id: "W1", agent_ref: "poc3-worker" },
  workspacePath: "/nfs/w/executions/TASK-1",
  instruction: "do the thing",
};

test("the handshake sends the token and waits for hello-ok", async () => {
  const { FakeWS, sent } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "tok-abc" }, { WebSocketImpl: FakeWS });
  const hello = await rt.connect();

  assert.equal(hello.type, "hello-ok");
  const connectFrame = sent.find((f) => f.method === "connect");
  assert.equal(connectFrame.type, "req");
  assert.equal(connectFrame.params.auth.token, "tok-abc");
  assert.equal(connectFrame.params.role, "operator");
  assert.ok(connectFrame.params.minProtocol <= connectFrame.params.maxProtocol);
  await rt.close();
});

// Regression from the first live handshake: ConnectParamsSchema is a closed
// object, and a root-level nonce is rejected with
//   INVALID_REQUEST "unexpected property 'nonce'".
// The nonce belongs to `device`, which a token-auth client does not send.
test("the connect frame carries no root-level nonce", async () => {
  const { FakeWS, sent } = fakeSocketFactory({ sendChallenge: true });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.connect();
  const params = sent.find((f) => f.method === "connect").params;
  assert.equal(params.nonce, undefined, "a root nonce makes the gateway reject the connection");
  assert.equal(params.device, undefined, "no device identity is signed for token auth");
  await rt.close();
});

test("a gateway advertising no run method is refused at connect, not at dispatch", async () => {
  const { FakeWS } = fakeSocketFactory({ methods: ["connect", "config.get"] });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  // Version skew must fail loudly and early rather than surfacing as a strange
  // dispatch error later.
  await assert.rejects(() => rt.connect(), /advertises none of/);
});

// Measured against the cluster: OpenClaw 2026.6.11 exposes a bare `agent`,
// while the 2026.8.1 source calls it `agent.run`. Hardcoding either name would
// have broken silently on the other version.
test("the run method is negotiated from what the server advertises", async () => {
  for (const [advertised, expected] of [
    [["connect", "agent.run", "agent"], "agent.run"],
    [["connect", "agent"], "agent"],
  ]) {
    const { FakeWS, sent } = fakeSocketFactory({ methods: advertised });
    const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
    await rt.dispatch(baseDispatch);
    assert.equal(rt.dispatchMethod, expected);
    assert.ok(sent.some((f) => f.method === expected), `should have called ${expected}`);
    await rt.close();
  }
});

test("a rejected connection reports the gateway's own error", async () => {
  const { FakeWS } = fakeSocketFactory({ failConnect: { code: "UNAUTHORIZED", message: "bad token" } });
  const rt = createGatewayRuntime({ token: "wrong" }, { WebSocketImpl: FakeWS });
  await assert.rejects(() => rt.connect(), /rejected the connection.*UNAUTHORIZED/s);
});

test("dispatch sends the run method with the execution id as idempotency key", async () => {
  const { FakeWS, sent } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const handoff = await rt.dispatch(baseDispatch);

  const run = sent.find((f) => f.method === rt.dispatchMethod);
  // Instruksi kini didahului preamble konteks eksekusi: Brain yang berjalan,
  // apakah effort-nya aktif, direktori keluaran, mode lease. Instruksi asli
  // tetap utuh sesudah pemisah (spec §8.8).
  assert.match(run.params.message, /Konteks eksekusi \(Semanggi\)/);
  assert.match(run.params.message, /TASK-1/);
  assert.equal(run.params.message.split("\n---\n")[1].trim(), "do the thing");
  assert.equal(run.params.idempotencyKey, "TASK-1#1", "one execution is one attempt");
  assert.equal(run.params.agentId, "poc3-worker");
  // No inherited session ref, so the key is scoped to this revision — that is
  // what stops FORK/FRESH silently continuing the previous conversation.
  assert.equal(run.params.sessionKey, "agent:poc3-worker:task-1:r1");
  // Measured against the live gateway: `cwd`/`workspaceDir` are rejected as
  // unexpected properties, and provider/model overrides need more than
  // operator.write. Sending either would fail every dispatch (D14).
  assert.equal(run.params.cwd, undefined, "the workspace belongs to the agent, not the dispatch");
  assert.equal(run.params.workspaceDir, undefined);
  assert.equal(run.params.model, undefined, "model override is unauthorized by default");
  assert.equal(run.params.provider, undefined);
  assert.equal(run.params.deliver, false, "the controller owns delivery, not the gateway");
  // The TYPE matters, not just the value. 2026.6.11 accepted the string
  // "none"; 2026.7.1 rejects anything non-boolean with `at /deliver: must be
  // boolean` and the dispatch fails outright. The change shipped no warning.
  assert.equal(typeof run.params.deliver, "boolean", "deliver must be boolean since 2026.7.1");
  assert.equal(handoff.runtimeRef, "run-123");
  await rt.close();
});

test("dispatch refuses a worker with no agent", async () => {
  const { FakeWS } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () => rt.dispatch({ ...baseDispatch, worker: { id: "W1" } }),
    GatewayContractError,
  );
});

test("a quota refusal from the gateway is tagged for WAIT_QUOTA", async () => {
  const { FakeWS } = fakeSocketFactory({
    onRequest: () => ({
      ok: false,
      error: { code: "RATE_LIMITED", message: 'session limit reached, "resetsAt":1787113200, "rateLimitType":"five_hour"' },
    }),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () => rt.dispatch(baseDispatch),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.quota.resetsAt, 1787113200);
      assert.equal(err.quota.rateLimitType, "five_hour");
      assert.equal(err.quota.provider, "zai");
      return true;
    },
  );
});

test("an ordinary gateway error is not mistaken for a quota problem", async () => {
  const { FakeWS } = fakeSocketFactory({
    onRequest: () => ({ ok: false, error: { code: "INTERNAL", message: "agent crashed" } }),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () => rt.dispatch(baseDispatch),
    (err) => {
      assert.equal(err.status, undefined);
      assert.equal(err.quota, undefined);
      return true;
    },
  );
});

// Regression (D47, incident TASK-E28D15F3/TASK-BFA56024): the gateway answers
// some dispatches TWICE — an accepting res, then a second res ✗ once the run
// fails to start (measured: UNAVAILABLE "Thinking level \"max\" is not
// supported for zai/glm-5.2"). The first frame settles the dispatch promise,
// so the refusal must be re-correlated to the execution from our own send-time
// bookkeeping and surfaced as an event — the second frame carries no id the
// sink could match on its own. Before this, the refusal was logged and
// dropped, and the task sat DISPATCHED for thirty minutes until the watchdog
// blocked it with a generic message.
test("a refusal arriving after the accept is surfaced with the execution id", async () => {
  const { FakeWS, sent, instances } = fakeSocketFactory({
    onRequest: (frame) => ({ ok: true, payload: { runId: frame.params.idempotencyKey } }),
  });
  const events = [];
  const rt = createGatewayRuntime(
    { token: "t", onEvent: (name, payload) => events.push([name, payload]) },
    { WebSocketImpl: FakeWS },
  );
  const handoff = await rt.dispatch(baseDispatch);
  assert.equal(handoff.runtimeRef, "TASK-1#1");

  // The gateway's second answer for the SAME request id: the run was accepted
  // but then refused at start.
  const runFrame = sent.find((f) => f.method === rt.dispatchMethod);
  instances[0].emit("message", {
    data: JSON.stringify({
      type: "res",
      id: runFrame.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: 'Thinking level "max" is not supported for zai/glm-5.2. Use one of: off.' },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const late = events.find(([name]) => name === "gateway.late-error");
  assert.ok(late, "the second frame must reach the event sink");
  assert.equal(late[1].runId, "TASK-1#1", "the refusal must carry the execution id tracked at send time");
  assert.match(late[1].error.message, /Thinking level/);
  await rt.close();
});

// ── Brain connection test: OK means the run COMPLETED (D48) ───────────────
// The Settings page's Test button vouched for glm-5-2-max with "OK · xxx ms"
// while every dispatch carrying thinking=max was refused at run start: the
// old testAgent reported the ACCEPT frame as success. A connection test that
// cannot distinguish "accepted" from "ran to completion" is worse than no
// test — it manufactures confidence.

function brainTestFactory(waitStatus) {
  return fakeSocketFactory({
    // Advertise agent.wait like the pinned gateway does, or testAgent skips
    // the wait and the scenario never runs.
    methods: ["agent.run", "connect", "agents.list", "agent.wait"],
    onRequest: (frame) => {
      if (frame.method === "agent.wait") return { ok: true, payload: { status: waitStatus } };
      if (frame.method === "agent.run") return { ok: true, payload: { runId: "run-1" } };
      return { ok: true, payload: {} };
    },
  });
}

test("testAgent reports OK only when the run actually completed", async () => {
  const { FakeWS } = brainTestFactory("ok");
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const res = await rt.testAgent({ agentId: "a1" });
  assert.equal(res.ok, true);
  assert.equal(res.status, "ok");
  await rt.close();
});

test("testAgent reports a run refused at start as a failure, with the reason", async () => {
  const { FakeWS } = brainTestFactory("error");
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const res = await rt.testAgent({ agentId: "a1", thinking: "max" });
  assert.equal(res.ok, false, "an accepted-but-refused run must not read as OK");
  assert.match(res.error, /did not complete normally/);
  await rt.close();
});

test("testAgent reports a run that never finishes as unusable, not as OK", async () => {
  const { FakeWS } = brainTestFactory("timeout");
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const res = await rt.testAgent({ agentId: "a1" });
  assert.equal(res.ok, false);
  assert.match(res.error, /possible hang/);
  await rt.close();
});

test("testAgent surfaces a dispatch-level refusal with the gateway's own message", async () => {
  const { FakeWS } = fakeSocketFactory({
    onRequest: (frame) =>
      frame.method === "agent.run"
        ? { ok: false, error: { code: "UNAVAILABLE", message: 'Thinking level "max" is not supported for zai/glm-5.2' } }
        : { ok: true, payload: {} },
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const res = await rt.testAgent({ agentId: "a1", thinking: "max" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Thinking level "max" is not supported/);
  await rt.close();
});

test("quota parsing ignores unrelated text", () => {
  assert.equal(parseGatewayQuota("agent crashed"), null);
  assert.ok(parseGatewayQuota("HTTP 429 too many requests"));
});

test("the adapter refuses to run without a token", async () => {
  const { FakeWS } = fakeSocketFactory();
  const rt = createGatewayRuntime({}, { WebSocketImpl: FakeWS });
  await assert.rejects(() => rt.connect(), /token is not configured/);
});

test("health reports the negotiated protocol instead of throwing", async () => {
  const { FakeWS } = fakeSocketFactory();
  const ok = await createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS }).health();
  assert.equal(ok.ok, true);
  assert.equal(ok.protocol, 4);

  const bad = await createGatewayRuntime({}, { WebSocketImpl: FakeWS }).health();
  assert.equal(bad.ok, false);
});

test("the adapter satisfies the same dispatch interface the scheduler expects", async () => {
  const { FakeWS } = fakeSocketFactory();
  const { buildHarness, seedBasics, queuedTask } = await import("../helpers/harness.mjs");
  const { Status } = await import("../../src/domain/state-machine.mjs");

  // Agent resolution is covered by its own tests below; this one isolates the
  // scheduler interface, and the harness seeds a workspace path the fake fleet
  // knows nothing about.
  const gateway = createGatewayRuntime({ token: "t", resolveAgentByModel: false }, { WebSocketImpl: FakeWS });
  const h = await buildHarness();
  // Swap the fake AgentOS for the real WS adapter: the scheduler must not care.
  h.admission = (await import("../../src/scheduler/admission.mjs")).createAdmission({
    repos: h.repos,
    events: h.events,
    policy: h.policy,
    runtime: gateway,
    config: h.config,
    now: h.now,
  });
  h.scheduler = (await import("../../src/scheduler/scheduler.mjs")).createScheduler({
    admission: h.admission,
    repos: h.repos,
    config: h.config,
    now: h.now,
  });

  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "via gateway" });
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);
  assert.equal((await h.repos.executions.latest(task.id)).runtime_ref, "run-123");
  await gateway.close();
});

// ── Agent resolution: the P4-03 guarantee at the transport (D14) ──────────

test("dispatch refuses when no agent provides the routed model", async () => {
  // Routing picked glm-5.2; the only agent in the workspace runs glm-4.7.
  // Because operator.write cannot override the model at dispatch, going ahead
  // would silently run the weaker model and report success — the exact silent
  // downgrade P4-03 forbids.
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [{ id: "poc3-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } }],
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });

  await assert.rejects(
    () => rt.dispatch({ ...baseDispatch, candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" } }),
    (err) => {
      assert.ok(err instanceof AgentUnavailableError);
      assert.equal(err.retriable, true, "a missing agent parks the task, it does not fail it");
      assert.match(err.message, /zai\/glm-5\.2/);
      return true;
    },
  );
  assert.equal(sent.some((f) => f.method === "agent.run"), false, "nothing was dispatched");
  await rt.close();
});

test("dispatch picks the agent whose configured model matches the routed one", async () => {
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [
      { id: "cheap-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } },
      { id: "strong-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" } },
    ],
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({
    ...baseDispatch,
    worker: { id: "W1", agent_ref: "cheap-worker" },
    candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" },
  });

  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.agentId, "strong-worker", "routing beats a stale agent_ref");
  await rt.close();
});

test("a worker's own agent wins when it already satisfies the routing decision", async () => {
  // Two agents both offer the routed model; the operator's deliberate pairing
  // should not be silently swapped for an equally valid alternative.
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [
      { id: "other-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } },
      { id: "poc3-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } },
    ],
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch(baseDispatch);
  assert.equal(sent.find((f) => f.method === rt.dispatchMethod).params.agentId, "poc3-worker");
  await rt.close();
});

test("claude-code routes on workspace alone, since the harness model is not the agent model", async () => {
  // The orchestrator agent runs glm-4.7 and drives the Claude harness over ACP
  // (POC-3). Matching it against "claude-code/claude-code" would never succeed.
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [{ id: "orchestrator", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } }],
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({
    ...baseDispatch,
    worker: { id: "W1", agent_ref: "orchestrator" },
    candidate: { provider: "claude-code", model: "claude-code", mode: "acp" },
  });
  assert.equal(sent.find((f) => f.method === rt.dispatchMethod).params.agentId, "orchestrator");
  await rt.close();
});

test("a missing agent parks the task as WAIT_RESOURCE, never a silent downgrade", async () => {
  // End-to-end through admission: the routed model has no agent, so the task
  // must wait where an operator can see why — not fail, and not quietly run on
  // whatever agent happened to be available.
  const { FakeWS, sent } = fakeSocketFactory({ agents: [] });
  const { buildHarness, seedBasics, queuedTask } = await import("../helpers/harness.mjs");
  const { Status } = await import("../../src/domain/state-machine.mjs");

  const gateway = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const h = await buildHarness();
  h.admission = (await import("../../src/scheduler/admission.mjs")).createAdmission({
    repos: h.repos, events: h.events, policy: h.policy, runtime: gateway, config: h.config, now: h.now,
  });
  h.scheduler = (await import("../../src/scheduler/scheduler.mjs")).createScheduler({
    admission: h.admission, repos: h.repos, config: h.config, now: h.now,
  });

  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "no agent for this model" });
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(task.id)).status, Status.WAIT_RESOURCE);
  assert.equal(sent.some((f) => f.method === "agent.run"), false, "nothing ran");
  await gateway.close();
});

// ── agent.wait is a live attach, not a result store (D14) ────────────────

test("agent.wait reporting timeout is not treated as an outcome", async () => {
  // Measured on the cluster: a run that had finished with stopReason=stop
  // answered {"status":"timeout","timeoutPhase":"gateway_draining"} when
  // attached to afterwards. Believing that would mark a completed task failed.
  const { FakeWS } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) =>
      f.method === "agent.wait"
        ? { ok: true, payload: { runId: f.params.runId, status: "timeout", timeoutPhase: "gateway_draining" } }
        : { ok: true, payload: { runId: "run-123" } },
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const seen = await rt.waitForRun("run-123");
  assert.equal(seen.status, "timeout");
  assert.equal(seen.observed, false, "the reconciler still owns this run's outcome");
  await rt.close();
});

test("agent.wait is skipped entirely when the gateway does not advertise it", async () => {
  const { FakeWS, sent } = fakeSocketFactory({ methods: ["connect", "agent", "agents.list"] });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const seen = await rt.waitForRun("run-123");
  assert.equal(seen.status, "unsupported");
  assert.equal(seen.observed, false);
  assert.equal(sent.some((f) => f.method === "agent.wait"), false);
  await rt.close();
});

test("a genuinely observed completion is reported as observed", async () => {
  const { FakeWS } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) =>
      f.method === "agent.wait"
        ? { ok: true, payload: { runId: f.params.runId, status: "completed", stopReason: "stop" } }
        : { ok: true, payload: { runId: "run-123" } },
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const seen = await rt.waitForRun("run-123");
  assert.equal(seen.observed, true);
  assert.equal(seen.status, "completed");
  await rt.close();
});

// ── Admin scope: the second route to the routed model (D14, revised) ──────

/** Builds a socket whose hello-ok reports the given granted scopes. */
function adminSocket(scopes, agents) {
  return fakeSocketFactory({
    agents,
    onRequest: (f) => ({ ok: true, payload: { runId: "run-admin" } }),
    helloAuth: { role: "operator", scopes },
  });
}

test("with admin granted, the routed model is sent explicitly", async () => {
  // The override is what guarantees the model, so an agent configured for
  // something else is fine — refusing it here would park work for no reason.
  const { FakeWS, sent } = adminSocket(["operator.read", "operator.write", "operator.admin"], [
    { id: "any-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } },
  ]);
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({ ...baseDispatch, worker: { id: "W1", agent_ref: "any-worker" }, candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" } });

  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.model, "glm-5.2", "the routed model must be the model that runs");
  assert.equal(run.params.provider, "zai");
  await rt.close();
});

test("without admin, no override is sent and a mismatched agent is refused", async () => {
  // Same fleet, same routing decision — but the gateway did not grant admin,
  // so sending an override would simply be rejected and running anyway would
  // be a silent downgrade. The only correct answer is to wait.
  const { FakeWS, sent } = adminSocket(["operator.read", "operator.write"], [
    { id: "any-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } },
  ]);
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () => rt.dispatch({ ...baseDispatch, worker: { id: "W1", agent_ref: "any-worker" }, candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" } }),
    (err) => err instanceof AgentUnavailableError,
  );
  assert.equal(sent.some((f) => f.method === "agent.run"), false);
  await rt.close();
});

test("reasoning effort travels with the routing decision", async () => {
  // A "critical" route that quietly runs at default effort is the same class of
  // downgrade as running the wrong model.
  const { FakeWS, sent } = adminSocket(["operator.admin"], [
    { id: "any-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" } },
  ]);
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({
    ...baseDispatch,
    worker: { id: "W1", agent_ref: "any-worker" },
    candidate: { provider: "zai", model: "glm-5.2", mode: "interactive", thinking: "high" },
  });
  assert.equal(sent.find((f) => f.method === rt.dispatchMethod).params.thinking, "high");
  await rt.close();
});

test("an admin device that loses the scope stops sending overrides", async () => {
  // Regression guard: overrideActive is read from the handshake, not from the
  // configured `scopes`, so a demotion degrades instead of breaking dispatch.
  const { FakeWS, sent } = adminSocket(["operator.write"], [
    { id: "any-worker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" } },
  ]);
  const rt = createGatewayRuntime({ token: "t", scopes: ["operator.admin"] }, { WebSocketImpl: FakeWS });
  await rt.dispatch({ ...baseDispatch, worker: { id: "W1", agent_ref: "any-worker" }, candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" } });
  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.model, undefined, "asked for admin, was not granted it");
  await rt.close();
});

// ── Reasoning effort is part of the quality decision (P4-03) ─────────────

test("an agent that cannot reach the routed reasoning effort is refused", async () => {
  // OpenClaw clamps an unsupported level down to the nearest supported one
  // (resolveSupportedThinkingLevelFromProfile). Asking for "high" against an
  // agent that stops at "low" would run at "low" and report success.
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [{
      id: "weak-thinker",
      workspace: "/nfs/w/executions/TASK-1",
      model: { primary: "zai/glm-5.2" },
      thinkingLevels: [{ id: "off" }, { id: "low" }],
    }],
    helloAuth: { role: "operator", scopes: ["operator.read", "operator.write"] },
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await assert.rejects(
    () => rt.dispatch({
      ...baseDispatch,
      worker: { id: "W1", agent_ref: "weak-thinker" },
      candidate: { provider: "zai", model: "glm-5.2", mode: "interactive", thinking: "high" },
    }),
    (err) => {
      assert.match(err.message, /thinking="high"/);
      return err instanceof AgentUnavailableError;
    },
  );
  assert.equal(sent.some((f) => f.method === "agent.run"), false);
  await rt.close();
});

test("an agent that does reach the routed effort is used", async () => {
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [
      { id: "weak-thinker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" }, thinkingLevels: [{ id: "off" }, { id: "low" }] },
      { id: "deep-thinker", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" }, thinkingLevels: [{ id: "off" }, { id: "medium" }, { id: "high" }] },
    ],
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({
    ...baseDispatch,
    worker: { id: "W1", agent_ref: "weak-thinker" },
    candidate: { provider: "zai", model: "glm-5.2", mode: "interactive", thinking: "high" },
  });
  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.agentId, "deep-thinker", "the stale agent_ref cannot reach high");
  assert.equal(run.params.thinking, "high");
  await rt.close();
});

test("an exact agent is preferred over an admin override", async () => {
  // Under an override the agent's advertised thinking levels describe its own
  // model, not the one that will run, so effort cannot be verified. Preferring
  // the exact agent keeps that blind spot rare rather than routine.
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [
      { id: "other-model", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-4.7" } },
      { id: "exact", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" } },
    ],
    helloAuth: { role: "operator", scopes: ["operator.admin"] },
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({ ...baseDispatch, worker: { id: "W1", agent_ref: "other-model" }, candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" } });

  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.agentId, "exact");
  assert.equal(run.params.model, undefined, "no override needed when an exact agent exists");
  await rt.close();
});

test("the session key follows the resolved agent, not the worker's nomination", async () => {
  // Live regression: the gateway refuses a run whose sessionKey names a
  // different agent —
  //   INVALID_REQUEST 'agent "…-glm-5-1" does not match session key agent'
  // — and it lowercases agent ids, so the key has to be derived from the id
  // that will actually be dispatched to.
  const { FakeWS, sent } = fakeSocketFactory({
    agents: [
      { id: "cheap", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.1" } },
      { id: "strong", workspace: "/nfs/w/executions/TASK-1", model: { primary: "zai/glm-5.2" } },
    ],
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({
    ...baseDispatch,
    worker: { id: "W1", agent_ref: "cheap" },
    candidate: { provider: "zai", model: "glm-5.2", mode: "interactive" },
  });
  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.agentId, "strong");
  assert.equal(run.params.sessionKey, "agent:strong:task-1:r1");
  await rt.close();
});

test("the gateway's session key is recorded so CONTINUE has something to resume", async () => {
  // Live regression: session_ref stayed null across every revision, so a
  // CONTINUE had no conversation to attach to. The accept payload carries the
  // key; it just was not being kept.
  const { FakeWS } = fakeSocketFactory({
    onRequest: () => ({ ok: true, payload: { runId: "run-9", sessionKey: "agent:strong:task-1", status: "accepted" } }),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const handoff = await rt.dispatch(baseDispatch);
  assert.equal(handoff.sessionRef, "agent:strong:task-1");
  await rt.close();
});

test("an inherited session ref is never overwritten by the gateway's", async () => {
  // CONTINUE/FORK inherit a ref from the previous execution; letting the
  // gateway's key win would quietly re-point the task at a different thread.
  const { FakeWS } = fakeSocketFactory({
    onRequest: () => ({ ok: true, payload: { runId: "run-9", sessionKey: "agent:strong:task-1" } }),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const handoff = await rt.dispatch({ ...baseDispatch, execution: { id: "TASK-1#2", session_ref: "inherited-ref" } });
  assert.equal(handoff.sessionRef, "inherited-ref");
  await rt.close();
});

test("an inherited session ref keys the dispatch to that same conversation", async () => {
  // Live regression: keying on task alone made every revision share one session,
  // so FORK and FRESH continued the conversation they were supposed to leave.
  const { FakeWS, sent } = fakeSocketFactory();
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.dispatch({ ...baseDispatch, execution: { id: "TASK-1#2", revision_no: 2, session_ref: "uuid-abc" } });
  assert.equal(sent.find((f) => f.method === rt.dispatchMethod).params.sessionKey, "agent:poc3-worker:task-1:suuid-abc");
  await rt.close();
});

test("revisions without an inherited ref get distinct conversations", async () => {
  const keys = [];
  for (const rev of [2, 3]) {
    const { FakeWS, sent } = fakeSocketFactory();
    const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
    await rt.dispatch({ ...baseDispatch, execution: { id: `TASK-1#${rev}`, revision_no: rev, session_ref: null } });
    keys.push(sent.find((f) => f.method === rt.dispatchMethod).params.sessionKey);
    await rt.close();
  }
  assert.notEqual(keys[0], keys[1], "FORK and FRESH must not land in the same session");
});

test("a stale fleet view is refreshed before falling back to an override", async () => {
  // Cluster regression: right after a gateway restart the fleet briefly showed
  // the qwen agent as thinking-incapable. The exact match missed, the override
  // path dispatched to a GLM agent instead, and the gateway refused. Waiting
  // one refresh is strictly better than routing somewhere else.
  let call = 0;
  const stale = [{ id: "qwen-agent", workspace: "/nfs/w/executions/TASK-1", model: { primary: "groq/qwen" }, thinkingLevels: [{ id: "off" }] }];
  const settled = [{ id: "qwen-agent", workspace: "/nfs/w/executions/TASK-1", model: { primary: "groq/qwen" }, thinkingLevels: [{ id: "off" }, { id: "medium" }] }];

  const { FakeWS, sent } = fakeSocketFactory({
    agents: stale,
    helloAuth: { role: "operator", scopes: ["operator.admin"] },
  });
  // Second and later reads see the settled fleet.
  const OrigWS = FakeWS;
  class Swapping extends OrigWS {
    send(raw) {
      const f = JSON.parse(raw);
      if (f.method === "agents.list" && call++ === 0) return super.send(raw);
      if (f.method === "agents.list") {
        setTimeout(() => this.emit("message", { data: JSON.stringify({ type: "res", id: f.id, ok: true, payload: { agents: settled } }) }), 1);
        return;
      }
      return super.send(raw);
    }
  }
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: Swapping });
  await rt.dispatch({
    ...baseDispatch,
    worker: { id: "W1", agent_ref: "qwen-agent" },
    candidate: { provider: "groq", model: "qwen", mode: "interactive", thinking: "medium" },
  });

  const run = sent.find((f) => f.method === rt.dispatchMethod);
  assert.equal(run.params.agentId, "qwen-agent");
  assert.equal(run.params.model, undefined, "the refreshed exact match needs no override");
  assert.equal(run.params.thinking, "medium");
  await rt.close();
});

test("a late error frame for an already-settled request is surfaced, not dropped", async () => {
  // Measured: the gateway answered one `agent` request twice — `accepted`, then
  // a second `res` with UNAVAILABLE. The client had already resolved on the
  // first, so the refusal vanished and the execution sat DISPATCHED forever.
  // That is where the D20 deadlock actually starts.
  const seen = [];
  const { FakeWS } = fakeSocketFactory({
    onRequest: (f) => ({ ok: true, payload: { runId: f.params.idempotencyKey, status: "accepted" } }),
  });
  class Twice extends FakeWS {
    send(raw) {
      const f = JSON.parse(raw);
      super.send(raw);
      if (f.method === "agent.run" || f.method === "agent") {
        setTimeout(() => {
          this.emit("message", {
            data: JSON.stringify({ type: "res", id: f.id, ok: false, error: { code: "UNAVAILABLE", message: "refused after accept" } }),
          });
        }, 5);
      }
    }
  }
  const rt = createGatewayRuntime({ token: "t", onEvent: (n, p) => seen.push([n, p]) }, { WebSocketImpl: Twice });
  const handoff = await rt.dispatch(baseDispatch);
  assert.equal(handoff.runtimeRef, "TASK-1#1", "the first answer still resolves the dispatch");

  await new Promise((r) => setTimeout(r, 25));
  const late = seen.find(([n]) => n === "gateway.late-error");
  assert.ok(late, "the second frame must not be silently dropped");
  assert.match(JSON.stringify(late[1]), /refused after accept/);
  await rt.close();
});

// ── probeLevel: the thinking-level probe's per-call token measurement ─────
//
// D31/D26: there is no RPC that reports usage synchronously — only the async
// session.message event does, correlated by sessionKey. These tests exercise
// the internal usage-waiter map added alongside the single external onEvent
// callback, without disturbing that callback's own behaviour (already
// covered above by the late-error test, which still passes with the waiter
// in place).

/** Emits a `session.message` usage event for whatever sessionKey the probe used. */
function withUsageEvent(FakeWS, { usage, delayMs = 2 } = {}) {
  return class extends FakeWS {
    send(raw) {
      const frame = JSON.parse(raw);
      super.send(raw);
      if (frame.method === "agent" || frame.method === "agent.run") {
        if (!usage) return;
        setTimeout(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "event",
              event: "session.message",
              payload: { sessionKey: frame.params.sessionKey, message: { role: "assistant", usage } },
            }),
          });
        }, delayMs);
      }
    }
  };
}

test("probeLevel captures output-token usage from the async session.message event", async () => {
  const { FakeWS, sent } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) =>
      f.method === "agent.wait"
        ? { ok: true, payload: { runId: f.params.runId, status: "completed", stopReason: "stop" } }
        : { ok: true, payload: { runId: "probe-run-1" } },
  });
  const WithUsage = withUsageEvent(FakeWS, { usage: { input: 500, output: 42, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: WithUsage });

  const result = await rt.probeLevel({ agentId: "glm-agent", thinking: "high", timeoutMs: 5_000, usageGraceMs: 200 });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.output_tokens, 42);
  const dispatched = sent.find((f) => (f.method === "agent" || f.method === "agent.run") && f.params.label === "semanggi-thinking-probe");
  assert.equal(dispatched.params.agentId, "glm-agent");
  assert.equal(dispatched.params.thinking, "high");
  assert.ok(sent.some((f) => f.method === "sessions.abort"), "cleanup runs even on a successful probe");
  await rt.close();
});

test("probeLevel sends thinking:\"off\" explicitly rather than omitting it", async () => {
  // "off" is a real candidate in the vocabulary and a truthy string — the
  // dispatch code only omits `thinking` when the value is falsy, so "off"
  // must travel through exactly like any other level.
  const { FakeWS, sent } = fakeSocketFactory({ methods: ["connect", "agent", "agents.list", "agent.wait"] });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  await rt.probeLevel({ agentId: "a1", thinking: "off", usageGraceMs: 20 });
  const dispatched = sent.find((f) => f.params?.label === "semanggi-thinking-probe");
  assert.equal(dispatched.params.thinking, "off");
  await rt.close();
});

test("probeLevel reports null usage when no session.message arrives before the grace window ends", async () => {
  const { FakeWS } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) => (f.method === "agent.wait" ? { ok: true, payload: { status: "completed" } } : { ok: true, payload: { runId: "r" } }),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const result = await rt.probeLevel({ agentId: "a1", thinking: "medium", timeoutMs: 2_000, usageGraceMs: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.usage, null, "no usage event arrived, so nothing is invented");
  await rt.close();
});

test("probeLevel surfaces a hung/unwatchable level as status:timeout, never throws", async () => {
  // D14: a live-attach timeout means "could not observe it". For a probe the
  // orchestrator (thinking-probe.mjs) treats that as "exclude this level",
  // but the gateway layer's job is just to report it honestly and move on —
  // in particular it must not hang the probe itself waiting longer.
  const { FakeWS } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) => (f.method === "agent.wait" ? { ok: true, payload: { status: "timeout" } } : { ok: true, payload: { runId: "r" } }),
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const start = Date.now();
  const result = await rt.probeLevel({ agentId: "a1", thinking: "medium", timeoutMs: 50, usageGraceMs: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.status, "timeout");
  assert.ok(Date.now() - start < 500, "probeLevel must not itself block beyond its own bounded timeout");
  await rt.close();
});

test("probeLevel reports a dispatch refusal instead of throwing, and still attempts cleanup", async () => {
  const { FakeWS, sent } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) =>
      f.method === "agent" || f.method === "agent.run"
        ? { ok: false, error: { code: "UNSUPPORTED", message: 'Thinking level "medium" is not supported for zai/glm-4.7' } }
        : { ok: true, payload: {} },
  });
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: FakeWS });
  const result = await rt.probeLevel({ agentId: "a1", thinking: "medium", usageGraceMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.usage, null);
  assert.match(result.error, /not supported/);
  assert.ok(sent.some((f) => f.method === "sessions.abort"), "cleanup still runs after a dispatch failure");
  await rt.close();
});

test("a probe's usage waiter never leaks into an unrelated run's usage", async () => {
  // Regression guard for the internal waiter map: a session.message event
  // for a DIFFERENT sessionKey (e.g. a real task running concurrently) must
  // not be mistaken for the probe's own usage.
  const { FakeWS } = fakeSocketFactory({
    methods: ["connect", "agent", "agents.list", "agent.wait"],
    onRequest: (f) =>
      f.method === "agent.wait" ? { ok: true, payload: { status: "completed" } } : { ok: true, payload: { runId: "r" } },
  });
  class WrongKeyEvent extends FakeWS {
    send(raw) {
      const frame = JSON.parse(raw);
      super.send(raw);
      if (frame.method === "agent" || frame.method === "agent.run") {
        setTimeout(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "event",
              event: "session.message",
              payload: { sessionKey: "agent:someone-else:other-task:r1", message: { role: "assistant", usage: { input: 1, output: 999 } } },
            }),
          });
        }, 2);
      }
    }
  }
  const rt = createGatewayRuntime({ token: "t" }, { WebSocketImpl: WrongKeyEvent });
  const result = await rt.probeLevel({ agentId: "a1", thinking: "low", usageGraceMs: 30 });
  assert.equal(result.usage, null, "an event for a different sessionKey must not be attributed here");
  await rt.close();
});
