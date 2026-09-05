// Membuktikan: daftar agent yang dilihat UI AgentOS itu live dari gateway,
// atau dari file state lokalnya yang sudah basi?
//
// Dijalankan DI DALAM container AgentOS: instance protection menolak bahkan
// permintaan loopback (401), jadi kita harus login lebih dulu seperti operator.
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3000";
const username = "admin";
const password = readFileSync("/run/secrets/agentos_initial_admin_password", "utf8").trim();

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    // Rute mutasi menuntut same-origin; tanpa ini permintaannya ditolak
    // sebelum kredensial sempat diperiksa.
    origin: BASE,
    referer: `${BASE}/login`,
  },
  body: JSON.stringify({ username, password }),
});
console.log("login:", login.status);
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (!cookie) {
  console.log("tidak ada cookie:", (await login.text()).slice(0, 300));
  process.exit(1);
}

for (const path of ["/api/agents", "/api/snapshot"]) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { console.log(path, res.status, text.slice(0, 200)); continue; }

  const arr = json.agents ?? json.snapshot?.agents ?? [];
  console.log(`\n=== ${path} → HTTP ${res.status}, ${arr.length} agent ===`);
  const ids = arr.map((a) => `${a.id} -> ${a.model ?? "?"}`).sort();
  console.log(ids.join("\n"));
  const semanggi = ids.filter((s) => /^sem/.test(s));
  console.log(`\nagent semanggi terlihat: ${semanggi.length}`);
  if (path === "/api/agents") break;
}
