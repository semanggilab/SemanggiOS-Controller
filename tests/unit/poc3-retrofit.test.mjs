// Retrofit of POC-2/POC-3 findings into the controller.
//
// Each test here exists because a real measurement or failure on the cluster
// contradicted an assumption the phase 1-3 code was written against.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";
import { parseQuotaSignal, createAgentOSRuntime, RuntimeContractError } from "../../src/runtime/agentos.mjs";
import { startLoopbackForwarder } from "../../src/runtime/loopback.mjs";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
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
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

// --- cost accounting (POC-3 E8) ---------------------------------------------

test("cache tokens are recorded and counted as billable", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const exec = await h.repos.executions.latest((await h.repos.tasks.list({}))[0].id);

  // Shape taken verbatim from a real `claude -p --output-format json` result.
  await h.repos.executions.recordUsage(exec.id, {
    input_tokens: 8,
    output_tokens: 1303,
    cache_read_input_tokens: 92663,
    cache_creation_input_tokens: 31860,
  });

  const updated = await h.repos.executions.get(exec.id);
  assert.equal(updated.tokens_cache_read, 92663);
  assert.equal(updated.tokens_cache_creation, 31860);
  assert.equal(
    h.repos.executions.billableTokens(updated),
    8 + 1303 + 92663 + 31860,
    "cache reads dominate real usage and must be inside the total",
  );
  // The naive total would be 1311 — off by a factor of ~95.
  assert.ok(h.repos.executions.billableTokens(updated) > 90 * (8 + 1303));
});

test("the ACP usage shape is normalised too", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await queuedTask(h, { project, worker, title: "t" });
  await h.scheduler.notify();
  const exec = await h.repos.executions.latest((await h.repos.tasks.list({}))[0].id);

  await h.repos.executions.recordUsage(exec.id, {
    sessionUpdate: "usage_update",
    used: 21938,
    size: 200000,
    cost: { amount: 0.0215, currency: "USD" },
  });
  const updated = await h.repos.executions.get(exec.id);
  assert.equal(updated.tokens_input, 21938);
  assert.ok(updated.cost > 0);
});

// --- quota signals (POC-3 E8) -----------------------------------------------

test("a Claude Pro session-limit refusal is recognised", () => {
  const body = JSON.stringify({
    is_error: true,
    api_error_status: 429,
    result: "You've hit your session limit · resets 9:40am (UTC)",
  });
  const signal = parseQuotaSignal({ status: 429, body });
  assert.ok(signal);
  assert.match(signal.message, /session limit/);
});

test("an absolute resetsAt is preferred over anything derived", () => {
  const signal = parseQuotaSignal({
    status: 429,
    body: JSON.stringify({ rate_limit_info: { resetsAt: 1787113200, rateLimitType: "five_hour" } }),
  });
  assert.equal(signal.resetsAt, 1787113200);
  assert.equal(signal.rateLimitType, "five_hour");
});

test("a non-quota error is not mistaken for one", () => {
  assert.equal(parseQuotaSignal({ status: 500, body: "internal error" }), null);
});

test("a quota refusal at dispatch parks the task on WAIT_QUOTA with a real ETA", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "quota" });

  const resetEpochSeconds = Math.floor(h.clock.now() / 1000) + 5 * 60 * 60;
  const err = new Error("AgentOS dispatch failed: HTTP 429");
  err.status = 429;
  err.quota = {
    provider: "google",
    model: "gemini-flash",
    status: 429,
    resetsAt: resetEpochSeconds,
    rateLimitType: "five_hour",
    message: "You've hit your session limit",
  };
  h.fake.failNextDispatch(err);
  await h.scheduler.notify();

  const parked = await h.repos.tasks.get(task.id);
  assert.equal(parked.status, Status.WAIT_QUOTA, "a quota refusal is not a generic runtime failure");
  assert.equal(parked.next_retry_at, resetEpochSeconds * 1000, "epoch seconds are converted, not guessed");

  const resource = await h.repos.resources.get("google", "gemini-flash");
  assert.equal(resource.availability, "QUOTA_EXHAUSTED");
  assert.equal(resource.window_kind, "five_hour");
  assert.match(resource.last_quota_signal, /session limit/);
});

// --- resume ownership (POC-3 E3-E6) -----------------------------------------

// REVISED 2026-08-21 after running this against the cluster. The original
// assumption — CONTINUE and FORK both resume — produced four revisions that all
// shared one session id, because on this gateway a conversation is addressed
// only by `sessionKey` and an inherited ref meant an identical key. FORK now
// starts its own conversation. It is a genuine limitation, not a fix: without
// an API to clone a session, a fork cannot carry the parent's history.
test("CONTINUE resumes the harness session; FORK and FRESH start their own", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "sessions" });
  await h.scheduler.notify();

  const first = await h.repos.executions.latest(task.id);
  await h.repos.executions.update(first.id, { session_ref: "claude-session-abc" });
  await h.fake.startExecution(first.id);
  await h.fake.completeExecution(first.id);

  for (const mode of ["CONTINUE", "FORK", "FRESH"]) {
    await h.repos.tasks.createRevision(task.id, { sessionMode: mode, instruction: `via ${mode}` });
    await h.scheduler.notify();
    const exec = await h.repos.executions.latest(task.id);
    if (mode === "CONTINUE") {
      assert.equal(exec.session_ref, "claude-session-abc", "CONTINUE must resume the previous session");
    } else {
      // Both FORK and FRESH end up with a ref — the one the runtime reports for
      // their new session, so a later CONTINUE has something to resume. What
      // matters is that it is not the old one.
      assert.notEqual(exec.session_ref, "claude-session-abc", `${mode} must not resume the previous session`);
    }
    await h.fake.startExecution(exec.id);
    await h.fake.completeExecution(exec.id);
    // No re-stamping here on purpose: inheritance reads the most recent
    // non-null session_ref, and a finalized execution is immutable anyway —
    // the schema rejects the write, which is the behaviour we want.
  }
});

// --- the interposer contract (POC-3 permission bridge) -----------------------

test("the interposer can raise an approval by harness session id", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gated" });
  await h.scheduler.notify();
  const exec = await h.repos.executions.latest(task.id);
  await h.repos.executions.update(exec.id, { session_ref: "sess-xyz" });
  await h.fake.startExecution(exec.id);

  const api = await startApi(h);
  try {
    // Exactly the payload images/openclaw-gateway/acp-permission-interposer.mjs sends.
    const raised = await api.call("POST", "/api/work/approvals", {
      id: "1787135503028-0",
      sessionId: "sess-xyz",
      workspace: "/nfs/workspaces/alpha/executions/T1",
      tool: "Write /etc/cron.d/evil",
      kind: "edit",
      level: "L3",
      options: ["allow_always", "allow", "reject"],
      requestedAt: new Date().toISOString(),
    });
    assert.equal(raised.status, 200);
    assert.equal(raised.body.taskId, task.id, "the session id must resolve to the owning task");
    const approvalId = raised.body.approvalId;

    assert.equal(
      (await h.repos.tasks.get(task.id)).status,
      Status.WAIT_HUMAN,
      "the queue must show why the task stopped",
    );

    // The interposer polls this endpoint while holding the tool call.
    const pending = await api.call("GET", `/api/work/approvals/${approvalId}`);
    assert.equal(pending.body.approval.decision, null);

    const decided = await api.call("POST", `/api/work/approvals/${approvalId}/decide`, {
      decision: "APPROVE",
      decided_by: "satria",
    });
    assert.equal(decided.body.approval.decidedBy, "satria");

    const after = await api.call("GET", `/api/work/approvals/${approvalId}`);
    assert.equal(after.body.approval.decision, "APPROVE");
    assert.equal(
      (await h.repos.tasks.get(task.id)).status,
      Status.RUNNING,
      "approving a mid-turn hold resumes the existing run rather than dispatching a new one",
    );
  } finally {
    await api.close();
  }
});

test("a rejected mid-turn approval blocks the task", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "gated" });
  await h.scheduler.notify();
  const exec = await h.repos.executions.latest(task.id);
  await h.repos.executions.update(exec.id, { session_ref: "sess-rej" });
  await h.fake.startExecution(exec.id);

  const api = await startApi(h);
  try {
    const raised = await api.call("POST", "/api/work/approvals", {
      sessionId: "sess-rej",
      tool: "Bash kubectl delete ns prod",
      level: "L3",
    });
    await api.call("POST", `/api/work/approvals/${raised.body.approvalId}/decide`, {
      decision: "REJECT",
      decided_by: "satria",
    });
    assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
  } finally {
    await api.close();
  }
});

test("an approval for an unknown session is refused, not silently attached", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/approvals", {
      sessionId: "nobody",
      tool: "Write x",
      level: "L3",
    });
    assert.equal(res.status, 400);
  } finally {
    await api.close();
  }
});

// --- AgentOS contract (POC-4 §11) -------------------------------------------

test("the loopback forwarder gives a localhost origin onto the upstream", async () => {
  // A stand-in upstream: the forwarder is transport-level, so any TCP server
  // proves the path without needing AgentOS.
  const { createServer } = await import("node:http");
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sawOrigin: req.headers.origin, path: req.url }));
  });
  const upstreamPort = typeof Bun === "undefined"
    ? 0
    : 20_000 + crypto.getRandomValues(new Uint16Array(1))[0] % 30_000;
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");

  const fwd = await startLoopbackForwarder({
    port: 0,
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.address().port,
  });
  try {
    assert.match(fwd.origin, /^http:\/\/127\.0\.0\.1:\d+$/, "writes require a loopback origin");
    const res = await fetch(`${fwd.origin}/api/health`, { headers: { origin: fwd.origin } });
    const body = await res.json();
    assert.equal(body.path, "/api/health");
    assert.equal(body.sawOrigin, fwd.origin, "AgentOS must see localhost as the origin");
  } finally {
    await fwd.close();
    upstream.close();
  }
});

test("the adapter logs in first, then dispatches with the session cookie", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} });
    if (String(url).endsWith("/api/auth/login")) {
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => ["agentos_instance_session=abc; Path=/; HttpOnly"] },
        text: async () => "{}",
      };
    }
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ dispatchId: "dispatch-1" }) };
  };

  const runtime = createAgentOSRuntime(
    { upstreamHost: "agentos", password: "pw", apiToken: "tok" },
    { fetchImpl, forwarder: { origin: "http://127.0.0.1:3000", close: async () => {} } },
  );

  const handoff = await runtime.dispatch({
    task: { id: "TASK-1", project_id: "PRJ-1" },
    execution: { id: "TASK-1#1", session_ref: null },
    candidate: { provider: "zai", model: "glm-4.7" },
    worker: { id: "W1" },
    workspacePath: "/nfs/w",
    instruction: "do the thing",
  });

  assert.equal(handoff.runtimeRef, "dispatch-1");
  assert.equal(seen[0].method, "POST");
  assert.match(seen[0].url, /\/api\/auth\/login$/, "login must happen before any write");
  assert.match(seen[1].url, /\/api\/mission$/);
  assert.match(seen[1].headers.cookie, /agentos_instance_session=/, "the write needs the session cookie");
  assert.equal(seen[1].headers.origin, "http://127.0.0.1:3000", "writes must carry a loopback origin");
});

test("a 429 from AgentOS surfaces as a quota signal, not a generic failure", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/auth/login")) {
      return { ok: true, status: 200, headers: { getSetCookie: () => ["agentos_instance_session=abc"] }, text: async () => "{}" };
    }
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "900" }),
      text: async () => JSON.stringify({ result: "You've hit your session limit", rate_limit_info: { rateLimitType: "five_hour" } }),
    };
  };
  const runtime = createAgentOSRuntime(
    { upstreamHost: "agentos", password: "pw" },
    { fetchImpl, forwarder: { origin: "http://127.0.0.1:3000", close: async () => {} } },
  );

  await assert.rejects(
    () =>
      runtime.dispatch({
        task: { id: "T", project_id: "P" },
        execution: { id: "T#1" },
        candidate: { provider: "claude-code", model: "claude-code" },
        worker: { id: "W" },
        workspacePath: "/nfs/w",
        instruction: "x",
      }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.quota.provider, "claude-code");
      assert.equal(err.quota.retryAfterSeconds, 900);
      assert.equal(err.quota.rateLimitType, "five_hour");
      return true;
    },
  );
});

test("the adapter refuses to run without its configuration", async () => {
  const runtime = createAgentOSRuntime({}, { fetchImpl: async () => ({}) });
  await assert.rejects(() => runtime.health(), RuntimeContractError);
});
