// P4-04 weighted fairness, P4-05 expedite TTL.
import test from "node:test";
import assert from "node:assert/strict";
import { orderCandidates, effectivePriority } from "../../src/scheduler/selection.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { buildHarness, queuedTask, Clock } from "../helpers/harness.mjs";

const task = (id, projectId, { priority = 2, createdAt = 0, expediteUntil = null } = {}) => ({
  id,
  project_id: projectId,
  priority,
  created_at: createdAt,
  expedite_until: expediteUntil,
});

test("weights set throughput ratio without starving the smallest project", () => {
  const projects = new Map([
    ["A", { weight: 5 }],
    ["B", { weight: 3 }],
    ["C", { weight: 1 }],
  ]);
  const tasks = [];
  for (let i = 0; i < 30; i++) {
    tasks.push(task(`a${i}`, "A", { createdAt: i }));
    tasks.push(task(`b${i}`, "B", { createdAt: i }));
    tasks.push(task(`c${i}`, "C", { createdAt: i }));
  }

  const ordered = orderCandidates(tasks, { projects, now: 1000 });
  const firstNine = ordered.slice(0, 9).map((t) => t.project_id);

  assert.equal(firstNine.filter((p) => p === "A").length, 5);
  assert.equal(firstNine.filter((p) => p === "B").length, 3);
  assert.equal(firstNine.filter((p) => p === "C").length, 1, "weight-1 still gets a slot in every round");

  const firstC = ordered.findIndex((t) => t.project_id === "C");
  assert.ok(firstC < 9, `weight-1 project must be served early, got position ${firstC}`);
});

test("a project already ahead on dispatches yields to one that is behind", () => {
  const projects = new Map([
    ["A", { weight: 1 }],
    ["B", { weight: 1 }],
  ]);
  const tasks = [task("a1", "A", { createdAt: 1 }), task("b1", "B", { createdAt: 2 })];

  // A has consumed 10 dispatches this window, B none: B goes first even though
  // its task is newer.
  const ordered = orderCandidates(tasks, {
    projects,
    dispatchCounts: new Map([["A", 10]]),
    now: 1000,
  });
  assert.equal(ordered[0].project_id, "B");
});

test("P0 preempts fairness entirely", () => {
  const projects = new Map([
    ["A", { weight: 9 }],
    ["C", { weight: 1 }],
  ]);
  const tasks = [
    task("a1", "A", { priority: 1, createdAt: 1 }),
    task("a2", "A", { priority: 1, createdAt: 2 }),
    task("c1", "C", { priority: 0, createdAt: 3 }),
  ];
  assert.equal(orderCandidates(tasks, { projects, now: 1000 })[0].id, "c1");
});

test("within a project, urgency then FIFO decides", () => {
  const projects = new Map([["A", { weight: 1 }]]);
  const tasks = [
    task("late-normal", "A", { priority: 2, createdAt: 30 }),
    task("early-normal", "A", { priority: 2, createdAt: 10 }),
    task("low", "A", { priority: 4, createdAt: 5 }),
    task("critical", "A", { priority: 1, createdAt: 40 }),
  ];
  assert.deepEqual(
    orderCandidates(tasks, { projects, now: 1000 }).map((t) => t.id),
    ["critical", "early-normal", "late-normal", "low"],
  );
});

test("P4-05: expedite boosts only while the TTL is live, and never rewrites priority", () => {
  const now = 1000;
  const boosted = task("t", "A", { priority: 3, expediteUntil: now + 500 });
  const lapsed = task("t", "A", { priority: 3, expediteUntil: now - 1 });

  assert.equal(effectivePriority(boosted, now), 1);
  assert.equal(effectivePriority(lapsed, now), 3);
  assert.equal(boosted.priority, 3, "stored priority is untouched");
});

test("expedite changes queue position and reverts once it lapses", async () => {
  const clock = new Clock();
  const h = await buildHarness({ clock });
  const project = await h.repos.projects.create({ name: "p", weight: 1, workspacePath: "/nfs/p" });
  const worker = await h.repos.workers.create({ role: "doc", agentRef: "w", maxConcurrent: 1 });
  await h.repos.resources.upsert({ provider: "google", model: "gemini-flash", concurrencyLimit: 4 });

  const routine = await queuedTask(h, { project, worker, title: "routine", priority: 2 });
  clock.advance(10);
  const background = await queuedTask(h, { project, worker, title: "background", priority: 4 });

  const projects = new Map([[project.id, project]]);
  const before = orderCandidates(await h.repos.tasks.list({ status: Status.QUEUED }), {
    projects,
    now: clock.now(),
  });
  assert.equal(before[0].id, routine.id);

  await h.repos.tasks.expedite(background.id, { ttlMs: 60_000 });
  const during = orderCandidates(await h.repos.tasks.list({ status: Status.QUEUED }), {
    projects,
    now: clock.now(),
  });
  assert.equal(during[0].id, background.id, "boost puts it in front");

  clock.advance(60_001);
  const after = orderCandidates(await h.repos.tasks.list({ status: Status.QUEUED }), {
    projects,
    now: clock.now(),
  });
  assert.equal(after[0].id, routine.id, "order reverts on its own; no cleanup job required");
  assert.equal((await h.repos.tasks.get(background.id)).priority, 4);
});

test("fairness survives a controller restart because counters live in the database", async () => {
  const h = await buildHarness();
  const a = await h.repos.projects.create({ name: "a", weight: 1, workspacePath: "/nfs/a" });
  const b = await h.repos.projects.create({ name: "b", weight: 1, workspacePath: "/nfs/b" });
  const worker = await h.repos.workers.create({ role: "doc", agentRef: "w", maxConcurrent: 10 });
  await h.repos.resources.upsert({ provider: "google", model: "gemini-flash", concurrencyLimit: 10 });

  for (let i = 0; i < 3; i++) {
    // Isolated: fairness is about dispatch counts per project, and sharing one
    // project workspace would serialise them on the lease instead.
    await queuedTask(h, { project: a, worker, isolate: true, title: `a${i}` });
  }
  await h.scheduler.notify();

  // Counters are read back from executions, exactly as a fresh process would.
  const counts = await h.repos.projects.dispatchCounts();
  assert.equal(counts.get(a.id), 3);
  assert.equal(counts.get(b.id), undefined);

  const bTask = await queuedTask(h, { project: b, worker, title: "b0" });
  const aTask = await queuedTask(h, { project: a, worker, title: "a3" });
  const ordered = orderCandidates([aTask, bTask], {
    projects: new Map([
      [a.id, a],
      [b.id, b],
    ]),
    dispatchCounts: counts,
    now: h.clock.now(),
  });
  assert.equal(ordered[0].id, bTask.id, "the project with no history is served first");
});
