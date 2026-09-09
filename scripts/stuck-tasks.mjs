// Sekali pakai saat membereskan tiga task tersangkut (D29). Digantikan oleh
// diagnose-queue.mjs — biarkan ini kalau ingin jejaknya, hapus kalau tidak.
// Kenapa sebuah task mentok di WAIT_RESOURCE dengan `available: []`?
// Hipotesis: bukan modelnya yang hilang, tapi workspace-nya tidak punya agent.
import { openStore } from "../src/db/index.mjs";

const db = await openStore({ driver: process.env.DATABASE_DRIVER ?? "sqlite", uri: process.env.DATABASE_URI ?? process.env.SEMANGGI_DB });
const rows = await db.all(
    `SELECT t.id, t.status, t.wait_reason, t.workspace_path, t.model_policy,
            p.name AS proj, p.workspace_path AS proj_ws
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status LIKE 'WAIT%'
      ORDER BY t.updated_at DESC LIMIT 10`,
  );

console.log(`task yang sedang menunggu: ${rows.length}\n`);
for (const r of rows) {
  console.log(`${r.id} | ${r.status} | proyek ${r.proj}`);
  console.log(`   model   : ${r.model_policy}`);
  console.log(`   task ws : ${r.workspace_path}`);
  console.log(`   proj ws : ${r.proj_ws}`);
  console.log(`   alasan  : ${String(r.wait_reason ?? "").slice(0, 160)}`);
  console.log();
}
await db.close();
