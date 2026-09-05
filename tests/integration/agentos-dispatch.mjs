#!/usr/bin/env node
// P4-09 integration check — the real AgentOS, not a double.
//
// Runs the controller's own adapter (src/runtime/agentos.mjs) against a live
// AgentOS and asserts the contract POC-4 §11 verified end to end:
//   loopback forwarder → session login → cookie+bearer → POST /api/mission → dispatchId
//
// Deliberately does NOT assert that the mission completes: POC-2 E3/E7 showed
// dispatch records can stay `running` or report `timeout` while the work
// succeeds. What P4-09 owns is the handoff; completion is reconciliation's job.
//
// Usage (inside a container on the semanggi_internal network):
//   node agentos-dispatch.mjs --workspace-id <id> [--upstream agentos]
import { createAgentOSRuntime } from "../../src/runtime/agentos.mjs";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const read = (p) => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
};

const runtime = createAgentOSRuntime({
  upstreamHost: arg("upstream", "agentos"),
  upstreamPort: Number(arg("upstream-port", "3000")),
  username: process.env.AGENTOS_INITIAL_ADMIN_USERNAME ?? "admin",
  password: read("/run/secrets/agentos_initial_admin_password"),
  apiToken: read("/run/secrets/agentos_api_token"),
});

try {
  const health = await runtime.health();
  check("loopback forwarder reaches AgentOS", health.ok, `status ${health.status}`);

  const snap = await runtime.snapshot();
  check(
    "authenticated read works (login + cookie + bearer)",
    Boolean(snap && typeof snap === "object"),
    snap ? `revision ${snap.revision ?? "?"}` : "no snapshot",
  );

  const workspaceId = arg("workspace-id");
  if (!workspaceId) {
    check("dispatch", false, "no --workspace-id supplied");
  } else {
    const handoff = await runtime.dispatch({
      task: { id: "P4-09-CHECK", project_id: workspaceId, workspace_id: workspaceId },
      execution: { id: "P4-09-CHECK#1", session_ref: null },
      candidate: { provider: "zai", model: "glm-4.7", mode: "interactive" },
      worker: { id: "integration", agent_ref: "integration" },
      workspacePath: arg("workspace-path", "/tmp"),
      instruction:
        arg("mission") ??
        "Reply with the single word P4-09-OK. Do not create or modify any file.",
    });
    check(
      "POST /api/mission returned a dispatchId (write path through loopback)",
      Boolean(handoff.runtimeRef),
      handoff.runtimeRef ?? "none",
    );
  }
} catch (err) {
  check("integration run", false, String(err?.message ?? err));
} finally {
  await runtime.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
