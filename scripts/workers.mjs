// Sekali pakai saat membereskan tiga task tersangkut (D29). Digantikan oleh
// diagnose-queue.mjs — biarkan ini kalau ingin jejaknya, hapus kalau tidak.
import { openStore } from "../src/db/index.mjs";
const db = await openStore({ driver: process.env.DATABASE_DRIVER ?? "sqlite", uri: process.env.DATABASE_URI ?? process.env.SEMANGGI_DB });
console.log("=== projects ===");
for (const p of await db.all(`SELECT id,name,workspace_path FROM projects`))
  console.log(` ${p.id} ${p.name}\n   ws=${p.workspace_path}`);
console.log("\n=== workers ===");
for (const w of await db.all(`SELECT id,role,agent_ref,project_access,max_concurrent,status FROM workers`))
  console.log(` ${w.id} role=${w.role} agent=${w.agent_ref} status=${w.status} max=${w.max_concurrent}\n   access=${w.project_access}`);
await db.close();
