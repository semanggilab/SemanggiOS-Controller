// Task deletion (D54): idle work can be removed; live work cannot; execution
// history decides whether the removal is hard or soft; the audit trail records
// every removal either way.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { DELETABLE_STATUSES } from "../../src/domain/repositories.mjs";
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

/** A CANCELLED task that carries one finalized execution — the soft case. */
async function cancelledTaskWithExecution(h, project) {
  const task = await h.repos.tasks.create({ projectId: project.id, title: "ran, then abandoned" });
  const execution = await h.repos.executions.create({ taskId: task.id, instruction: "do it" });
  await h.repos.executions.setStatus(execution.id, "COMPLETE", { result: "done" });
  await h.repos.tasks.cancel(task.id, { actor: "satria" });
  return task;
}

test("deleting a CREATED task removes the row and its dependency edges", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const kept = await h.repos.tasks.create({ projectId: project.id, title: "kept" });
  const gone = await h.repos.tasks.create({
    projectId: project.id,
    title: "gone",
    dependsOn: [kept.id],
  });

  const result = await h.repos.tasks.delete(gone.id, { actor: "satria", note: "spring cleaning" });
  assert.deepEqual(result, {
    deleted: true, taskId: gone.id, method: "hard", status: Status.CREATED, title: "gone",
  });
  assert.equal(await h.repos.tasks.get(gone.id), null);
  // The edge it owned AND any edge pointing at it are both gone, or the FK
  // would have refused the delete.
  assert.deepEqual(await h.repos.tasks.dependencies(kept.id), []);

  const events = await h.events.list({ subjectType: "task", subjectId: gone.id });
  const deleted = events.find((e) => e.kind === "task.deleted");
  assert.ok(deleted, "the removal is recorded in the audit trail");
  assert.equal(deleted.actor, "satria");
  assert.equal(deleted.payload.method, "hard");
  assert.equal(deleted.payload.note, "spring cleaning");
});

test("a deleted task disappears from listings but not from history", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, title: "stocked, never started" });
  await h.repos.tasks.delete(task.id);

  assert.equal((await h.repos.tasks.list()).length, 0);
  assert.equal((await h.repos.tasks.list({ status: Status.CREATED })).length, 0);
  // includeDeleted is the audit hatch: the row is gone, so only the soft case
  // can ever answer it.
  assert.equal((await h.repos.tasks.list({ includeDeleted: true })).length, 0);
});

test("a CANCELLED task with executions is soft-deleted: hidden, not removed", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const task = await cancelledTaskWithExecution(h, project);

  const result = await h.repos.tasks.delete(task.id, { actor: "satria" });
  assert.equal(result.method, "soft");

  // Hidden from every listing…
  assert.equal((await h.repos.tasks.list({ status: Status.CANCELLED })).length, 0);
  // …but the row survives because immutable executions reference it, and so
  // does the transcript that hangs off them.
  const row = await h.repos.tasks.get(task.id);
  assert.ok(row.deleted_at, "deleted_at marks the soft delete");
  assert.equal((await h.repos.executions.listByTask(task.id)).length, 1);
  assert.equal((await h.repos.tasks.list({ includeDeleted: true })).length, 1);

  const events = await h.events.list({ subjectType: "task", subjectId: task.id });
  assert.equal(events.find((e) => e.kind === "task.deleted").payload.method, "soft");
});

test("a finished task is deletable — the revision it could still get is what deletion forecloses", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);

  const complete = await h.repos.tasks.create({ projectId: project.id, title: "done" });
  await h.repos.tasks.setStatus(complete.id, Status.QUEUED);
  await h.repos.tasks.setStatus(complete.id, Status.DISPATCHED);
  await h.repos.tasks.setStatus(complete.id, Status.COMPLETE);
  const result = await h.repos.tasks.delete(complete.id, { actor: "satria" });
  assert.equal(result.deleted, true);

  // A FAILED task is terminal the same way.
  const failed = await h.repos.tasks.create({ projectId: project.id, title: "failed" });
  await h.repos.tasks.setStatus(failed.id, Status.QUEUED);
  await h.repos.tasks.setStatus(failed.id, Status.DISPATCHED);
  await h.repos.tasks.setStatus(failed.id, Status.FAILED);
  assert.equal((await h.repos.tasks.delete(failed.id)).deleted, true);
});

test("deletion refuses anything that is or could become live work", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);

  const queued = await h.repos.tasks.create({ projectId: project.id, title: "queued" });
  await h.repos.tasks.setStatus(queued.id, Status.QUEUED);
  await assert.rejects(() => h.repos.tasks.delete(queued.id), /is QUEUED/);

  // BLOCKED is parked work, not finished work: a human is expected to look,
  // so deleting it would be stopping work silently.
  const blocked = await h.repos.tasks.create({ projectId: project.id, title: "parked" });
  await h.repos.tasks.setStatus(blocked.id, Status.QUEUED);
  await h.repos.tasks.setStatus(blocked.id, Status.BLOCKED, { reason: "test" });
  await assert.rejects(() => h.repos.tasks.delete(blocked.id), /is BLOCKED/);

  await assert.rejects(() => h.repos.tasks.delete("TASK-NOPE"), /unknown task/);

  // The allowlist is exactly the four provably-idle statuses.
  assert.deepEqual(
    [...DELETABLE_STATUSES],
    [Status.CREATED, Status.CANCELLED, Status.COMPLETE, Status.FAILED],
  );
});

test("a task is deleted exactly once", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, title: "once" });
  await h.repos.tasks.delete(task.id);
  await assert.rejects(() => h.repos.tasks.delete(task.id), /unknown task/);
});

test("DELETE /api/work/tasks/{id} is admin-only and names what it removed", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const task = await h.repos.tasks.create({ projectId: project.id, title: "via api" });

    const { token } = await h.operators.create({ name: "budi", role: "operator" });
    const forbidden = await api.call("DELETE", `/api/work/tasks/${task.id}`, {}, { token });
    assert.equal(forbidden.status, 403);

    const unknown = await api.call("DELETE", "/api/work/tasks/TASK-NOPE");
    assert.equal(unknown.status, 404);

    const ok = await api.call("DELETE", `/api/work/tasks/${task.id}`, { note: "wrong project" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deleted, true);
    assert.equal(ok.body.method, "hard");
    assert.equal(ok.body.title, "via api");

    // The note crossed the wire — the dispatcher parses DELETE bodies too
    // (the PUT role-levels incident is the reason this is asserted, not
    // assumed).
    const events = await h.events.list({ subjectType: "task", subjectId: task.id });
    assert.equal(events.find((e) => e.kind === "task.deleted").payload.note, "wrong project");
  } finally {
    await api.close();
  }
});

test("purge demands explicit deletable statuses and reports every task touched", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    assert.equal((await api.call("POST", "/api/work/tasks/purge", {})).status, 400);
    assert.equal(
      (await api.call("POST", "/api/work/tasks/purge", { statuses: [Status.RUNNING] })).status,
      400,
    );

    // 95-task reality on the cluster: CREATED stocked by PREPARE, CANCELLED
    // left behind by operators — some with execution history, some without.
    await h.repos.tasks.create({ projectId: project.id, title: "stocked 1" });
    await h.repos.tasks.create({ projectId: project.id, title: "stocked 2" });
    await cancelledTaskWithExecution(h, project);

    const { token } = await h.operators.create({ name: "budi", role: "operator" });
    assert.equal(
      (await api.call("POST", "/api/work/tasks/purge", { statuses: ["CREATED", "CANCELLED"] }, { token })).status,
      403,
    );

    const purge = await api.call("POST", "/api/work/tasks/purge", {
      statuses: [Status.CREATED, Status.CANCELLED],
      note: "board cleanup",
    });
    assert.equal(purge.status, 200);
    assert.equal(purge.body.deleted.length, 3);
    assert.equal(purge.body.refused.length, 0);
    assert.deepEqual(
      purge.body.deleted.map((d) => d.method).sort(),
      ["hard", "hard", "soft"],
    );
    assert.ok(purge.body.deleted.every((d) => d.taskId && d.title), "every removal is named");

    assert.equal((await h.repos.tasks.list({ includeDeleted: true })).length, 1);
    assert.equal((await h.repos.tasks.list()).length, 0);
  } finally {
    await api.close();
  }
});
