import { createController } from "./src/app.mjs";
import { createApi } from "./src/api/server.mjs";
import { createFakeAgentOS } from "./src/runtime/fake-agentos.mjs";
import { readFileSync } from "node:fs";
const routing = JSON.parse(readFileSync("./config/routing.json", "utf8"));
const out = [];
const check = (n, ok, d = "") => out.push(`${ok ? "OK  " : "GAP "} ${n}${d ? "  — " + d : ""}`);

async function build() {
  const holder = {};
  const c = await createController({ routing, runtime: { dispatch: (r) => holder.fake.dispatch(r) },
    config: { maxRunning: 8, leaseTtlMs: 60_000, watchdogMs: 1_000_000 } });
  holder.fake = createFakeAgentOS({ repos: c.repos });
  c.fake = holder.fake;
  return c;
}
const call = async (api, method, path, { token = "right", body } = {}) => {
  let status = 0, payload = "";
  const req = { method, url: path, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
  req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(JSON.stringify(body)); };
  const res = { writeHead(s) { status = s; }, end(b) { payload = b ?? ""; }, setHeader() {} };
  await api.handle(req, res);
  return { status, payload };
};

// 1. Auth enforcement on a write route
{
  const c = await build(); const api = createApi(c, { token: "right" });
  const bad = await call(api, "POST", "/api/work/projects", { token: "wrong", body: { name: "x", workspacePath: "/w" } });
  check("write route rejects a wrong token", bad.status === 401 || bad.status === 403, `status ${bad.status}`);
}
// 2. Health must stay unauthenticated but leak nothing
{
  const c = await build(); const api = createApi(c, { token: "right" });
  const h = await call(api, "GET", "/api/work/health", { token: "" });
  check("health is open", h.status === 200, `status ${h.status}`);
  check("health leaks nothing", !/token|secret|key/i.test(h.payload), h.payload.slice(0, 80));
}
// 3. Does any API response echo a token?
{
  const c = await build(); const api = createApi(c, { token: "SUPER-SECRET-TOKEN" });
  await call(api, "POST", "/api/work/projects", { body: { name: "p", workspacePath: "/w" } });
  const r = await call(api, "GET", "/api/work/stats");
  check("responses do not echo the controller token", !r.payload.includes("SUPER-SECRET-TOKEN"));
}
// 4. Approval for an unknown harness session
{
  const c = await build(); const api = createApi(c, { token: "right" });
  const r = await call(api, "POST", "/api/work/approvals", { body: { sessionId: "not-a-real-session", tool: "Bash", level: "L3", question: "?" } });
  check("approval for an unknown session is refused", r.status >= 400, `status ${r.status}`);
}
// 5. Path traversal in workspacePath
{
  const c = await build();
  let rejected = false;
  try { await c.repos.projects.create({ name: "trav", weight: 1, workspacePath: "/opt/semanggi/../../etc" }); } catch { rejected = true; }
  check("a traversing workspace path is rejected", rejected, rejected ? "" : "'..' accepted — agent could be pointed outside the tree");
}
// 6. Relative workspace path
{
  const c = await build();
  let rejected = false;
  try { await c.repos.projects.create({ name: "rel", weight: 1, workspacePath: "relative/path" }); } catch { rejected = true; }
  check("a relative workspace path is rejected", rejected, rejected ? "" : "host and container paths must match exactly");
}
// 7. Usage recorded twice must not double-count
{
  const c = await build();
  const p = await c.repos.projects.create({ name: "u", weight: 1, workspacePath: "/wu" });
  const t = await c.repos.tasks.create({ projectId: p.id, title: "u" });
  const e = await c.repos.executions.create({ taskId: t.id, mode: "interactive" });
  await c.repos.executions.recordUsage(e.id, { input: 100, output: 10 });
  await c.repos.executions.recordUsage(e.id, { input: 100, output: 10 });
  const row = await c.repos.executions.get(e.id);
  check("repeated usage overwrites rather than accumulates", c.repos.executions.billableTokens(row) === 110,
    `billable=${c.repos.executions.billableTokens(row)}`);
}
console.log(out.join("\n"));
