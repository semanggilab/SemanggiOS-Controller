// GET /api/work/tasks/{id}/transcript — the Task Detail side panel's only
// source for reasoning and tool calls (see the route's own comment in
// server.mjs). What matters here: `blocks` actually reaches the wire in the
// gateway's own shape, an operator's own instruction turn never claims to
// have blocks it doesn't have, and a malformed row degrades rather than
// 500ing the whole transcript.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("transcript carries the gateway's own blocks for an assistant turn", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "blocks" });
  const exec = await h.repos.executions.create({
    taskId: task.id,
    revisionNo: 1,
    sessionMode: "FRESH",
    instruction: "do the thing",
    modelProvider: "zai",
    modelId: "glm-5.1",
  });
  await h.repos.messages.append(exec.id, {
    seq: 2,
    role: "assistant",
    at: 1000,
    content: [
      { type: "thinking", thinking: "weighing the options" },
      { type: "text", text: "done" },
      { type: "toolCall", id: "t1", name: "exec", arguments: { command: "ls -la" } },
    ],
  });

  const api = await startApi(h);
  try {
    const res = await api.call("GET", `/api/work/tasks/${task.id}/transcript`);
    assert.equal(res.status, 200);
    const assistantTurn = res.body.turns.find((t) => t.role === "assistant");
    assert.ok(assistantTurn, "assistant turn is present");
    assert.deepEqual(
      assistantTurn.blocks.map((b) => b.type),
      ["thinking", "text", "toolCall"],
      "the raw block sequence survives the wire, not just the flattened text",
    );
    assert.equal(assistantTurn.blocks[2].arguments.command, "ls -la");
  } finally {
    await api.close();
  }
});

test("the operator's own instruction turn carries no blocks", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "instruction" });
  await h.repos.executions.create({
    taskId: task.id,
    revisionNo: 1,
    sessionMode: "FRESH",
    instruction: "please do X",
    modelProvider: "zai",
    modelId: "glm-5.1",
  });

  const api = await startApi(h);
  try {
    const res = await api.call("GET", `/api/work/tasks/${task.id}/transcript`);
    const operatorTurn = res.body.turns.find((t) => t.role === "operator");
    assert.ok(operatorTurn);
    assert.equal(operatorTurn.blocks, null, "an instruction is plain text, not a gateway block array");
  } finally {
    await api.close();
  }
});

test("a malformed blocks row degrades to null rather than 500ing the transcript", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "malformed" });
  const exec = await h.repos.executions.create({
    taskId: task.id,
    revisionNo: 1,
    sessionMode: "FRESH",
    instruction: "x",
    modelProvider: "zai",
    modelId: "glm-5.1",
  });
  // Bypasses `messages.append`'s own JSON.stringify — this is only reachable
  // in practice through a hand-edited DB row, but the route must not trust
  // that the column is always well-formed.
  await h.store.run(
    `INSERT INTO execution_messages (execution_id, seq, role, content, blocks, at) VALUES (?, ?, ?, ?, ?, ?)`,
    [exec.id, 9, "assistant", "garbled", "{not json", 2000],
  );

  const api = await startApi(h);
  try {
    const res = await api.call("GET", `/api/work/tasks/${task.id}/transcript`);
    assert.equal(res.status, 200);
    const turn = res.body.turns.find((t) => t.seq === 9);
    assert.equal(turn.blocks, null);
    assert.equal(turn.text, "garbled", "the flattened text still comes through even when blocks don't parse");
  } finally {
    await api.close();
  }
});

test("preamble-wrapped echoes of the instruction are deduplicated, not repeated", async () => {
  // Measured on the cluster (D48): the gateway echoes the dispatched
  // instruction back as `user` turns wrapped in the execution preamble — and
  // more than once per run. The old exact-match dedup only caught a bare echo,
  // so the operator appeared to have said the same thing twice (or thrice).
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker, title: "echoes" });
  const exec = await h.repos.executions.create({
    taskId: task.id,
    revisionNo: 1,
    sessionMode: "FRESH",
    instruction: "do the thing",
    modelProvider: "zai",
    modelId: "glm-5.1",
  });
  const echoed = `## Konteks eksekusi (Semanggi)\nTask: ${task.id}\n\ndo the thing`;
  await h.repos.messages.append(exec.id, { seq: 1, role: "user", at: 1000, content: echoed });
  await h.repos.messages.append(exec.id, { seq: 3, role: "user", at: 2000, content: echoed });
  await h.repos.messages.append(exec.id, { seq: 4, role: "assistant", at: 3000, content: "done" });

  const api = await startApi(h);
  try {
    const res = await api.call("GET", `/api/work/tasks/${task.id}/transcript`);
    assert.equal(res.status, 200);
    const userTurns = res.body.turns.filter((t) => t.role === "user");
    assert.equal(userTurns.length, 0, "echoes of the instruction must not read as operator turns");
    assert.ok(res.body.turns.some((t) => t.role === "assistant"), "real turns survive the dedup");
  } finally {
    await api.close();
  }
});
