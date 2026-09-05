// Per-operator identity (operator decision: token per operator).
//
// The reason this exists: approvals record `decided_by` (P4-08), and one shared
// bearer token makes every human the same anonymous caller. An audit trail that
// cannot name anyone is not an audit trail.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { hashToken } from "../../src/domain/operators.mjs";

async function api(h, token = "service") {
  const { createApi } = await import("../../src/api/server.mjs");
  const server = createApi(h, { token: "service" });
  return async (method, path, body, as = token) => {
    const res = { status: 0, body: "" };
    await server.handle(
      {
        method, url: path,
        headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
        [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); },
      },
      { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} },
    );
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
  };
}

test("a token is stored hashed and never readable back", async () => {
  // A leaked database must not hand over working credentials, and no feature
  // needs to read a token: authentication only compares hashes.
  const h = await buildHarness();
  const { operator, token } = await h.operators.create({ name: "Satria" });
  const row = await h.operators.get(operator.id);
  assert.equal(row.token_sha256, hashToken(token));
  assert.ok(!JSON.stringify(row).includes(token), "the clear token is nowhere in the row");
  assert.equal(await h.operators.byToken("sop_wrong"), null);
  assert.equal((await h.operators.byToken(token)).id, operator.id);
});

test("a deactivated operator stops authenticating immediately", async () => {
  const h = await buildHarness();
  const { operator, token } = await h.operators.create({ name: "Gone" });
  await h.operators.deactivate(operator.id);
  assert.equal(await h.operators.byToken(token), null);
});

test("rotating a token invalidates the previous one", async () => {
  const h = await buildHarness();
  const { operator, token: old } = await h.operators.create({ name: "Rotate" });
  const { token: fresh } = await h.operators.rotate(operator.id);
  assert.equal(await h.operators.byToken(old), null);
  assert.equal((await h.operators.byToken(fresh)).id, operator.id);
});

test("an approval is attributed to the credential, not to whatever the body claims", async () => {
  // A caller that could name anyone as the decider would make `decided_by`
  // decorative — and that field is the entire point of P4-08.
  const h = await buildHarness();
  const call = await api(h);
  const { token } = await h.operators.create({ name: "Satria" });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "needs approval", approvalLevel: "L3" });
  await h.scheduler.notify();
  const approval = (await h.repos.approvals.listForTask(task.id))[0];

  const res = await call("POST", `/api/work/approvals/${approval.id}/decide`,
    { decision: "APPROVE", decided_by: "somebody-else" }, token);
  assert.equal(res.status, 200);
  assert.equal(res.json.approval.decidedBy, "Satria", "the credential names the decider");
});

test("a read-only operator can look but not act", async () => {
  const h = await buildHarness();
  const call = await api(h);
  const { token } = await h.operators.create({ name: "Auditor", role: "readonly" });
  assert.equal((await call("GET", "/api/work/tasks", null, token)).status, 200);
  const blocked = await call("POST", "/api/work/projects", { name: "x", workspacePath: "/opt/x" }, token);
  assert.equal(blocked.status, 403);
});

test("only an admin may mint or revoke an identity", async () => {
  // Otherwise the audit trail is circular: anyone could invent a name to act under.
  const h = await buildHarness();
  const call = await api(h);
  const { token: plain } = await h.operators.create({ name: "Ordinary" });
  assert.equal((await call("POST", "/api/work/operators", { name: "Sneaky" }, plain)).status, 403);

  const asService = await call("POST", "/api/work/operators", { name: "Admin", role: "admin" }, "service");
  assert.equal(asService.status, 200, JSON.stringify(asService.json));
  assert.ok(asService.json.token.startsWith("sop_"), "the token is shown exactly once, at creation");
});

test("whoami reports the acting identity honestly", async () => {
  const h = await buildHarness();
  const call = await api(h);
  const { token } = await h.operators.create({ name: "Satria" });
  assert.equal((await call("GET", "/api/work/whoami", null, token)).json.actor.name, "Satria");
  assert.equal((await call("GET", "/api/work/whoami", null, "service")).json.actor.kind, "service");
});
