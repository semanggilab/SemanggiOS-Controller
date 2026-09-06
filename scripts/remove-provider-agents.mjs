// Memungut agen yang modelnya berasal dari provider yang dicabut.
//
// Kebalikan dari reap-agents.mjs: yang itu memungut agen yang workspace-nya
// sudah lenyap; yang ini memungut agen yang MODEL-nya sudah tidak akan pernah
// bisa berjalan lagi karena providernya dicabut dari gateway. Menahannya
// hanya menyembunyikan baris mati di inventory (persis alasan D60 untuk
// penghapusan brain).
//
// Ini OPERATOR tool, bukan runtime controller — sama seperti reap-agents.mjs:
// agents.delete butuh operator.admin, dan controller sengaja tidak membentuk
// ulang armada yang menjalankan pekerjaannya (D14).
//
//   node scripts/remove-provider-agents.mjs --provider aliyuncs \
//     --token-file /run/secrets/openclaw_gateway_token \
//     --identity /opt/.../device-identity.json --dry-run
import { readFileSync } from "node:fs";
import { createGatewayRuntime } from "../src/runtime/gateway-ws.mjs";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const url = arg("url", process.env.SEMANGGI_GATEWAY_URL ?? "ws://openclaw-gateway:18789");
const tokenFile = arg("token-file", process.env.SEMANGGI_GATEWAY_TOKEN_FILE ?? null);
const token = arg("token", tokenFile ? readFileSync(tokenFile, "utf8").trim() : null);
const identityPath = arg("identity", null);
// Nama provider persis seperti di konfigurasi gateway. Pemilihannya ketat:
// hanya agen yang model primernya "provider/..." atau persis "provider" yang
// dipungut — satu salah ketik tidak boleh menghapus armada orang lain.
const provider = arg("provider", null);
const dryRun = flag("dry-run");

if (!token || !provider) {
  console.error("usage: remove-provider-agents.mjs --provider <name> [--token-file <path>] [--identity <path>] [--url <ws://...>] [--dry-run]");
  process.exit(2);
}

const runtime = createGatewayRuntime({
  url,
  token,
  identityPath: identityPath ?? null,
  scopes: ["operator.admin"],
  resolveAgentByModel: false,
});

const hello = await runtime.connect();
const granted = hello?.auth?.scopes ?? [];
if (!granted.includes("operator.admin")) {
  console.error(`this device has [${granted.join(", ") || "none"}]; agents.delete needs operator.admin.`);
  await runtime.close();
  process.exit(1);
}

const agents = (await runtime.request("agents.list", {}))?.agents ?? [];
const belongs = (a) => {
  const primary = String(a.model?.primary ?? "");
  return primary === provider || primary.startsWith(`${provider}/`);
};
const mine = agents.filter(belongs);

console.log(`${agents.length} agen total, ${mine.length} bermodel ${provider}\n`);

let reaped = 0;
for (const a of mine) {
  const id = String(a.id);
  if (dryRun) {
    console.log(`- ${id}  AKAN dipungut (model: ${a.model?.primary})`);
    reaped += 1;
    continue;
  }
  try {
    const r = await runtime.request("agents.delete", { agentId: id });
    console.log(`- ${id}  dipungut, bindings dilepas: ${r?.removedBindings ?? 0} (model: ${a.model?.primary})`);
    reaped += 1;
  } catch (err) {
    console.error(`! ${id}  gagal: ${String(err.message).slice(0, 160)}`);
  }
}

console.log(dryRun ? `\ndry run — ${reaped} agen akan dipungut.` : `\nselesai. ${reaped} agen dipungut.`);
await runtime.close();
