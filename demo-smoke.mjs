#!/usr/bin/env node
// Quickstart: runs the whole operator flow locally against a fake runtime.
//
//   node demo-smoke.mjs
//
// No cluster, no credentials, no model quota. Use it to see the API and the
// chat surface working, and as a template for the real calls. The only thing
// swapped out is the runtime: a fake AgentOS stands in for dispatch, because
// real dispatch is still blocked on device pairing (docs/decisions.md D13).
import { createController } from "./src/app.mjs";
import { createApi } from "./src/api/server.mjs";
import { createFakeAgentOS } from "./src/runtime/fake-agentos.mjs";
import { createSlackSurface } from "./src/interface/slack.mjs";
import { readFileSync, rmSync } from "node:fs";
import { once } from "node:events";

const DB = process.env.DEMO_DB ?? "/tmp/semanggi-demo.db";
const TOKEN = "demo-token";
const PORT = Number(process.env.DEMO_PORT ?? 8099);

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(DB + suffix);
  } catch {}
}

const holder = {};
const controller = await createController({
  storeLocation: DB,
  routing: JSON.parse(readFileSync(new URL("./config/routing.json", import.meta.url), "utf8")),
  runtime: { dispatch: (req) => holder.fake.dispatch(req) },
});
holder.fake = createFakeAgentOS({ repos: controller.repos });

const api = createApi(controller, { token: TOKEN });
const server = api.createServer();
server.listen(PORT, "127.0.0.1");
await once(server, "listening");

const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

console.log(`listening on http://127.0.0.1:${PORT}  (bearer ${TOKEN})\n`);

// 1. A project is the unit of fair scheduling; weight decides its share.
const { project } = await call("POST", "/api/work/projects", {
  name: "semanggi",
  weight: 5,
  workspacePath: "/nfs/workspaces/semanggi",
});
console.log("project :", project.id, `(weight ${project.weight})`);

// 2. A worker maps to an OpenClaw agent. Tasks wait on WAIT_WORKER without one.
const { worker } = await call("POST", "/api/work/workers", {
  role: "documentation",
  agentRef: "doc-worker",
  maxConcurrent: 2,
  projectAccess: [project.id],
});
console.log("worker  :", worker.id, `-> agent ${worker.agentRef}`);

// 3. A resource is a model the scheduler is allowed to use. Without one, the
//    routing policy resolves to nothing and tasks park on WAIT_RESOURCE.
await call("POST", "/api/work/resources", { provider: "google", model: "gemini-flash", concurrencyLimit: 4 });
console.log("resource: google/gemini-flash");

// 4. Creating a task also runs a scheduling pass, so the reply already shows
//    whether it dispatched or what it is waiting for.
const { task } = await call("POST", "/api/work/tasks", {
  projectId: project.id,
  workerId: worker.id,
  title: "tulis runbook rotasi token",
  qualityClass: "L2",
});
console.log("task    :", task.id, "->", task.status, task.waitReason ? `(${task.waitReason})` : "");

// 5. The same thing in operator language, through the chat surface.
controller.slack = createSlackSurface(controller, { defaultProjectId: project.id });
const chat = await call("POST", "/api/work/slack", { text: "task periksa konfigurasi nginx", user: "satria" });
console.log("chat    :", chat.reply.split("\n")[0]);

const asked = await call("POST", "/api/work/slack", { text: `status ${task.id}`, user: "satria" });
console.log("status  :", asked.reply.split("\n")[1]);

// 6. The queue always says why nothing is moving.
const queue = await call("GET", "/api/work/queue");
console.log(`queue   : running=${queue.running} waiting=${queue.waiting.length}`);
for (const w of queue.waiting) console.log(`          ${w.id} ${w.status} ${w.waitReason ?? ""}`);

console.log("\ntry:");
console.log(`  curl -H 'authorization: Bearer ${TOKEN}' http://127.0.0.1:${PORT}/api/work/queue`);
console.log(`  curl -H 'authorization: Bearer ${TOKEN}' -H 'content-type: application/json' \\`);
console.log(`       -d '{"text":"expedite ${task.id} 30m","user":"satria"}' \\`);
console.log(`       http://127.0.0.1:${PORT}/api/work/slack`);
console.log("\nctrl-c to stop");
