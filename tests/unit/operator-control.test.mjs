// Manual control over model and effort (E).
//
// The operator question: can I pick the model myself, or stock tasks and change
// the model and effort before running them again?
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

test("a task can name the exact model it wants, bypassing the category table", async () => {
  // `preferred` is an explicit list and takes precedence over category/tier
  // routing. This already worked; the test pins it as a contract.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, {
    project, worker, title: "pinned",
    modelPolicy: { preferred: ["glm-5.2-high"] },
  });
  await h.scheduler.notify();

  const dispatched = h.fake.dispatches.at(-1);
  assert.equal(dispatched.candidate.model, "glm-5.2");
  assert.equal(dispatched.candidate.thinking, "high", "the effort travels with the choice");
  void task;
});

test("a stocked task's model and effort can be changed before it runs", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  // Stocked with one model...
  const task = await queuedTask(h, {
    project, worker, title: "stocked",
    modelPolicy: { preferred: ["glm-5.1-on"] },
  });
  // ...then the operator changes their mind before it is dispatched.
  await h.repos.tasks.updatePlan(task.id, { modelPolicy: { preferred: ["glm-5.2-max"] } });
  await h.scheduler.notify();

  const dispatched = h.fake.dispatches.at(-1);
  assert.equal(dispatched.candidate.model, "glm-5.2");
  assert.equal(dispatched.candidate.thinking, "max");
});

test("the plan of a running task cannot be changed underneath it", async () => {
  // Changing the routing of a run already in flight would make the record
  // disagree with what actually ran, and the execution row is immutable for
  // exactly that reason.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "in flight" });
  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);

  await assert.rejects(
    () => h.repos.tasks.updatePlan(task.id, { modelPolicy: { preferred: ["glm-5.2-max"] } }),
    /cancel it or wait/,
  );
});

test("a revision can change the model and re-run in one step", async () => {
  // "Run that again, but on the stronger model" is the common case; two calls
  // invites the second being forgotten.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, {
    project, worker, title: "retry stronger",
    modelPolicy: { preferred: ["glm-5.1-on"] },
  });
  await h.scheduler.notify();
  const first = h.fake.dispatches.at(-1);
  assert.equal(first.candidate.model, "glm-5.1");

  const execution = await h.repos.executions.latest(task.id);
  await h.fake.startExecution(execution.id);
  await h.fake.completeExecution(execution.id);

  await h.repos.tasks.createRevision(task.id, {
    sessionMode: "FRESH",
    instruction: "again, harder",
    modelPolicy: { preferred: ["glm-5.2-max"] },
  });
  await h.scheduler.notify();

  const second = h.fake.dispatches.at(-1);
  assert.equal(second.candidate.model, "glm-5.2");
  assert.equal(second.candidate.thinking, "max");
});

test("an invalid plan change is refused rather than half-applied", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "bad edit" });
  await assert.rejects(() => h.repos.tasks.updatePlan(task.id, { priority: 42 }), /P0\.\.P4/);
  await assert.rejects(() => h.repos.tasks.updatePlan(task.id, { workspaceMode: "sudo" }), /read.*write/);
  assert.equal((await h.repos.tasks.get(task.id)).priority, 2, "nothing changed");
});

// Both of these come from real tasks that parked permanently on the cluster:
// one in a per-task workspace with no agent bound to it, one assigned to a
// worker that had no access to its project. Neither was reachable through any
// endpoint, which left hand-editing the database as the only way out — the one
// fix an append-only audit trail cannot survive.

test("a stranded workspace can be cleared back to the project's", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, {
    project,
    worker,
    title: "stranded",
    workspacePath: `${project.workspace_path}/executions/ORPHAN`,
  });
  assert.equal((await h.repos.tasks.get(task.id)).workspace_path, `${project.workspace_path}/executions/ORPHAN`);

  await h.repos.tasks.updatePlan(task.id, { workspacePath: null, actor: "satria" });
  assert.equal(
    (await h.repos.tasks.get(task.id)).workspace_path,
    null,
    "clearing it lets admission fall back to the project workspace",
  );
});

test("a workspace that escapes the root is refused", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "escape" });
  await assert.rejects(() => h.repos.tasks.updatePlan(task.id, { workspacePath: "relative/path" }), /absolute/);
  await assert.rejects(() => h.repos.tasks.updatePlan(task.id, { workspacePath: "/a/../../etc" }), /traverse/);
});

test("reassigning to a worker without project access is refused up front", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const other = await h.repos.projects.create({ name: "beta", workspacePath: "/nfs/workspaces/beta" });
  const stranger = await h.repos.workers.create({
    role: "documentation",
    agentRef: "beta-worker",
    projectAccess: [other.id],
  });
  const task = await queuedTask(h, { project, worker, title: "reassign" });

  await assert.rejects(
    () => h.repos.tasks.updatePlan(task.id, { workerId: stranger.id }),
    /no access/,
    "refusing now beats parking on WAIT_WORKER for the operator to diagnose later",
  );
  assert.equal((await h.repos.tasks.get(task.id)).worker_id, worker.id, "the assignment is unchanged");

  // A worker that does have access is accepted.
  const ok = await h.repos.workers.create({
    role: "documentation",
    agentRef: "alpha-worker-2",
    projectAccess: [project.id],
  });
  await h.repos.tasks.updatePlan(task.id, { workerId: ok.id, actor: "satria" });
  assert.equal((await h.repos.tasks.get(task.id)).worker_id, ok.id);
});

test("fixing the plan clears the retry backoff instead of making the operator wait it out", async () => {
  // Found live: a task whose stranded workspace had just been cleared still
  // carried 819 seconds of backoff and its old wait_reason, so the fix looked
  // like it had done nothing.
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "backed off" });
  await h.repos.tasks.setStatus(task.id, Status.WAIT_RESOURCE, { waitDetail: "no agent for that model" });
  await h.repos.tasks.setRetryAt(task.id, h.clock.now() + 15 * 60 * 1000);

  const before = await h.repos.tasks.get(task.id);
  assert.ok(before.next_retry_at > h.clock.now());
  assert.ok(before.wait_reason);

  await h.repos.tasks.updatePlan(task.id, { workspacePath: null, actor: "satria" });

  const after = await h.repos.tasks.get(task.id);
  assert.equal(after.next_retry_at, null, "the backoff's premise is void once a human changes the plan");
  assert.equal(after.wait_reason, null, "the old reason describes a plan that no longer exists");
});

test("a plan change records what it changed, so the log stays truthful", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "audited" });
  await h.repos.tasks.updatePlan(task.id, { workspacePath: `${project.workspace_path}/sub`, actor: "satria" });

  const rows = await h.store.all(`SELECT actor, payload FROM event_log WHERE subject_id = ? ORDER BY seq`, [task.id]);
  const planChange = rows.map((r) => ({ actor: r.actor, p: JSON.parse(r.payload) })).find((r) => r.p.change === "plan");
  assert.ok(planChange, "the change must be in the append-only log");
  assert.equal(planChange.actor, "satria");
  assert.equal(planChange.p.from.workspacePath, null);
  assert.equal(planChange.p.to.workspacePath, `${project.workspace_path}/sub`);
});

test("routing can be previewed without running anything", async () => {
  // Seeing what a policy would pick, and whether it could run at all, beats
  // discovering it from a parked task.
  const h = await buildHarness();
  const { createApi } = await import("../../src/api/server.mjs");
  const api = createApi(h, { token: "t" });
  const res = { status: 0, body: "" };
  const req = {
    method: "POST", url: "/api/work/routing/preview",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ modelPolicy: { preferred: ["glm-5.2-high", "glm-5.1-on"] } }));
    },
  };
  await api.handle(req, { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} });

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.candidates[0].model, "glm-5.2");
  assert.equal(parsed.candidates[0].effort, "high");
  assert.ok("availability" in parsed.candidates[0], "and whether it can actually run");
});

test("a task can be stocked without starting, then changed, then released", async () => {
  // The first attempt at this workflow on the cluster failed: the scheduler
  // dispatched the task before the operator could change its model, and the
  // edit was correctly refused as "already running". Stocking is what makes
  // "decide the model later" possible at all.
  const h = await buildHarness();
  const { createApi } = await import("../../src/api/server.mjs");
  const api = createApi(h, { token: "t" });
  const { project, worker } = await seedBasics(h);

  const call = async (method, path, body) => {
    const res = { status: 0, body: "" };
    const req = {
      method, url: path,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); },
    };
    await api.handle(req, { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} });
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
  };

  const created = await call("POST", "/api/work/tasks", {
    projectId: project.id, workerId: worker.id, title: "stocked",
    description: "later", hold: true,
    modelPolicy: { preferred: ["glm-5.1-on"] },
  });
  const id = created.json.task.id;
  assert.equal(created.json.task.status, Status.CREATED, "held, not queued");

  await h.scheduler.notify();
  assert.equal((await h.repos.tasks.get(id)).status, Status.CREATED, "a held task is never picked up");

  const patched = await call("PATCH", `/api/work/tasks/${id}`, { modelPolicy: { preferred: ["glm-5.2-max"] } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json.task.modelPolicy.preferred, ["glm-5.2-max"], "and the operator can see what they set");

  const started = await call("POST", `/api/work/tasks/${id}/start`, {});
  assert.equal(started.status, 200);
  await h.scheduler.notify();
  assert.equal(h.fake.dispatches.at(-1).candidate.model, "glm-5.2");
  assert.equal(h.fake.dispatches.at(-1).candidate.thinking, "max");
});

test("starting a task that is not held is refused", async () => {
  const h = await buildHarness();
  const { createApi } = await import("../../src/api/server.mjs");
  const api = createApi(h, { token: "t" });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "already going" });

  const res = { status: 0, body: "" };
  await api.handle(
    {
      method: "POST", url: `/api/work/tasks/${task.id}/start`,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); },
    },
    { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} },
  );
  assert.equal(res.status, 400);
});

// ── Stop → change → run again (the operator's actual ask) ───────────────

test("a running task can be stopped, re-planned, and run again", async () => {
  // CANCELLED is deliberately a dead end — right for "abandon this", wrong for
  // "pause, change the model, run it again". That second thing had no path at
  // all: PATCH refuses a running task and a revision cannot follow a cancel.
  const aborts = [];
  const h = await buildHarness();
  h.runtime = { abortRun: async (a) => { aborts.push(a); return { ok: true, aborted: true, status: "aborted" }; } };
  const { createApi } = await import("../../src/api/server.mjs");
  const api = createApi(h, { token: "t" });
  const { project, worker } = await seedBasics(h);

  const call = async (method, path, body) => {
    const res = { status: 0, body: "" };
    await api.handle(
      {
        method, url: path,
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); },
      },
      { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} },
    );
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
  };

  const task = await queuedTask(h, {
    project, worker, title: "running",
    modelPolicy: { preferred: ["glm-5.1-on"] },
  });
  await h.scheduler.notify();
  const execution = await h.repos.executions.latest(task.id);
  await h.repos.executions.update(execution.id, { session_ref: "sess-live" });
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.DISPATCHED);

  const stopped = await call("POST", `/api/work/tasks/${task.id}/stop`, { actor: "satria" });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.stopped.wasLive, true);
  assert.equal(stopped.json.stopped.abortedAtGateway, true, "the live turn is actually stopped, not just relabelled");
  assert.deepEqual(aborts, [{ sessionKey: "sess-live" }]);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
  assert.equal((await h.repos.leases.list()).length, 0, "and the workspace is freed");

  // Now the plan can change — which PATCH refused while it was running.
  const patched = await call("PATCH", `/api/work/tasks/${task.id}`, { modelPolicy: { preferred: ["glm-5.2-max"] } });
  assert.equal(patched.status, 200);

  // And it runs again on the new model.
  await h.repos.tasks.createRevision(task.id, { sessionMode: "FRESH", instruction: "again" });
  await h.scheduler.notify();
  assert.equal(h.fake.dispatches.at(-1).candidate.model, "glm-5.2");
  assert.equal(h.fake.dispatches.at(-1).candidate.thinking, "max");
});

test("stopping records honestly when there was nothing running", async () => {
  // "I stopped it" and "there was nothing to stop" lead to different states.
  // Flattening them would let a task be marked stopped while its run continued.
  const h = await buildHarness();
  const { createApi } = await import("../../src/api/server.mjs");
  const api = createApi(h, { token: "t" });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "idle" });

  const res = { status: 0, body: "" };
  await api.handle(
    {
      method: "POST", url: `/api/work/tasks/${task.id}/stop`,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); },
    },
    { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} },
  );
  const json = JSON.parse(res.body);
  assert.equal(json.stopped.wasLive, false);
  assert.equal(json.stopped.abortedAtGateway, false);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
});

test("a stopped task goes back through RESUMABLE, so the pause stays visible", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "paused" });
  await h.repos.tasks.setStatus(task.id, Status.BLOCKED, { reason: "stopped", actor: "satria" });

  await h.repos.tasks.createRevision(task.id, { sessionMode: "FRESH", instruction: "resume" });

  const history = (await h.events.list({ subjectType: "task", subjectId: task.id })).map((e) => e.payload?.to);
  assert.ok(history.includes(Status.RESUMABLE), `expected RESUMABLE in ${JSON.stringify(history)}`);
  assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);
});

test("the abort we asked for does not come back and cancel the task", async () => {
  // Found on the cluster: aborting first let the gateway's own lifecycle `end`
  // (aborted: true) race back, the sink read it as a cancellation, the task hit
  // the CANCELLED dead end, and the stop handler then failed with a 500. The
  // execution is finalised before the abort so that event lands harmlessly.
  const h = await buildHarness();
  const { createSessionEventSink } = await import("../../src/runtime/session-events.mjs");
  const sink = createSessionEventSink({
    repos: h.repos, events: h.events, scheduler: h.scheduler,
    runtime: { connect: async () => ({}), request: async () => ({ subscribed: true }) },
  });
  h.runtime = {
    abortRun: async () => {
      // The gateway answers the abort by emitting the end event, right now.
      await sink.handle("agent", {
        runId: (await h.repos.executions.latest(taskId)).id,
        stream: "lifecycle", sessionKey: "sess-live",
        data: { phase: "end", aborted: true, stopReason: "aborted" },
      });
      return { ok: true, aborted: true, status: "aborted" };
    },
  };

  const { createApi } = await import("../../src/api/server.mjs");
  const api = createApi(h, { token: "t" });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "racy stop" });
  const taskId = task.id;
  await h.scheduler.notify();
  await h.repos.executions.update((await h.repos.executions.latest(taskId)).id, { session_ref: "sess-live" });

  const res = { status: 0, body: "" };
  await api.handle(
    {
      method: "POST", url: `/api/work/tasks/${taskId}/stop`,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ actor: "satria" })); },
    },
    { writeHead: (s) => (res.status = s), end: (b) => (res.body = b ?? ""), setHeader() {} },
  );

  assert.equal(res.status, 200, res.body);
  assert.equal((await h.repos.tasks.get(taskId)).status, Status.BLOCKED, "paused, not abandoned");
});
