// Sekali pakai saat membereskan tiga task tersangkut (D29). Digantikan oleh
// diagnose-queue.mjs — biarkan ini kalau ingin jejaknya, hapus kalau tidak.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.SEMANGGI_DB, { readOnly: true });
const now = Date.now();
for (const r of db.prepare(
  `SELECT id,status,wait_reason,next_retry_at,worker_id,workspace_path,updated_at
     FROM tasks WHERE id IN ('TASK-6C8F61E3','TASK-18877228')`).all()) {
  console.log(`${r.id} ${r.status}`);
  console.log(`   worker=${r.worker_id}  ws=${r.workspace_path}`);
  console.log(`   diperbarui : ${new Date(r.updated_at).toISOString()}`);
  console.log(`   next_retry : ${r.next_retry_at ? new Date(r.next_retry_at).toISOString() : "(tidak ada)"}`);
  console.log(`   masih ${r.next_retry_at ? Math.round((r.next_retry_at - now) / 1000) : 0} detik lagi`);
  console.log(`   alasan     : ${String(r.wait_reason ?? "").slice(0, 100)}`);
}
