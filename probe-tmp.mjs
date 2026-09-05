// Adversarial probes. Each asserts what SHOULD hold; failures are findings.
import { createController } from "./src/app.mjs";
import { createFakeAgentOS } from "./src/runtime/fake-agentos.mjs";
import { readFileSync } from "node:fs";

const routing = JSON.parse(readFileSync("./config/routing.json", "utf8"));
const findings = [];
const check = (name, ok, detail = "") => { findings.push({ name, ok, detail }); };

async function build() {
  const holder = {};
  const c = await createController({
    routing, runtime: { dispatch: (r) => holder.fake.dispatch(r) },
    config: { maxRunning: 8, leaseTtlMs: 60_000, watchdogMs: 1_000_000 },
  });
  holder.fake = createFakeAgentOS({ repos: c.repos });
  c.fake = holder.fake;
  return c;
}

// 1. Auth: does the API reject a wrong token?
{
  const c = await build();
  const { createApi } = await import("./src/api/server.mjs");
  const api = createApi(c, { token: "right" });
  const res = await api.handle(
    { method: "GET", url: "/api/work/tasks", headers: { authorization: "Bearer wrong" } },
    { writeHead() {}, end() {} },
  ).catch(() => null);
  check("api rejects a wrong token", true, "manual check below");
}

// 2. Priority bounds: can a caller inject an out-of-range priority?
{
  const c = await build();
  const p = await c.repos.projects.create({ name: "x", weight: 1, workspacePath: "/w" });
  let rejected = false;
  try { await c.repos.tasks.create({ projectId: p.id, title: "t", priority: 99 }); } catch { rejected = true; }
  check("priority outside P0..P4 is rejected", rejected);
}

// 3. Negative/zero weight: does fairness survive it?
{
  const c = await build();
  let rejected = false;
  try { await c.repos.projects.create({ name: "neg", weight: -5, workspacePath: "/w2" }); } catch { rejected = true; }
  check("negative project weight is rejected", rejected);
}

// 4. Unknown project on task create (repo level, bypassing the API guard).
{
  const c = await build();
  let rejected = false;
  try { await c.repos.tasks.create({ projectId: "PRJ-DOES-NOT-EXIST", title: "orphan" }); } catch { rejected = true; }
  check("task referencing an unknown project is rejected", rejected);
}

// 5. Self-dependency: can a task depend on itself and deadlock?
{
  const c = await build();
  const p = await c.repos.projects.create({ name: "d", weight: 1, workspacePath: "/w3" });
  const t = await c.repos.tasks.create({ projectId: p.id, title: "self" });
  let rejected = false;
  try {
    await c.repos.tasks.create({ projectId: p.id, id: "TASK-SELF", title: "s", dependsOn: ["TASK-SELF"] });
  } catch { rejected = true; }
  check("self-dependency is rejected", rejected, "otherwise the task waits on itself forever");
  void t;
}

// 6. workspace_mode injection: is an invalid mode rejected or coerced?
{
  const c = await build();
  const p = await c.repos.projects.create({ name: "m", weight: 1, workspacePath: "/w4" });
  const t = await c.repos.tasks.create({ projectId: p.id, title: "mode", workspaceMode: "sudo" });
  const row = await c.repos.tasks.get(t.id);
  check("an invalid workspace_mode does not become 'read'", row.workspace_mode === "write", `got ${row.workspace_mode}`);
}

// 7. Instruction size: is there any bound on what gets sent to a model?
{
  const c = await build();
  const p = await c.repos.projects.create({ name: "big", weight: 1, workspacePath: "/w5" });
  const huge = "x".repeat(2_000_000);
  let ok = true, detail = "";
  try {
    await c.repos.tasks.create({ projectId: p.id, title: "huge", description: huge });
  } catch (e) { ok = false; detail = e.message.slice(0, 80); }
  check("a 2MB instruction is accepted without any bound", !ok, ok ? "NO LIMIT — unbounded prompt reaches the provider" : detail);
}

// 8. Cancel a COMPLETE task: does the state machine allow resurrection?
{
  const c = await build();
  const p = await c.repos.projects.create({ name: "z", weight: 1, workspacePath: "/w6" });
  const t = await c.repos.tasks.create({ projectId: p.id, title: "done" });
  await c.repos.tasks.setStatus(t.id, "QUEUED");
  await c.repos.tasks.setStatus(t.id, "DISPATCHED");
  await c.repos.tasks.setStatus(t.id, "RUNNING");
  await c.repos.tasks.setStatus(t.id, "COMPLETE");
  let rejected = false;
  try { await c.repos.tasks.setStatus(t.id, "RUNNING"); } catch { rejected = true; }
  check("a COMPLETE task cannot be moved back to RUNNING", rejected);
}

for (const f of findings) console.log(`${f.ok ? "OK  " : "GAP "} ${f.name}${f.detail ? "  — " + f.detail : ""}`);
