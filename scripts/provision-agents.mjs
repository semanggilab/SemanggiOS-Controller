#!/usr/bin/env node
// Provision the workspace+agent pairs the controller dispatches to.
//
// This is an OPERATOR tool, not controller runtime code, and the split is
// deliberate. Verified live against the cluster:
//
//   agents.list   → ok            (operator.read)
//   agents.create → INVALID_REQUEST "missing scope: operator.admin"
//
// The controller holds operator.write precisely so that it can run work but
// cannot reshape the fleet it runs on. Moving provisioning into the controller
// would mean granting it operator.admin — and at that point it could also
// override provider/model per dispatch, which would make this whole
// agent-per-model arrangement unnecessary. That is the real decision behind
// D14: the narrow scope is worth one operator-run script.
//
// Two things this creates, per POC-4 §4 and D14:
//   * one agent per (workspace, model) the routing policy can select
//   * agents named deterministically, so re-running is idempotent
//
// Usage (from a host that can reach the gateway; --dry-run first):
//   node scripts/provision-agents.mjs \
//     --workspace /opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/alpha/executions/T1 \
//     --models zai/glm-4.7,zai/glm-5.2 \
//     --token-file /run/secrets/openclaw_gateway_token \
//     --identity /opt/semanggi/volumes/shared/service/semanggios/controller/admin-identity.json
//
// The identity used here must be paired with operator.admin — deliberately a
// DIFFERENT device from the controller's operator.write identity, so the
// controller never inherits admin by sharing a key.
import { readFileSync } from "node:fs";
import { createGatewayRuntime } from "../src/runtime/gateway-ws.mjs";
import { modelKey } from "../src/runtime/agent-registry.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const workspace = arg("workspace");
const models = (arg("models") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
const url = arg("url", process.env.SEMANGGI_GATEWAY_URL ?? "ws://openclaw-gateway:18789");
// Default to the controller's own identity. Leaving this undefined used to
// disable device auth entirely and the script reported "scopes [none]", which
// reads like a pairing problem rather than a missing argument.
const identityPath = arg(
  "identity",
  process.env.SEMANGGI_ADMIN_IDENTITY ?? "/opt/semanggi/volumes/shared/service/semanggios/controller/device-identity.json",
);
const tokenFile = arg("token-file", process.env.SEMANGGI_GATEWAY_TOKEN_FILE);
const token = process.env.SEMANGGI_GATEWAY_TOKEN ?? (tokenFile ? readFileSync(tokenFile, "utf8").trim() : null);
const prefix = arg("prefix", "semanggi");
const dryRun = flag("dry-run");

if (!workspace || models.length === 0 || !token) {
  console.error(
    "usage: provision-agents.mjs --workspace <abs path> --models <provider/model,...> " +
      "[--token-file <path>] [--identity <path>] [--prefix semanggi] [--dry-run]",
  );
  process.exit(2);
}
if (!workspace.startsWith("/")) {
  // The mount contract is that host and container paths are identical; a
  // relative path here would produce an agent that silently works nowhere.
  console.error(`workspace must be an absolute canonical path, got "${workspace}"`);
  process.exit(2);
}

/** Deterministic id so re-running provisioning is idempotent, not duplicating. */
function agentIdFor(workspacePath, provider, model) {
  const leaf = workspacePath.split("/").filter(Boolean).slice(-3).join("-");
  const slug = `${provider}-${model}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${prefix}-${leaf}-${slug}`.replace(/-+/g, "-").slice(0, 63);
}

const runtime = createGatewayRuntime({
  url,
  token,
  identityPath: identityPath ?? null,
  scopes: ["operator.admin"],
  // This script talks to agents.*, never to dispatch.
  resolveAgentByModel: false,
});

const hello = await runtime.connect();
const granted = hello?.auth?.scopes ?? [];
if (!granted.includes("operator.admin")) {
  console.error(
    `this device has scopes [${granted.join(", ") || "none"}] but agents.create needs operator.admin.\n` +
      `Pair an admin device first (scripts/pair-device.mjs writes the request; an operator approves it).`,
  );
  await runtime.close();
  process.exit(1);
}

const existing = (await runtime.request("agents.list", {}))?.agents ?? [];
const have = new Map(existing.map((a) => [`${a.workspace}::${a.model?.primary}`, a.id]));

let created = 0;
for (const full of models) {
  const [provider, ...rest] = full.split("/");
  const model = rest.join("/");
  if (!provider || !model) {
    console.error(`skipping "${full}": expected provider/model`);
    continue;
  }
  const key = `${workspace}::${modelKey(provider, model)}`;
  if (have.has(key)) {
    console.log(`= ${have.get(key)}  already provides ${full} in this workspace`);
    continue;
  }
  const id = agentIdFor(workspace, provider, model);
  if (dryRun) {
    console.log(`+ ${id}  would be created for ${full}`);
    continue;
  }
  try {
    // Measured: agents.create takes {name, workspace, model} and derives the
    // id from the name — passing `id` is rejected as an unexpected property.
    await runtime.request("agents.create", { name: id, workspace, model: full });
    console.log(`+ ${id}  created for ${full}`);
    created += 1;
  } catch (err) {
    console.error(`! ${id}  failed: ${String(err.message).slice(0, 200)}`);
  }
}

console.log(dryRun ? "\ndry run — nothing was changed." : `\ndone. ${created} agent(s) created.`);
await runtime.close();
