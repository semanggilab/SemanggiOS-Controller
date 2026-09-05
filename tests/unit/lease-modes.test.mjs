// Read/write workspace leases.
//
// Question that prompted this: with one workspace per project, does a
// documentation task really have to wait behind a coding task? Answer: only if
// it writes. The lease protects concurrent WRITES to a shared tree, so readers
// can share it and P4-07 is unchanged for writers.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

test("two writers still take turns — P4-07 is untouched", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const a = await queuedTask(h, { project, worker, title: "coding a" });
  await h.scheduler.notify();
  const b = await queuedTask(h, { project, worker, title: "coding b" });
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(a.id)).status, Status.DISPATCHED);
  assert.equal((await h.repos.tasks.get(b.id)).status, Status.WAIT_WORKSPACE);
});

test("readers share a workspace with each other", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10 });
  const a = await queuedTask(h, { project, worker, title: "read a", workspaceMode: "read" });
  await h.scheduler.notify();
  const b = await queuedTask(h, { project, worker, title: "read b", workspaceMode: "read" });
  await h.scheduler.notify();

  assert.equal((await h.repos.tasks.get(a.id)).status, Status.DISPATCHED);
  assert.equal((await h.repos.tasks.get(b.id)).status, Status.DISPATCHED, "a reader must not block a reader");
  assert.equal((await h.repos.leases.holders(project.workspace_path)).length, 2);
});

test("a writer waits for readers, and readers wait for a writer", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10 });
  const reader = await queuedTask(h, { project, worker, title: "reader", workspaceMode: "read" });
  await h.scheduler.notify();
  const writer = await queuedTask(h, { project, worker, title: "writer" });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(writer.id)).status, Status.WAIT_WORKSPACE);
  assert.match((await h.repos.tasks.get(writer.id)).wait_reason, /write lease blocked by read/);

  // And the other way round: once a writer holds it, a reader waits.
  const h2 = await buildHarness();
  const s2 = await seedBasics(h2, { maxConcurrent: 10 });
  await queuedTask(h2, { project: s2.project, worker: s2.worker, title: "writer first" });
  await h2.scheduler.notify();
  const late = await queuedTask(h2, { project: s2.project, worker: s2.worker, title: "reader late", workspaceMode: "read" });
  await h2.scheduler.notify();
  assert.equal((await h2.repos.tasks.get(late.id)).status, Status.WAIT_WORKSPACE);
  assert.match((await h2.repos.tasks.get(late.id)).wait_reason, /read lease blocked by write/);
  void reader;
});

test("write is the default, so nothing becomes shared by omission", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const t = await queuedTask(h, { project, worker, title: "unspecified" });
  assert.equal((await h.repos.tasks.get(t.id)).workspace_mode, "write");
});

test("releasing one reader leaves the others holding the path", async () => {
  // The old release() deleted every row for a path. With shared readers that
  // would evict work that never finished.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10 });
  const a = await queuedTask(h, { project, worker, title: "r1", workspaceMode: "read" });
  await h.scheduler.notify();
  const b = await queuedTask(h, { project, worker, title: "r2", workspaceMode: "read" });
  await h.scheduler.notify();

  const ea = await h.repos.executions.latest(a.id);
  await h.repos.leases.release(project.workspace_path, { executionId: ea.id });

  const left = await h.repos.leases.holders(project.workspace_path);
  assert.equal(left.length, 1);
  assert.equal(left[0].execution_id, (await h.repos.executions.latest(b.id)).id);
});

test("release without an id refuses to guess when several hold the path", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h, { maxConcurrent: 10 });
  await queuedTask(h, { project, worker, title: "r1", workspaceMode: "read" });
  await h.scheduler.notify();
  await queuedTask(h, { project, worker, title: "r2", workspaceMode: "read" });
  await h.scheduler.notify();

  assert.equal(await h.repos.leases.release(project.workspace_path), false, "ambiguous release must not evict anyone");
  assert.equal((await h.repos.leases.holders(project.workspace_path)).length, 2);
  // An operator can still clear the path deliberately.
  assert.equal(await h.repos.leases.release(project.workspace_path, { all: true, actor: "operator" }), true);
  assert.equal((await h.repos.leases.holders(project.workspace_path)).length, 0);
});
