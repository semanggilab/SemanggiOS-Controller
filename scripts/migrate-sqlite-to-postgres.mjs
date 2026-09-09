// One-way cutover tool. Run while every controller replica is stopped: copying
// a moving queue would produce a PostgreSQL snapshot that never existed.
import { openStore } from "../src/db/index.mjs";
import { SQL } from "bun";
import { readFileSync } from "node:fs";

const sqliteUri = process.env.SQLITE_URI ?? process.env.SEMANGGI_DB;
let postgresUri = process.env.DATABASE_URI;
if (postgresUri && process.env.DATABASE_PASSWORD_FILE) {
  const parsed = new URL(postgresUri);
  parsed.password = readFileSync(process.env.DATABASE_PASSWORD_FILE, "utf8").trim();
  postgresUri = parsed.toString();
}
if (!sqliteUri) throw new Error("SQLITE_URI (or SEMANGGI_DB) is required");
if (!postgresUri?.startsWith("postgres")) throw new Error("DATABASE_URI must be a PostgreSQL URI");

// Explicit recovery switch for a failed first cutover that created only an
// incompatible/partial schema. Never enabled by the normal migration path.
if (process.env.MIGRATION_RECREATE_SCHEMA === "1") {
  const bootstrap = new SQL(postgresUri, { max: 1, prepare: false });
  try {
    await bootstrap.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public").simple();
  } finally {
    await bootstrap.close();
  }
}

const source = await openStore({ driver: "sqlite", uri: sqliteUri });
const target = await openStore({ driver: "postgres", uri: postgresUri });

const TABLES = [
  "projects", "workers", "brains", "resources", "thinking_levels",
  "gateway_models", "operators", "tasks", "task_dependencies", "executions",
  "leases", "approvals", "execution_messages", "role_levels",
  "project_role_levels", "brain_map", "event_log",
];

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const sourceColumns = async (table) =>
  (await source.all(`PRAGMA table_info(${quote(table)})`)).map((row) => row.name);
const targetColumns = async (table) =>
  (await target.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position",
    [table],
  )).map((row) => row.column_name);

async function insertRows(db, table, columns, rows) {
  if (rows.length === 0) return;
  const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
  for (const row of rows) await db.run(sql, columns.map((column) => row[column]));
}

try {
  const existing = {};
  for (const table of TABLES) {
    existing[table] = Number((await target.get(`SELECT COUNT(*) AS n FROM ${quote(table)}`))?.n ?? 0);
  }
  const occupied = Object.entries(existing).filter(([, count]) => count > 0);
  if (occupied.length > 0 && process.env.MIGRATION_ALLOW_NONEMPTY !== "1") {
    throw new Error(`PostgreSQL target is not empty: ${occupied.map(([t, n]) => `${t}=${n}`).join(", ")}`);
  }

  const expected = {};
  await target.tx(async () => {
    for (const table of TABLES) {
      const srcColumns = await sourceColumns(table);
      const dstColumns = new Set(await targetColumns(table));
      const columns = srcColumns.filter((column) => dstColumns.has(column));
      let rows = await source.all(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`);

      // A self-referencing parent must exist before its child. SQLite may
      // return tasks in any physical order, so make the dependency explicit.
      if (table === "tasks") {
        const remaining = [...rows];
        const ordered = [];
        const emitted = new Set();
        while (remaining.length > 0) {
          const ready = remaining.filter((row) => !row.parent_task_id || emitted.has(row.parent_task_id));
          if (ready.length === 0) throw new Error("tasks contain a parent cycle or missing parent");
          for (const row of ready) {
            ordered.push(row);
            emitted.add(row.id);
            remaining.splice(remaining.indexOf(row), 1);
          }
        }
        rows = ordered;
      }

      expected[table] = rows.length;
      await insertRows(target, table, columns, rows);
      console.log(`${table}: copied ${rows.length}`);
    }
    await target.run("SELECT setval(pg_get_serial_sequence('event_log','seq'), COALESCE((SELECT MAX(seq) FROM event_log), 1), EXISTS(SELECT 1 FROM event_log))");
  });

  const mismatches = [];
  for (const table of TABLES) {
    const actual = Number((await target.get(`SELECT COUNT(*) AS n FROM ${quote(table)}`))?.n ?? 0);
    if (actual !== expected[table]) mismatches.push(`${table}: expected ${expected[table]}, got ${actual}`);
  }
  if (mismatches.length > 0) throw new Error(`migration verification failed: ${mismatches.join("; ")}`);
  console.log(`migration verified: ${TABLES.length} tables match`);
} finally {
  await Promise.allSettled([source.close(), target.close()]);
}
