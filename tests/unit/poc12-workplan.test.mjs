import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTaskIntake, PlanMode, progressForChildren } from "../../src/domain/task-intake.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

test("POC-12 intake distinguishes direct, lightweight, and full plans", () => {
  assert.equal(analyzeTaskIntake({ title: "Fix typo" }).planMode, PlanMode.DIRECT);
  assert.equal(
    analyzeTaskIntake({ title: "Update API and database, then test the migration" }).planMode,
    PlanMode.LIGHTWEIGHT,
  );
  const full = analyzeTaskIntake({
    title: "Ship feature",
    description: "- update frontend and backend\n- migrate database schema\n- build tests\n- deploy after security review",
  });
  assert.equal(full.planMode, PlanMode.FULL);
  assert.equal(full.shouldDecompose, true);
});

test("POC-12 projects WorkItems onto native child tasks and dependency edges", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const parent = await h.repos.tasks.create({
    projectId: project.id,
    workerId: worker.id,
    title: "parent",
    description: "implement and test",
    planMode: PlanMode.LIGHTWEIGHT,
    complexityScore: 4,
  });
  const first = await h.repos.tasks.create({
    projectId: project.id,
    parentTaskId: parent.id,
    workerId: worker.id,
    title: "TODO one",
  });
  const second = await h.repos.tasks.create({
    projectId: project.id,
    parentTaskId: parent.id,
    workerId: worker.id,
    title: "TODO two",
    dependsOn: [first.id],
  });

  const children = await h.repos.tasks.children(parent.id);
  assert.deepEqual(children.map((t) => t.id), [first.id, second.id]);
  assert.deepEqual(await h.repos.tasks.dependencies(second.id), [{ id: first.id, status: "CREATED" }]);
  assert.deepEqual(progressForChildren(children), {
    state: "WAITING", total: 2, complete: 0, blocked: 0, active: 0, percent: 0,
  });
});

test("POC-12 derives the parent plan lifecycle from child task truth", () => {
  assert.equal(progressForChildren([]).state, "EMPTY");
  assert.equal(progressForChildren([{ status: "WAIT_DEP" }]).state, "WAITING");
  assert.equal(progressForChildren([{ status: "RUNNING" }, { status: "WAIT_DEP" }]).state, "IN_PROGRESS");
  assert.equal(progressForChildren([{ status: "COMPLETE" }, { status: "WAIT_DEP" }]).state, "IN_PROGRESS");
  assert.equal(progressForChildren([{ status: "COMPLETE" }, { status: "BLOCKED" }]).state, "NEEDS_ATTENTION");
  assert.equal(progressForChildren([{ status: "COMPLETE" }, { status: "COMPLETE" }]).state, "COMPLETE");
});
