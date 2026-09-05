// Sekali pakai saat membereskan tiga task tersangkut (D29). Digantikan oleh
// diagnose-queue.mjs — biarkan ini kalau ingin jejaknya, hapus kalau tidak.
// Membereskan tiga task yang tersangkut — lewat API, bukan lewat SQL.
//
// Setiap perubahan di sini menghasilkan baris di event_log dengan actor yang
// bernama. Menyunting tabel langsung akan memperbaiki gejalanya dan sekaligus
// membuat jejak auditnya berbohong, dan jejak itu satu-satunya alasan kita bisa
// menjawab "kenapa task ini begini" enam minggu lagi.
import { readFileSync } from "node:fs";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const token = readFileSync(process.env.CONTROLLER_TOKEN_FILE, "utf8").trim();
const ACTOR = "satria";

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const show = async (id, label) => {
  const { body } = await api("GET", `/api/work/tasks/${id}`);
  const t = body.task ?? {};
  console.log(`   ${label}: ${t.status}  worker=${t.workerId ?? "-"}  ws=${t.workspacePath ?? "(ikut project)"}`);
  if (t.waitReason) console.log(`            alasan: ${String(t.waitReason).slice(0, 110)}`);
  return t;
};

// --- 1. TASK-6C8F61E3: terdampar di workspace per-task tanpa agent ---------
console.log("TASK-6C8F61E3 — workspace per-task tanpa agent");
await show("TASK-6C8F61E3", "sebelum");
let r = await api("PATCH", "/api/work/tasks/TASK-6C8F61E3", { workspacePath: null, actor: ACTOR });
console.log(`   PATCH ${r.status}${r.body.error ? " " + r.body.error : ""}`);
await show("TASK-6C8F61E3", "sesudah");

// --- 2. TASK-18877228: worker tanpa akses project -------------------------
console.log("\nTASK-18877228 — worker tanpa akses project");
await show("TASK-18877228", "sebelum");
// WRK-09387984 memegang akses ke PRJ-1DA35D38; workspace project itu sendiri
// (…/workspaces/semanggi) tidak punya agent, jadi arahkan ke …/executions/T1
// tempat kelima agent umum terdaftar.
r = await api("PATCH", "/api/work/tasks/TASK-18877228", {
  workerId: "WRK-09387984",
  workspacePath: "/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/semanggi/executions/T1",
  actor: ACTOR,
});
console.log(`   PATCH ${r.status}${r.body.error ? " " + r.body.error : ""}`);
await show("TASK-18877228", "sesudah");

// --- 3. TASK-41ABFDE6: sisa probe Slack lama ------------------------------
console.log("\nTASK-41ABFDE6 — sisa probe, tidak ada yang perlu diselamatkan");
await show("TASK-41ABFDE6", "sebelum");
r = await api("POST", "/api/work/tasks/TASK-41ABFDE6/cancel", { actor: ACTOR, note: "sisa probe Slack" });
console.log(`   cancel ${r.status}${r.body.error ? " " + r.body.error : ""}`);
await show("TASK-41ABFDE6", "sesudah");

// --- dorong scheduler lalu lihat hasilnya ---------------------------------
console.log("\nmenunggu scheduler…");
await new Promise((r) => setTimeout(r, 20000));
const q = await api("GET", "/api/work/queue");
console.log(`\nsisa yang menunggu: ${q.body.waiting?.length ?? "?"}`);
for (const w of q.body.waiting ?? []) {
  console.log(`  ${w.id} ${w.status} ${String(w.waitReason ?? "").slice(0, 90)}`);
}
