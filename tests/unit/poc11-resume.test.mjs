import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, queuedTask, seedBasics } from "../helpers/harness.mjs";
import { createSharedState } from "../../src/runtime/shared-state.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

test("POC-11 keeps checkpoint durable and resumes through the native revision path", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "resume me", description: "finish the adapter" });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  await h.repos.checkpoints.create({
    taskId: task.id,
    executionId: execution.id,
    checkpointType: "failure",
    stopReason: "PROVIDER_QUOTA",
    objective: task.description,
    progress: { completed: ["adapter"], nextActions: ["run integration test"] },
    workspaceState: { path: task.workspace_path },
    contextSummary: "Adapter exists; integration test remains.",
  });
  await h.repos.executions.setStatus(execution.id, "BLOCKED", { result: "quota" });
  await h.repos.tasks.setStatus(task.id, Status.BLOCKED, { reason: "quota" });

  const checkpoint = await h.repos.checkpoints.latestForTask(task.id);
  assert.equal(checkpoint.execution_id, execution.id);
  assert.deepEqual(checkpoint.progress.nextActions, ["run integration test"]);

  await h.repos.tasks.createRevision(task.id, {
    sessionMode: "CONTINUE",
    instruction: `<semanggi_resume_context>${checkpoint.context_summary}</semanggi_resume_context>`,
  });
  const resumed = await h.repos.tasks.get(task.id);
  assert.equal(resumed.status, Status.QUEUED);
  assert.equal(resumed.session_policy, "CONTINUE");
  assert.match(resumed.pending_instruction, /semanggi_resume_context/);
});

test("POC-11 shared coordination lock and idempotency are process-safe contracts", async () => {
  const state = await createSharedState({ driver: "memory" });
  let calls = 0;
  const first = await state.withLock("resume:TASK-1", 30_000, async () => {
    calls += 1;
    await state.setJson("resume:idempotency:key", { execution: "EXE-2" }, { ttlMs: 60_000 });
    return "ok";
  });
  assert.equal(first, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(await state.getJson("resume:idempotency:key"), { execution: "EXE-2" });
});
