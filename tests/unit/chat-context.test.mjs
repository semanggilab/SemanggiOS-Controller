// POC-10 T4 — injeksi konteks project/task (spec §7.1, §12.7).
//
// Jangkar yang diuji: rujukan TASK-XXXX membentuk blok dari DB sungguhan;
// pesan riset murni TIDAK mendapat injeksi (null, bukan string kosong —
// perbedaannya adalah keputusan "tidak perlu Brain melihat apa pun"); dua
// rujukan → dua blok; blok TIDAK PERNAH tersimpan sebagai chat_messages.
import test from "node:test";
import assert from "node:assert/strict";
import { buildChatContext } from "../../src/domain/chat-context.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("research message gets no injection — null, not an empty block", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const { block, taskIds, projectHint } = await buildChatContext({
    repos: h.repos,
    events: h.events,
    text: "what is the best way to learn rust for a python developer?",
    project,
  });
  assert.equal(block, null);
  assert.deepEqual(taskIds, []);
  assert.equal(projectHint, false);
});

test("a TASK reference builds a status block from the real database", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await h.repos.tasks.create({
    projectId: project.id,
    workerId: worker.id,
    title: "write the runbook",
    description: "document rotation",
    modelPolicy: { role: "documentation", level: "normal", preferred: ["gemini-flash"] },
  });
  await h.repos.tasks.setStatus(task.id, Status.QUEUED);
  await h.events.append({
    kind: "task.queued",
    subjectType: "task",
    subjectId: task.id,
    actor: "test",
    payload: {},
  });

  const { block, taskIds } = await buildChatContext({
    repos: h.repos,
    events: h.events,
    text: `please summarise ${task.id} for me`,
    project,
  });
  assert.ok(block, "expected a context block");
  assert.deepEqual(taskIds, [task.id]);
  assert.ok(block.includes(task.id));
  assert.ok(block.includes("QUEUED"));
  assert.ok(block.includes("documentation"));
  assert.ok(block.includes("task.queued"));
});

test("two task references produce two blocks; unknown ids are reported, not guessed", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const a = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "a" });
  const b = await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "b" });
  const { block, taskIds } = await buildChatContext({
    repos: h.repos,
    events: h.events,
    text: `compare ${a.id} and ${b.id}, and also TASK-DEADBEEF`,
    project,
  });
  assert.deepEqual(taskIds, [a.id, b.id, "TASK-DEADBEEF"]);
  assert.ok(block.includes(a.id));
  assert.ok(block.includes(b.id));
  // Id hantu DILAPORKAN ke Brain sebagai tidak ada — bukan ditebak.
  assert.ok(block.includes("TASK-DEADBEEF: not found in this controller"));
});

test("project wording pulls a project summary without any task reference", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  await h.repos.tasks.create({ projectId: project.id, workerId: worker.id, title: "only one" });
  const { block, projectHint } = await buildChatContext({
    repos: h.repos,
    events: h.events,
    text: "how is this project going? gimana project ini",
    project,
  });
  assert.equal(projectHint, true);
  assert.ok(block.includes(project.name));
  assert.ok(/CREATED=1/.test(block), "task counts appear in the project block");
});

test("context block is injection-only: append + list never see it", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const session = await h.repos.chatSessions.create({
    projectId: project.id,
    brainId: (await h.brains.get("gemini-flash")).id,
    actor: "test",
  });
  const { block } = await buildChatContext({
    repos: h.repos,
    events: h.events,
    text: "status of project ini",
    project,
  });
  assert.ok(block);
  await h.repos.chatMessages.append({ sessionId: session.id, role: "operator", content: "status of project ini" });
  const transcript = await h.repos.chatMessages.list(session.id);
  assert.equal(transcript.length, 1);
  for (const m of transcript) {
    assert.ok(!m.content.includes("Context injected by Semanggi"));
  }
  await settle();
});
