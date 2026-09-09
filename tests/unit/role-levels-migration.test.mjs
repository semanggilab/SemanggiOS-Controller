// Regression for deployment-shaped breakages, found while applying the
// profile-axis work (2026-09-04): one deployed build shipped role_levels keyed
// by (template, role) only, and brain_map keyed by (template, role). The live
// controller.db on the NFS carries those shapes, so the shapes must converge
// on boot — otherwise the routes' `INSERT … ON CONFLICT` fails to prepare at
// all (the D36 class of a route that cannot succeed on any input).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as DatabaseSync } from "bun:sqlite";
import { openStore } from "../../src/db/index.mjs";

// The two-column era, copied from the deployed database — not from schema.sql,
// which only ever describes the present.
function shapeLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE role_levels (
      template   TEXT NOT NULL,
      role       TEXT NOT NULL,
      level      TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
      actor      TEXT NOT NULL DEFAULT 'operator',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (template, role)
    );
    CREATE TABLE brains (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
      provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, effort_mode TEXT,
      effort_evidence TEXT, mode TEXT NOT NULL DEFAULT 'interactive', acp_agent TEXT,
      level TEXT NOT NULL DEFAULT 'normal', category TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE brain_map (
      template   TEXT NOT NULL,
      role       TEXT NOT NULL,
      brain_id   TEXT NOT NULL,
      actor      TEXT NOT NULL DEFAULT 'operator',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (template, role)
    );
  `);
  const rl = db.prepare(
    `INSERT INTO role_levels (template, role, level, actor, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  rl.run("software", "builder", "normal", "service", 1);
  const br = db.prepare(
    `INSERT INTO brains (id, name, provider, model, level, category, enabled, created_at, updated_at)
     VALUES (?, ?, 'zai', 'glm-5.2', ?, 'architecture', 1, 1, 1)`,
  );
  br.run("BRN-CRIT", "mahal", "critical");
  br.run("BRN-NORM", "sedang", "normal");
  const bm = db.prepare(
    `INSERT INTO brain_map (template, role, brain_id, actor, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  bm.run("software", "architect", "BRN-CRIT", "operator", 1);
  // Pin lama yang klasifikasinya di bawah beberapa level: hanya level yang
  // legal baginya yang boleh mewarisinya.
  bm.run("software", "builder", "BRN-NORM", "operator", 1);
  db.close();
}

test("two-column role_levels expands to (template, profile, role); legacy brain_map pins fan out per level", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semanggi-role-levels-"));
  const file = join(dir, "controller.db");
  try {
    shapeLegacyDb(file);
    const store = await openStore({ location: file });

    const columns = (await store.all(`PRAGMA table_info(role_levels)`)).map((c) => c.name);
    assert.ok(columns.includes("profile"), "profile column must exist");

    const rows = (await store.all(`SELECT template, profile, role, level FROM role_levels ORDER BY role, profile`)).map(
      (r) => ({ ...r }),
    );
    // Nilai operator bertahan, diperluas ke ketiga profile — grid menjadi
    // addressable penuh tanpa kehilangan satu keputusan pun.
    assert.deepEqual(
      rows.map((r) => `${r.role}/${r.profile}=${r.level}`),
      ["builder/balanced=normal", "builder/fast=normal", "builder/quality=normal"],
    );

    // Upsert bentuk baru harus bisa diprepare — inilah yang gagal pada bentuk lama.
    await store.run(
      `INSERT INTO role_levels (template, profile, role, level, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(template, profile, role) DO UPDATE SET level = excluded.level,
         actor = excluded.actor, updated_at = excluded.updated_at`,
      ["software", "balanced", "builder", "critical", "test", 5],
    );
    const after = await store.get(
      `SELECT level FROM role_levels WHERE template = ? AND profile = ? AND role = ?`,
      ["software", "balanced", "builder"],
    );
    assert.equal(after.level, "critical");

    // Pin lama architect (Brain critical) diwarisi ke SEMUA sel level.
    const archPins = await store.all(
      `SELECT level, brain_id FROM brain_map WHERE template = 'software' AND role = 'architect' ORDER BY level`,
    );
    assert.deepEqual(archPins.map((p) => p.level), ["critical", "low", "normal"]);
    // Pin lama builder (Brain normal) hanya ke sel low dan normal — sel
    // critical tadinya diabaikan sebagai penurunan, dan tetap tidak diwarisi.
    const builderPins = await store.all(
      `SELECT level, brain_id FROM brain_map WHERE template = 'software' AND role = 'builder' ORDER BY level`,
    );
    assert.deepEqual(builderPins.map((p) => p.level), ["low", "normal"]);

    await store.close();

    // Idempotence: a second boot against the same file must be a no-op, or a
    // rolling restart mid-migration would wedge on a half-reshaped table.
    const store2 = await openStore({ location: file });
    const again = (
      await store2.all(`SELECT template, profile, role, level FROM role_levels ORDER BY role, profile`)
    ).map((r) => ({ ...r }));
    assert.equal(again.length, 3);
    const pins = await store2.all(`SELECT COUNT(*) AS n FROM brain_map`);
    assert.equal(pins[0].n, 5);
    await store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
