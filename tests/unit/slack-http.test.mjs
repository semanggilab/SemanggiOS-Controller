// The Slack endpoints over real HTTP.
//
// The unit tests above exercise the handler; this exercises the door. The
// distinction matters because the door is where authentication lives, and a
// perfectly correct handler behind an unauthenticated route is an open control
// plane — this one can create, stop and re-model work.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { createSlackApp } from "../../src/interface/slack-app.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

const SECRET = "s3cr3t-signing-key";

async function serve() {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  h.slackApp = createSlackApp(h, { defaultProjectId: project.id });
  await h.operators.create({ name: "Satria", slackUserId: "U123", role: "admin" });

  const api = createApi(h, { token: "tok", slackSigningSecret: SECRET });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  /** Posts a form body signed the way Slack signs it. */
  const post = async (path, fields, { secret = SECRET, timestamp, contentType } = {}) => {
    const raw = new URLSearchParams(fields).toString();
    const ts = String(timestamp ?? Math.floor(h.clock.now() / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`, "utf8").digest("hex")}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType ?? "application/x-www-form-urlencoded",
        "x-slack-signature": sig,
        "x-slack-request-timestamp": ts,
      },
      body: raw,
    });
    return { status: res.status, body: await res.json() };
  };

  return { h, project, post, close: () => new Promise((r) => server.close(r)) };
}

test("a correctly signed slash command is served", async () => {
  const { h, post, close } = await serve();
  try {
    const { status, body } = await post("/api/work/slack/command", {
      text: "task write the runbook",
      user_id: "U123",
      user_name: "satria",
    });
    assert.equal(status, 200);
    assert.match(body.text, /Queued/);
    assert.equal((await h.repos.tasks.list({})).length, 1);
  } finally {
    await close();
  }
});

test("no bearer token is needed — and none is accepted in place of a signature", async () => {
  const { h, close } = await serve();
  const api = createApi(h, { token: "tok", slackSigningSecret: SECRET });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/work/slack/command`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer tok" },
      body: "text=queue&user_id=U123",
    });
    assert.equal(res.status, 401, "the service token must not substitute for a Slack signature");
  } finally {
    await new Promise((r) => server.close(r));
    await close();
  }
});

test("a tampered body is rejected and changes nothing", async () => {
  const { h, post, close } = await serve();
  try {
    const { status } = await post("/api/work/slack/command", { text: "task sneaky", user_id: "U123" }, { secret: "wrong" });
    assert.equal(status, 401);
    assert.equal((await h.repos.tasks.list({})).length, 0);
  } finally {
    await close();
  }
});

test("a replayed request outside the window is rejected", async () => {
  const { h, post, close } = await serve();
  try {
    // Half an hour behind the controller's own clock — far outside the five
    // minute window, and exactly what a captured request looks like later.
    const stale = Math.floor(h.clock.now() / 1000) - 60 * 30;
    const { status } = await post("/api/work/slack/command", { text: "queue", user_id: "U123" }, { timestamp: stale });
    assert.equal(status, 401);
  } finally {
    await close();
  }
});

test("a button press arrives as a nested payload and is honoured", async () => {
  const { h, project, post, close } = await serve();
  try {
    const task = await queuedTask(h, { project });
    const approval = await h.repos.approvals.create({
      taskId: task.id,
      level: "L3",
      question: "Allow Bash?",
      options: ["APPROVE", "REJECT"],
    });
    const { status, body } = await post("/api/work/slack/interactive", {
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U123", name: "satria" },
        actions: [{ action_id: "approve", value: approval.id }],
      }),
    });
    assert.equal(status, 200);
    assert.match(body.text, /Approved/);
    assert.equal((await h.repos.approvals.get(approval.id)).decided_by, "Satria");
  } finally {
    await close();
  }
});

test("an unregistered Slack user is refused even with a valid signature", async () => {
  const { h, post, close } = await serve();
  try {
    // The signature proves the request came from Slack. It says nothing about
    // whether this particular person may start work here — which is the whole
    // reason both checks exist.
    const { status, body } = await post("/api/work/slack/command", {
      text: "task do something expensive",
      user_id: "U-STRANGER",
      user_name: "mallory",
    });
    assert.equal(status, 200);
    assert.match(body.text, /not registered/i);
    assert.equal((await h.repos.tasks.list({})).length, 0);
  } finally {
    await close();
  }
});

test("stopping over HTTP takes two signed requests, not one", async () => {
  const { h, project, post, close } = await serve();
  try {
    const task = await queuedTask(h, { project });
    const asked = await post("/api/work/slack/command", { text: `stop ${task.id}`, user_id: "U123" });
    assert.match(asked.body.text, /Reply `yes`/);
    assert.equal((await h.repos.tasks.get(task.id)).status, Status.QUEUED);

    const done = await post("/api/work/slack/command", { text: "yes", user_id: "U123" });
    assert.match(done.body.text, /Stopped/);
    assert.equal((await h.repos.tasks.get(task.id)).status, Status.BLOCKED);
  } finally {
    await close();
  }
});

test("without a signing secret configured, every Slack request is refused", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  h.slackApp = createSlackApp(h, { defaultProjectId: project.id });
  const api = createApi(h, { token: "tok", slackSigningSecret: null });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/work/slack/command`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=queue&user_id=U123",
    });
    assert.equal(res.status, 401, "failing closed is the only safe default here");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
