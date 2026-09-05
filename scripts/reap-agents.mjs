// Memungut agen yang workspace-nya sudah tidak ada.
//
// Kenapa perlu: di gateway ini workspace adalah properti AGEN, bukan properti
// dispatch. Setiap kali sebuah task butuh workspace tersendiri, satu agen baru
// dibuat untuknya — dan tidak ada yang pernah membereskannya. Terhitung di
// cluster: 9 agen Semanggi, 4 di antaranya milik task yang sudah lama selesai.
//
// Sempat diharapkan `workspaceDir` per dispatch di 2026.7.1 akan menghapus
// kebutuhan ini. Ternyata tidak — parameter itu tidak ada di permukaan RPC mana
// pun (D34). Yang 7.1 berikan justru `agents.delete`, yang membuat sisi lain
// dari masalah bisa ditangani: bukan mencegah agen lahir, melainkan memungutnya
// setelah mati.
//
// Ini OPERATOR tool, bukan runtime controller — sama alasannya dengan
// provision-agents.mjs: menghapus agen butuh operator.admin, dan controller
// sengaja hanya memegang operator.write supaya ia bisa menjalankan pekerjaan
// tetapi tidak bisa membentuk ulang armada yang menjalankannya (D14).
//
//   node scripts/reap-agents.mjs --token-file /run/secrets/openclaw_gateway_token \
//     --identity /opt/.../admin-identity.json --prefix sem --dry-run
import { existsSync } from "node:fs";
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
// Hanya agen dengan prefiks ini yang boleh dipungut. Tanpa pagar itu satu salah
// ketik bisa menghapus agen milik orang lain — termasuk yang dibuat lewat
// AgentOS, yang tidak ada urusannya dengan kita.
const prefix = arg("prefix", "sem");
const dryRun = flag("dry-run");
const keep = new Set((arg("keep", "") || "").split(",").filter(Boolean));

if (!token) {
  console.error("usage: reap-agents.mjs --token-file <path> [--identity <path>] [--prefix sem] [--keep a,b] [--dry-run]");
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
const mine = agents.filter((a) => String(a.id ?? "").startsWith(`${prefix}-`));

console.log(`${agents.length} agen total, ${mine.length} berprefiks "${prefix}-"\n`);

let reaped = 0;
for (const a of mine) {
  const id = String(a.id);
  if (keep.has(id)) {
    console.log(`= ${id}  dipertahankan (--keep)`);
    continue;
  }
  const ws = a.workspace ?? null;
  if (!ws) {
    console.log(`? ${id}  tidak punya workspace — dilewati, bukan urusan skrip ini`);
    continue;
  }
  // Satu-satunya kriteria: workspace-nya sudah tidak ada di disk. Agen yang
  // workspace-nya masih ada mungkin masih dipakai, dan menebak "sudah selesai"
  // dari nama atau umur akan salah pada task yang berjalan lama.
  if (existsSync(ws)) {
    console.log(`= ${id}  workspace masih ada`);
    continue;
  }
  if (dryRun) {
    console.log(`- ${id}  AKAN dipungut (workspace hilang: ${ws})`);
    reaped += 1;
    continue;
  }
  try {
    const r = await runtime.request("agents.delete", { agentId: id });
    console.log(`- ${id}  dipungut (bindings dilepas: ${r?.removedBindings ?? 0})`);
    reaped += 1;
  } catch (err) {
    console.error(`! ${id}  gagal: ${String(err.message).slice(0, 160)}`);
  }
}

console.log(dryRun ? `\ndry run — ${reaped} agen akan dipungut.` : `\nselesai. ${reaped} agen dipungut.`);
await runtime.close();
