#!/usr/bin/env node
// Keeps a device pairing request alive while an operator approves it.
//
// A pending request lives for 5 minutes (PAIRING_PENDING_TTL_MS in the OpenClaw
// source) and is refreshed on each connect attempt. A one-shot connect
// therefore creates a request that expires before anyone can act on it — which
// is exactly what happened the first time: `openclaw devices approve` reported
// "unknown requestId" because the request had already been pruned.
//
// So this retries on a short interval, prints the requestId every time, and
// exits as soon as the gateway accepts the connection.
//
// Usage (inside a container on the overlay network, or anywhere that can reach
// the gateway):
//   SEMANGGI_GATEWAY_TOKEN=... node scripts/pair-device.mjs \
//     --url ws://openclaw-gateway:18789 \
//     --identity /opt/semanggi/volumes/shared/service/semanggios/controller/device-identity.json
import { createGatewayRuntime } from "../src/runtime/gateway-ws.mjs";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const url = arg("url", process.env.SEMANGGI_GATEWAY_URL ?? "ws://openclaw-gateway:18789");
const identityPath = arg(
  "identity",
  process.env.SEMANGGI_DEVICE_IDENTITY ?? "/opt/semanggi/volumes/shared/service/semanggios/controller/device-identity.json",
);
const tokenFile = arg("token-file", process.env.SEMANGGI_GATEWAY_TOKEN_FILE);
const token = process.env.SEMANGGI_GATEWAY_TOKEN ?? (tokenFile ? readFileSync(tokenFile, "utf8").trim() : null);
const intervalMs = Number(arg("interval", "20")) * 1000;
const deadlineMs = Number(arg("timeout", "600")) * 1000;

if (!token) {
  console.error("no gateway token: set SEMANGGI_GATEWAY_TOKEN or --token-file");
  process.exit(2);
}

const started = Date.now();
let announced = null;

console.log(`pairing against ${url}`);
console.log(`identity: ${identityPath}\n`);

while (Date.now() - started < deadlineMs) {
  const runtime = createGatewayRuntime({ url, token, identityPath });
  const health = await runtime.health();
  await runtime.close();

  if (health.ok) {
    console.log(`\n✓ paired. protocol ${health.protocol}, dispatch method "${health.dispatchMethod}".`);
    console.log("the controller can dispatch now.");
    process.exit(0);
  }

  const detail = String(health.error ?? "");
  const requestId = detail.match(/"requestId"\s*:\s*"([^"]+)"/)?.[1];

  if (!requestId) {
    // Not a pairing problem — surface it rather than retrying blindly.
    console.error(`\n✗ ${detail.slice(0, 300)}`);
    process.exit(1);
  }

  if (requestId !== announced) {
    announced = requestId;
    console.log("pending approval — run this on the gateway node:\n");
    console.log(`  gw=$(docker ps -q --filter 'label=com.docker.swarm.service.name=semanggi_openclaw-gateway' | head -1)`);
    console.log(`  tok=$(docker exec "$gw" cat /run/secrets/openclaw_gateway_token)`);
    console.log(`  docker exec "$gw" openclaw devices approve ${requestId} --token "$tok"\n`);
  }
  process.stdout.write(`  …waiting (request ${requestId.slice(0, 8)}, refreshed ${new Date().toISOString().slice(11, 19)})\n`);
  await new Promise((r) => setTimeout(r, intervalMs));
}

console.error(`\n✗ no approval within ${deadlineMs / 1000}s. The request expires 5 minutes after the last attempt.`);
process.exit(1);
