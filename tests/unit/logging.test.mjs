// Structured logging (A).
//
// The point is not that lines appear — it is that the lines an operator needs
// during an incident are the ones present, carry the ids that thread across
// layers, and never carry a credential.
import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, scrub } from "../../src/domain/logger.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

function capture() {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  return { log, lines, find: (evt) => lines.filter((l) => l.evt === evt) };
}

test("secrets never reach a log line", async () => {
  // Same guarantee as the EventLog (P4-13). A log is read by more people than
  // the database is, so this matters at least as much there.
  const { log, lines } = capture();
  log.info("probe", {
    token: "sk-live-do-not-print",
    nested: { apiKey: "AIza-secret", authorization: "Bearer xyz" },
    safe: "visible",
  });
  const dumped = JSON.stringify(lines[0]);
  assert.ok(!dumped.includes("sk-live-do-not-print"));
  assert.ok(!dumped.includes("AIza-secret"));
  assert.ok(!dumped.includes("Bearer xyz"));
  assert.match(dumped, /visible/);
});

test("an unusually long string is truncated rather than dumped", () => {
  // Long opaque values are usually keys or transcripts. Truncating keeps a log
  // readable and keeps an accidental credential unusable.
  const out = scrub("x".repeat(500));
  assert.match(out, /\(500 chars\)$/);
  assert.ok(out.length < 120);
});

test("a child logger stamps correlation fields on every line", () => {
  const { log, lines } = capture();
  log.child({ task: "TASK-1", exec: "TASK-1#1" }).info("something", { extra: 1 });
  assert.equal(lines[0].task, "TASK-1");
  assert.equal(lines[0].exec, "TASK-1#1");
  assert.equal(lines[0].extra, 1);
});

test("logging cannot crash the caller", () => {
  const { log, lines } = capture();
  const cyclic = {};
  cyclic.self = cyclic;
  log.info("cyclic", { cyclic });
  assert.equal(lines.at(-1).evt, "log.unserialisable");
});

test("a dispatched task logs the model and effort actually chosen", async () => {
  const { log, find } = capture();
  const h = await buildHarness({ log });
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "logged" });
  await h.scheduler.notify();

  const sent = find("dispatch.sent");
  assert.equal(sent.length, 1, "one dispatch, one line");
  assert.equal(sent[0].task, task.id);
  assert.ok(sent[0].provider && sent[0].model, "the model that ran must be named");
  assert.ok("effort" in sent[0], "effort is recorded even when null");
  assert.equal(sent[0].workspaceMode, "write");
  assert.ok(sent[0].workspace, "the workspace is named");
});

test("task status changes are logged with their reason", async () => {
  const { log, find } = capture();
  const h = await buildHarness({ log });
  const { project, worker } = await seedBasics(h);
  const a = await queuedTask(h, { project, worker, title: "first" });
  await h.scheduler.notify();
  const b = await queuedTask(h, { project, worker, title: "second" });
  await h.scheduler.notify();

  const statuses = find("task.status");
  assert.ok(statuses.some((l) => l.task === a.id && l.to === "DISPATCHED"));
  assert.ok(statuses.some((l) => l.task === b.id && l.to === "WAIT_WORKSPACE"));
});

test("a blocked workspace says who holds it and in which mode", async () => {
  const { log, find } = capture();
  const h = await buildHarness({ log });
  const { project, worker } = await seedBasics(h);
  await queuedTask(h, { project, worker, title: "holder" });
  await h.scheduler.notify();
  await queuedTask(h, { project, worker, title: "waiter" });
  await h.scheduler.notify();

  const blocked = find("workspace.blocked");
  assert.ok(blocked.length >= 1);
  assert.equal(blocked[0].want, "write");
  assert.equal(blocked[0].heldMode, "write");
  assert.ok(blocked[0].heldBy, "the holding execution must be named");
});

test("acquiring a lease is logged with its mode", async () => {
  const { log, find } = capture();
  const h = await buildHarness({ log });
  const { project, worker } = await seedBasics(h);
  await queuedTask(h, { project, worker, title: "reader", workspaceMode: "read" });
  await h.scheduler.notify();
  const acquired = find("lease.acquired");
  assert.equal(acquired[0].mode, "read");
  assert.ok(acquired[0].workspace);
});
