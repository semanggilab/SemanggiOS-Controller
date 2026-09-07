// Regression (D48): the live controller.db on the NFS predates session_key.
// The column must converge on boot without losing a single execution row —
// a migration that wedges here strands every running task, and one that drops
// rows rewrites history the append-only event log still remembers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../src/db/index.mjs";

test("a database from before session_key gains the column and keeps its rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semanggi-mig-"));
  const file = join(dir, "controller.db");
  try {
    const db = new DatabaseSync(file);
    // The pre-D48 shape, deliberately minimal: no session_key column.
    db.exec(`
      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        revision_no INTEGER NOT NULL,
        session_mode TEXT NOT NULL,
        session_ref TEXT,
        runtime_ref TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO executions (id, task_id, revision_no, session_mode, session_ref, status, created_at)
       VALUES ('TASK-X#1', 'TASK-X', 1, 'FRESH', 'agent:a:task-x:r1', 'COMPLETE', 1)`,
    ).run();
    db.close();

    const store = openStore({ location: file });
    try {
      const cols = (await store.all(`PRAGMA table_info(executions)`)).map((c) => c.name);
      assert.ok(cols.includes("session_key"), "the migration must add session_key");
      const row = await store.get(`SELECT session_ref, session_key FROM executions WHERE id = 'TASK-X#1'`);
      assert.equal(row.session_ref, "agent:a:task-x:r1", "existing rows must survive the migration");
      assert.equal(row.session_key, null, "old rows start with no sent key, not a guessed one");
    } finally {
      await store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D71: last_event_at migrates onto the live shape (which HAS finalized_at —
// the ultra-minimal fixture above predates it) and the backfill must respect
// the immutability trigger: a finalized row raises ABORT on any UPDATE, so
// the migration would wedge every boot on the real DB if it touched them.
test("last_event_at arrives, backfills only unfinalized rows, and survives triggers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semanggi-mig2-"));
  const file = join(dir, "controller.db");
  try {
    const db = new DatabaseSync(file);
    // The pre-D71 shape: everything except last_event_at.
    db.exec(`
      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        revision_no INTEGER NOT NULL,
        session_mode TEXT NOT NULL,
        session_ref TEXT,
        session_key TEXT,
        runtime_ref TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        finalized_at INTEGER
      );
      CREATE TRIGGER executions_immutable_after_final
      BEFORE UPDATE ON executions
      WHEN OLD.finalized_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'execution is finalized and immutable');
      END;
    `);
    db.prepare(
      `INSERT INTO executions (id, task_id, revision_no, session_mode, status, created_at, finalized_at)
       VALUES ('TASK-A#1', 'TASK-A', 1, 'FRESH', 'COMPLETE', 100, 200)`,
    ).run();
    db.prepare(
      `INSERT INTO executions (id, task_id, revision_no, session_mode, status, created_at)
       VALUES ('TASK-B#1', 'TASK-B', 1, 'FRESH', 'DISPATCHED', 300)`,
    ).run();
    db.close();

    const store = openStore({ location: file });
    try {
      const cols = (await store.all(`PRAGMA table_info(executions)`)).map((c) => c.name);
      assert.ok(cols.includes("last_event_at"), "the migration must add last_event_at");
      const finalRow = await store.get(`SELECT last_event_at, created_at FROM executions WHERE id = 'TASK-A#1'`);
      assert.equal(finalRow.last_event_at, null, "finalized rows are untouched (trigger forbids it)");
      const liveRow = await store.get(`SELECT last_event_at FROM executions WHERE id = 'TASK-B#1'`);
      assert.equal(liveRow.last_event_at, 300, "unfinalized rows are backfilled to created_at");
      // And the watchdog's COALESCE makes the untouched rows behave identically.
      const stalled = await store.all(
        `SELECT id FROM executions WHERE status = 'DISPATCHED' AND COALESCE(last_event_at, created_at) <= 300`,
      );
      assert.equal(stalled.length, 1);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
