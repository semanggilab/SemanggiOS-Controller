// Kenapa antrean tidak bergerak?
//
// Dijalankan di dalam container controller. Menjawab pertanyaan yang paling
// sering muncul saat sesuatu diam: task mana yang menunggu, menunggu apa, dan
// berapa lama lagi sebelum scheduler melihatnya kembali.
//
//   docker exec -u 1000:1000 <controller> bun scripts/diagnose-queue.mjs
import { openStore } from "../src/db/index.mjs";

const db = await openStore({ driver: process.env.DATABASE_DRIVER ?? "sqlite", uri: process.env.DATABASE_URI ?? process.env.SEMANGGI_DB });
const now = Date.now();

const rows = await db.all(
    `SELECT t.id, t.status, t.wait_reason, t.next_retry_at, t.worker_id,
            t.workspace_path, t.model_policy, p.name AS proj, p.workspace_path AS proj_ws
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status LIKE 'WAIT%' OR t.status = 'BLOCKED'
      ORDER BY t.updated_at DESC`,
  );

if (!rows.length) {
  console.log("Tidak ada task yang menunggu atau terblokir.");
  process.exit(0);
}
await db.close();

console.log(`${rows.length} task menunggu\n`);
for (const r of rows) {
  const retry = r.next_retry_at ? Math.round((r.next_retry_at - now) / 1000) : null;
  console.log(`${r.id}  ${r.status}  (proyek ${r.proj})`);
  console.log(`   model    : ${r.model_policy}`);
  console.log(`   worker   : ${r.worker_id ?? "(belum ditugaskan)"}`);
  // Workspace adalah penyebab tersering yang paling tidak terlihat: agent
  // terikat ke path tertentu, jadi task di path lain tidak menemukan apa pun.
  console.log(`   workspace: ${r.workspace_path ?? `(ikut project: ${r.proj_ws})`}`);
  console.log(`   alasan   : ${String(r.wait_reason ?? "-").slice(0, 140)}`);
  if (retry !== null) {
    console.log(`   backoff  : ${retry > 0 ? `${retry}s lagi` : "sudah lewat"}`);
    if (retry > 60) console.log(`              (PATCH apa pun pada rencananya akan menghapus backoff ini)`);
  }
  console.log();
}
