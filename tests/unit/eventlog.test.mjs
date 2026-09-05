// P4-01 (append-only EventLog, immutable executions) and P4-13 (secret hygiene).
import test from "node:test";
import assert from "node:assert/strict";
import { Status, ExecutionStatus } from "../../src/domain/state-machine.mjs";
import { redact } from "../../src/domain/events.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

test("the database itself refuses to rewrite or delete an event", async () => {
  const h = await buildHarness();
  await h.events.append({ kind: "test.event", subjectType: "task", subjectId: "T1" });

  await assert.rejects(
    () => h.store.run(`UPDATE event_log SET kind = 'tampered' WHERE seq = 1`),
    /append-only/,
    "an UPDATE must abort even if application code attempts it",
  );
  await assert.rejects(() => h.store.run(`DELETE FROM event_log WHERE seq = 1`), /append-only/);

  const events = await h.events.list({ subjectId: "T1" });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "test.event");
});

test("a finalized execution cannot be modified afterwards", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "t" });
  await h.repos.tasks.setStatus(task.id, Status.QUEUED);
  await h.scheduler.notify();

  const execution = await h.repos.executions.latest(task.id);
  await h.repos.executions.setStatus(execution.id, ExecutionStatus.COMPLETE, { result: "final" });

  await assert.rejects(
    () => h.store.run(`UPDATE executions SET result = 'rewritten' WHERE id = ?`, [execution.id]),
    /finalized and immutable/,
  );
  await assert.rejects(
    () => h.store.run(`DELETE FROM executions WHERE id = ?`, [execution.id]),
    /history is immutable/,
  );
  assert.equal((await h.repos.executions.get(execution.id)).result, "final");
});

test("execution identity cannot drift even before finalization", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "t" });
  await h.repos.tasks.setStatus(task.id, Status.QUEUED);
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);

  await assert.rejects(
    () => h.store.run(`UPDATE executions SET revision_no = 99 WHERE id = ?`, [execution.id]),
    /identity is immutable/,
  );
});

test("credential-shaped fields are redacted before they reach the audit trail", async () => {
  const dirty = {
    workspacePath: "/nfs/alpha",
    token: "sk-ant-oat01-real-value",
    nested: { apiKey: "secret", api_key: "secret", Authorization: "Bearer x", safe: "keep" },
    list: [{ password: "hunter2" }],
  };
  const clean = redact(dirty);
  assert.equal(clean.workspacePath, "/nfs/alpha");
  assert.equal(clean.token, "[redacted]");
  assert.equal(clean.nested.apiKey, "[redacted]");
  assert.equal(clean.nested.api_key, "[redacted]");
  assert.equal(clean.nested.Authorization, "[redacted]");
  assert.equal(clean.nested.safe, "keep");
  assert.equal(clean.list[0].password, "[redacted]");

  const h = await buildHarness();
  await h.events.append({ kind: "k", subjectType: "task", subjectId: "T", payload: dirty });
  const [row] = await h.store.all(`SELECT payload FROM event_log`);
  assert.equal(row.payload.includes("sk-ant-oat01"), false, "no secret material reaches the table");
});

test("every dispatch decision is recorded, including the boring ones", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const blocker = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "dep" });
  const task = await h.repos.tasks.create({
    projectId: project.id,
    workerId: worker.id,
    title: "blocked",
    dependsOn: [blocker.id],
  });
  await h.repos.tasks.setStatus(task.id, Status.QUEUED);
  await h.scheduler.notify();

  const kinds = (await h.events.list({ subjectType: "task", subjectId: task.id })).map((e) => e.kind);
  assert.ok(kinds.includes("task.created"));
  assert.ok(kinds.includes("dispatch.decision"), "waiting is a decision worth auditing");
});
