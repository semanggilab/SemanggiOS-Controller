// P4-13 secret hygiene + the §7.1 surface, exercised over a real HTTP server.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
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
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("every route except health demands the bearer token", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    assert.equal((await api.call("GET", "/api/work/health", null, { token: null })).status, 200);
    assert.equal((await api.call("GET", "/api/work/queue", null, { token: null })).status, 401);
    assert.equal((await api.call("GET", "/api/work/queue", null, { token: "wrong" })).status, 401);
    assert.equal((await api.call("GET", "/api/work/queue")).status, 200);
  } finally {
    await api.close();
  }
});

test("a task runs its whole lifecycle over the API", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const created = await api.call("POST", "/api/work/tasks", {
      projectId: project.id,
      workerId: worker.id,
      title: "write the runbook",
      description: "document the rotation procedure",
    });
    assert.equal(created.status, 200);
    const taskId = created.body.task.id;
    // Creation triggers a scheduling pass, so the task is already on its way.
    assert.equal(created.body.task.status, Status.DISPATCHED);

    const detail = await api.call("GET", `/api/work/tasks/${taskId}`);
    assert.equal(detail.body.executions.length, 1);
    assert.equal(detail.body.executions[0].revisionNo, 1);
    assert.equal(detail.body.executions[0].model, "google/gemini-flash");

    const execution = await h.repos.executions.latest(taskId);
    await h.fake.startExecution(execution.id);
    await h.fake.completeExecution(execution.id, { result: "done", tokensIn: 120, tokensOut: 40 });

    const revised = await api.call("POST", `/api/work/tasks/${taskId}/revisions`, {
      session_mode: "CONTINUE",
      instruction: "add the rollback section",
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.task.sessionPolicy, "CONTINUE");

    const after = await api.call("GET", `/api/work/tasks/${taskId}`);
    assert.equal(after.body.executions.length, 2);
    assert.equal(after.body.executions[0].finalized, true);

    const stats = await api.call("GET", "/api/work/stats");
    const flash = stats.body.models.find((m) => m.model === "google/gemini-flash" && m.status === "COMPLETE");
    assert.equal(flash.tokensInput, 120);
  } finally {
    await api.close();
  }
});

test("the queue endpoint explains why each task is waiting", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    await api.call("POST", "/api/work/tasks", { projectId: project.id, title: "no worker" });
    const queue = await api.call("GET", "/api/work/queue");
    const entry = queue.body.waiting.find((t) => t.status === Status.WAIT_WORKER);
    assert.ok(entry, "the task is visible in the queue");
    assert.match(entry.waitReason, /no worker assigned/);
  } finally {
    await api.close();
  }
});

test("expedite and cancel are operator actions with attribution", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const { body } = await api.call("POST", "/api/work/tasks", {
      projectId: project.id,
      workerId: worker.id,
      title: "t",
    });
    const id = body.task.id;

    assert.equal((await api.call("POST", `/api/work/tasks/${id}/expedite`, { ttl: -5 })).status, 400);
    const expedited = await api.call("POST", `/api/work/tasks/${id}/expedite`, {
      ttl: 60_000,
      actor: "satria",
    });
    assert.equal(expedited.body.task.expedited, true);

    const cancelled = await api.call("POST", `/api/work/tasks/${id}/cancel`, { actor: "satria" });
    assert.equal(cancelled.body.task.status, Status.CANCELLED);

    const events = await h.events.list({ subjectType: "task", subjectId: id });
    assert.ok(events.some((e) => e.kind === "task.expedited"));
    assert.ok(events.some((e) => e.kind === "task.cancelled" && e.actor === "satria"));
  } finally {
    await api.close();
  }
});

test("an approval decision resumes the task and records who decided", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const { body } = await api.call("POST", "/api/work/tasks", {
      projectId: project.id,
      workerId: worker.id,
      title: "migrate the database",
      approvalLevel: "L3",
    });
    const taskId = body.task.id;
    assert.equal(body.task.status, Status.WAIT_HUMAN);

    const [approval] = await h.repos.approvals.pendingForTask(taskId);

    assert.equal((await api.call("POST", `/api/work/approvals/${approval.id}/decide`, {})).status, 400);
    assert.equal(
      (await api.call("POST", `/api/work/approvals/${approval.id}/decide`, { decision: "APPROVE" })).status,
      400,
      "an unattributed decision is refused",
    );

    const noted = await api.call("POST", `/api/work/approvals/${approval.id}/comment`, {
      note: "which database?",
      by: "satria",
    });
    assert.equal(noted.body.approval.decision, null, "a comment does not close the approval");

    const decided = await api.call("POST", `/api/work/approvals/${approval.id}/decide`, {
      decision: "APPROVE",
      decided_by: "satria",
      note: "checked the backup",
    });
    assert.equal(decided.body.approval.decidedBy, "satria");
    assert.equal((await api.call("GET", `/api/work/tasks/${taskId}`)).body.task.status, Status.DISPATCHED);
  } finally {
    await api.close();
  }
});

test("no response body carries anything secret-shaped", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const { body } = await api.call("POST", "/api/work/tasks", {
      projectId: project.id,
      workerId: worker.id,
      title: "t",
    });
    const paths = [
      "/api/work/queue",
      "/api/work/resources",
      "/api/work/leases",
      "/api/work/projects",
      "/api/work/workers",
      "/api/work/stats",
      `/api/work/tasks/${body.task.id}`,
    ];
    for (const path of paths) {
      const res = await api.call("GET", path);
      const text = JSON.stringify(res.body);
      assert.equal(res.status, 200, path);
      assert.doesNotMatch(text, /"(token|secret|password|apiKey|api_key)"/i, `${path} leaks a field name`);
      assert.equal(text.includes(TOKEN), false, `${path} echoes the controller token`);
    }
  } finally {
    await api.close();
  }
});

test("malformed input is rejected rather than half-applied", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    assert.equal((await api.call("POST", "/api/work/tasks", { title: "no project" })).status, 400);
    assert.equal(
      (await api.call("POST", "/api/work/tasks", { projectId: "PRJ-NOPE", title: "ghost" })).status,
      400,
    );
    assert.equal((await api.call("GET", "/api/work/tasks/TASK-NOPE")).status, 404);
    assert.equal((await api.call("GET", "/api/work/nonsense")).status, 404);
    assert.equal((await h.repos.tasks.list({})).length, 0, "nothing was created by the failed calls");
  } finally {
    await api.close();
  }
});
