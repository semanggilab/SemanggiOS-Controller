// Sekali pakai saat membereskan tiga task tersangkut (D29). Digantikan oleh
// diagnose-queue.mjs — biarkan ini kalau ingin jejaknya, hapus kalau tidak.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.SEMANGGI_DB, { readOnly: true });
console.log("=== projects ===");
for (const p of db.prepare(`SELECT id,name,workspace_path FROM projects`).all())
  console.log(` ${p.id} ${p.name}\n   ws=${p.workspace_path}`);
console.log("\n=== workers ===");
for (const w of db.prepare(`SELECT id,role,agent_ref,project_access,max_concurrent,status FROM workers`).all())
  console.log(` ${w.id} role=${w.role} agent=${w.agent_ref} status=${w.status} max=${w.max_concurrent}\n   access=${w.project_access}`);
