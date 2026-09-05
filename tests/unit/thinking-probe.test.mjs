// Empirical thinking-level probe (2026-09-01): the "Refresh Levels" button
// in the Brain form now dispatches real runs against the gateway instead of
// only re-reading the static seed file. Three layers are tested separately:
//
//   thinking-probe.mjs   the orchestration logic, against a fake runtime —
//                        no gateway, no HTTP, no timers left dangling.
//   gateway-ws.mjs        probeLevel's usage-capture over the fake WS —
//                        covered in gateway-ws.test.mjs.
//   server.mjs             the HTTP route: no-agent honesty, background
//                        dispatch, and status polling.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { probeThinkingLevels, CANDIDATE_LEVELS } from "../../src/domain/thinking-probe.mjs";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness } from "../helpers/harness.mjs";

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
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, port, close: () => new Promise((r) => server.close(r)) };
}

/** A scripted fake runtime — one canned probeLevel result per thinking value. */
function fakeRuntime(scripts, { trackConcurrency = false } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    async probeLevel({ agentId, thinking, timeoutMs }) {
      calls.push({ agentId, thinking, timeoutMs });
      if (trackConcurrency) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
      }
      const script = scripts[thinking];
      if (!script) throw new Error(`no script for level ${thinking}`);
      const result = typeof script === "function" ? script() : script;
      if (trackConcurrency) inFlight -= 1;
      return result;
    },
  };
}

const ok = (outputTokens) => ({ ok: true, status: "completed", latencyMs: 5, usage: { output_tokens: outputTokens } });
const timedOut = () => ({ ok: true, status: "timeout", latencyMs: 60_000, usage: null });
const refused = (message) => ({ ok: false, status: "error", latencyMs: 3, usage: null, error: message });

test("CANDIDATE_LEVELS mirrors the vocabulary used elsewhere for effort", () => {
  assert.deepEqual(CANDIDATE_LEVELS, ["off", "minimal", "low", "medium", "high", "max", "adaptive"]);
});

test("a real output-token spread across levels is read as a guaranteed effort dial", async () => {
  const runtime = fakeRuntime({ off: ok(100), low: ok(150), high: ok(300) });
  const result = await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "low", "high"] });
  assert.deepEqual(result.levels, ["off", "low", "high"]);
  assert.equal(result.effortMode, "guaranteed");
  assert.match(result.evidence, /auto-probed n=1: off 100 -> low 150 -> high 300 output tokens/);
});

test("near-identical output across levels is read as a preference, not a guarantee", async () => {
  // Mirrors the real gemini-3.1-flash-lite case in the seed file: accepted,
  // but the token count barely moves.
  const runtime = fakeRuntime({ off: ok(533), low: ok(520), high: ok(516) });
  const result = await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "low", "high"] });
  assert.deepEqual(result.levels, ["off", "low", "high"]);
  assert.equal(result.effortMode, "preference");
});

test("a level that times out is excluded and flagged dangerous, not retried or trusted", async () => {
  const runtime = fakeRuntime({ off: ok(100), medium: timedOut(), high: ok(300) });
  const result = await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "medium", "high"] });
  assert.deepEqual(result.levels, ["off", "high"], "the hung level must not be offered in the Brain form");
  assert.match(result.evidence, /medium \(did not complete within the probe timeout — treated as unsafe \(possible hang\)\)/);
  assert.match(result.evidence, /DANGEROUS/);
  // Still derives a usable effortMode from what DID complete.
  assert.equal(result.effortMode, "guaranteed");
});

test("an RPC refusal excludes the level with the gateway's own reason, not a generic failure", async () => {
  const runtime = fakeRuntime({
    off: ok(100),
    high: refused('Thinking level "high" is not supported for zai/glm-4.7'),
  });
  const result = await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "high"] });
  assert.deepEqual(result.levels, ["off"]);
  assert.match(result.evidence, /refused: Thinking level "high" is not supported/);
});

// Regression (D47, measured on zai/glm-5.2): a level the gateway refuses at
// run START still answers the dispatch request — the probe then sees
// ok:true with agent.wait status "error" and no usage. Before the
// completed-status check, that sample read as "completed but reported no
// usable usage" and `max` landed back in the catalog even though every
// dispatch carrying it is refused with UNAVAILABLE.
test("a run accepted but refused at start is excluded, not catalogued as measured", async () => {
  const acceptedThenRefused = () => ({ ok: true, status: "error", latencyMs: 5392, usage: null });
  const runtime = fakeRuntime({ off: ok(12), high: ok(25), max: acceptedThenRefused(), adaptive: acceptedThenRefused() });
  const result = await probeThinkingLevels({
    runtime, agentId: "a1", candidateLevels: ["off", "high", "max", "adaptive"],
  });
  assert.deepEqual(result.levels, ["off", "high"], "levels refused at run start must not be offered");
  assert.match(result.evidence, /max \(run did not complete normally \(status: error\)\)/);
  assert.match(result.evidence, /adaptive \(run did not complete normally \(status: error\)\)/);
});

test("a completed run with no usage stays included, so no-usage providers are not blanked", async () => {
  // google/gemini through the OpenAI-compatible path reports all-zero usage;
  // excluding levels for missing usage would empty their whole catalog.
  // Usage decides the effort evidence, not inclusion.
  const silent = () => ({ ok: true, status: "ok", latencyMs: 8, usage: null });
  const runtime = fakeRuntime({ off: silent(), high: silent() });
  const result = await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "high"] });
  assert.deepEqual(result.levels, ["off", "high"]);
  assert.equal(result.effortMode, "preference", "no usable usage means no guarantee claim");
});

test("levels run sequentially, never concurrently, against the same agent", async () => {
  const runtime = fakeRuntime(
    { off: ok(100), low: ok(120), medium: ok(140) },
    { trackConcurrency: true },
  );
  await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "low", "medium"] });
  assert.equal(runtime.maxInFlight, 1, "a hang on one level must not overlap the next candidate");
  assert.deepEqual(
    runtime.calls.map((c) => c.thinking),
    ["off", "low", "medium"],
    "candidates run in the given order",
  );
});

test("perLevelTimeoutMs is plumbed through to every probeLevel call", async () => {
  const runtime = fakeRuntime({ off: ok(10), low: ok(10) });
  await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "low"], perLevelTimeoutMs: 12_345 });
  assert.ok(runtime.calls.every((c) => c.timeoutMs === 12_345));
});

test("onLevelDone fires once per level with growing samples and an up-to-date partial catalog entry", async () => {
  const runtime = fakeRuntime({ off: ok(100), low: ok(200) });
  const progress = [];
  await probeThinkingLevels({
    runtime,
    agentId: "a1",
    candidateLevels: ["off", "low"],
    onLevelDone: (sample, samplesSoFar, partial) => {
      progress.push({ level: sample.level, sampleCount: samplesSoFar.length, partialLevels: partial.levels });
    },
  });
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0], { level: "off", sampleCount: 1, partialLevels: ["off"] });
  assert.deepEqual(progress[1], { level: "low", sampleCount: 2, partialLevels: ["off", "low"] });
});

test("a throwing onLevelDone does not abort the probe", async () => {
  const runtime = fakeRuntime({ off: ok(100), low: ok(200) });
  const result = await probeThinkingLevels({
    runtime,
    agentId: "a1",
    candidateLevels: ["off", "low"],
    onLevelDone: () => {
      throw new Error("progress sink is down");
    },
  });
  assert.deepEqual(result.levels, ["off", "low"], "the probe itself must still complete");
});

test("no measured levels at all reads as preference, not a false guarantee", async () => {
  const runtime = fakeRuntime({ off: refused("nope"), low: timedOut() });
  const result = await probeThinkingLevels({ runtime, agentId: "a1", candidateLevels: ["off", "low"] });
  assert.deepEqual(result.levels, []);
  assert.equal(result.effortMode, "preference");
  assert.match(result.evidence, /no level reported usable output-token data/);
});

test("probeThinkingLevels refuses a runtime that cannot probe, and refuses a missing agentId", async () => {
  await assert.rejects(() => probeThinkingLevels({ runtime: {}, agentId: "a1" }), /does not support thinking-level probing/);
  await assert.rejects(
    () => probeThinkingLevels({ runtime: fakeRuntime({}), agentId: "" }),
    /agentId is required/,
  );
});

// ── HTTP route: POST .../probe and GET .../probe/status ────────────────────

test("POST /api/work/gateway/thinking-levels/probe reports no-agent honestly, like the connection test does", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [];
  h.runtime.probeLevel = async () => ok(1);
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai", model: "glm-9.9-missing" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "no-agent");
    assert.match(res.body.status.message, /No agent is currently provisioned/);
  } finally {
    await api.close();
  }
});

test("POST .../probe starts a background probe and GET .../probe/status reports it finishing", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [{ id: "glm-agent", model: { primary: "zai/glm-5.2" } }];
  h.runtime.probeLevel = async ({ thinking }) => {
    // A tiny real delay so the route's fire-and-forget nature is actually
    // exercised — if the POST awaited this, the response would be slow.
    await new Promise((r) => setTimeout(r, 5));
    return { off: ok(100), minimal: ok(110), low: ok(150), medium: ok(200), high: ok(260), max: ok(300), adaptive: ok(150) }[thinking];
  };
  const api = await startApi(h);
  try {
    const started = Date.now();
    const start = await api.call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai", model: "glm-5.2" });
    assert.equal(start.status, 200);
    assert.equal(start.body.ok, true);
    assert.equal(start.body.started, true);
    assert.equal(start.body.agentId, "glm-agent");
    // Seven real dispatches at 5ms apiece would take >=35ms if awaited; the
    // route must return long before that.
    assert.ok(Date.now() - started < 30, "the route must not block on the probe itself");

    let status = start.body.status;
    const deadline = Date.now() + 5_000;
    while (status.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      const poll = await api.call("GET", `/api/work/gateway/thinking-levels/probe/status?provider=zai&model=glm-5.2`);
      assert.equal(poll.status, 200);
      status = poll.body;
    }
    assert.equal(status.running, false, "the probe must finish within the test's own generous deadline");
    assert.equal(status.samples.length, 7);

    const levels = await h.thinkingLevels.get("zai", "glm-5.2");
    assert.deepEqual(levels.levels, ["off", "minimal", "low", "medium", "high", "max", "adaptive"]);
    assert.equal(levels.effortMode, "guaranteed");
    assert.match(levels.evidence, /auto-probed n=1/);
  } finally {
    await api.close();
  }
});

test("a second probe on the same model while one is running is reported, not duplicated", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [{ id: "glm-agent", model: { primary: "zai/glm-5.2" } }];
  let dispatches = 0;
  h.runtime.probeLevel = async () => {
    dispatches += 1;
    await new Promise((r) => setTimeout(r, 30));
    return ok(100);
  };
  const api = await startApi(h);
  try {
    const first = await api.call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai", model: "glm-5.2" });
    assert.equal(first.body.started, true);
    const second = await api.call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai", model: "glm-5.2" });
    assert.equal(second.body.started, false);
    assert.equal(second.body.reason, "already-running");

    // Let the in-flight probe finish so the test doesn't leave timers behind.
    let status = first.body.status;
    const deadline = Date.now() + 5_000;
    while (status.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await api.call("GET", "/api/work/gateway/thinking-levels/probe/status?provider=zai&model=glm-5.2")).body;
    }
    assert.equal(status.running, false);
    // Seven candidate levels, one probe run, never two interleaved.
    assert.equal(dispatches, 7);
  } finally {
    await api.close();
  }
});

test("POST .../probe requires both provider and model", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [];
  h.runtime.probeLevel = async () => ok(1);
  const api = await startApi(h);
  try {
    const missing = await api.call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai" });
    assert.equal(missing.status, 400);
  } finally {
    await api.close();
  }
});

test("POST .../probe rejects a non-admin operator, same as the refresh route", async () => {
  const h = await buildHarness();
  h.runtime.listAgents = async () => [];
  h.runtime.probeLevel = async () => ok(1);
  const server = createApi(h, { token: TOKEN });
  const call = async (method, path, body, as) => {
    const res = { status: 0, body: "" };
    await server.handle(
      {
        method,
        url: path,
        headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
        [Symbol.asyncIterator]: async function* () {
          if (body) yield Buffer.from(JSON.stringify(body));
        },
      },
      { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} },
    );
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
  };

  const { token: plainOperator } = await h.operators.create({ name: "reviewer", role: "operator" });
  const blocked = await call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai", model: "glm-5.2" }, plainOperator);
  assert.equal(blocked.status, 403);

  const asService = await call("POST", "/api/work/gateway/thinking-levels/probe", { provider: "zai", model: "glm-9.9-missing" }, TOKEN);
  assert.equal(asService.status, 200, "the admin/service token is still allowed through");
});
