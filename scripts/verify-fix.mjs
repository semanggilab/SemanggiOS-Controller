// Sekali pakai saat membereskan tiga task tersangkut (D29). Digantikan oleh
// diagnose-queue.mjs — biarkan ini kalau ingin jejaknya, hapus kalau tidak.
// Membuktikan perubahan rencana sekarang langsung dievaluasi, bukan menunggu
// backoff habis.
import { readFileSync } from "node:fs";
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const token = readFileSync(process.env.CONTROLLER_TOKEN_FILE, "utf8").trim();
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const t0 = (await api("GET", "/api/work/tasks/TASK-6C8F61E3")).body.task;
console.log(`sebelum : ${t0.status} | retry ${t0.nextRetryAt ? Math.round((t0.nextRetryAt - Date.now()) / 1000) + "s lagi" : "-"}`);
console.log(`          alasan: ${String(t0.waitReason ?? "").slice(0, 90)}`);

// Agent umum terdaftar di …/executions/T1, jadi arahkan ke sana.
const r = await api("PATCH", "/api/work/tasks/TASK-6C8F61E3", {
  workspacePath: "/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/semanggi/executions/T1",
  actor: "satria",
});
const t1 = r.body.task ?? {};
console.log(`\nPATCH ${r.status}`);
console.log(`seketika: ${t1.status} | retry ${t1.nextRetryAt ?? "(dihapus)"} | alasan ${t1.waitReason ?? "(dihapus)"}`);

for (const wait of [5, 10, 20]) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  const t = (await api("GET", "/api/work/tasks/TASK-6C8F61E3")).body.task;
  console.log(`+${wait}s  : ${t.status} ${String(t.waitReason ?? "").slice(0, 70)}`);
  if (["COMPLETE", "RUNNING", "DISPATCHED"].includes(t.status)) break;
}

const q = (await api("GET", "/api/work/queue")).body;
console.log(`\nantrean menunggu: ${q.waiting?.length ?? 0}`);
for (const w of q.waiting ?? []) console.log(`  ${w.id} ${w.status} ${String(w.waitReason ?? "").slice(0, 80)}`);
