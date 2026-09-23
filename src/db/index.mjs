// Storage adapter.
//
// The controller talks to this interface only, never to a driver directly. The
// interface is async even though the SQLite driver is synchronous: that is the
// whole point of choosing SQLite first (POC-4 §3 allows "PostgreSQL atau SQLite
// untuk lab"). Swapping in Postgres later must not require touching call sites.
//
// Placeholders are `?` positional. The Postgres driver, when written, rewrites
// them to $1..$n in one place instead of every query being dialect-specific.
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { quotaDriverFor } from "../domain/quota-drivers/index.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { withStartupRetry } from "../runtime/startup-retry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, "schema.sql"), "utf8");

class SqliteStore {
  #db;
  #inTx = false;

  constructor(location) {
    this.#db = new Database(location);
    this.#db.exec("PRAGMA foreign_keys = ON");
    // WAL keeps the single writer from blocking readers; harmless in-memory.
    if (location !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Schema changes that `CREATE TABLE IF NOT EXISTS` cannot express.
   *
   * An existing database keeps its original table definition, so a widened
   * schema silently does nothing on any deployment that already ran — which is
   * every deployment that matters. Each step below is idempotent and checks the
   * live shape rather than a version counter, so a half-applied upgrade
   * converges instead of wedging.
   */
  #migrate() {
    const cols = (table) => this.#db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

    // Read/write leases: several readers may hold one path, so the key had to
    // grow and a `mode` column had to appear. Old rows are all writers, which
    // is what they were in effect.
    const leaseCols = cols("leases");
    if (leaseCols.length > 0 && !leaseCols.includes("mode")) {
      this.#db.exec(`
        ALTER TABLE leases RENAME TO leases_legacy;
        CREATE TABLE leases (
          workspace_path TEXT NOT NULL,
          execution_id   TEXT NOT NULL REFERENCES executions(id),
          owner          TEXT NOT NULL,
          mode           TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('read','write')),
          acquired_at    INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL,
          heartbeat_at   INTEGER NOT NULL,
          PRIMARY KEY (workspace_path, execution_id)
        );
        INSERT INTO leases (workspace_path, execution_id, owner, mode, acquired_at, expires_at, heartbeat_at)
          SELECT workspace_path, execution_id, owner, 'write', acquired_at, expires_at, heartbeat_at
            FROM leases_legacy;
        DROP TABLE leases_legacy;
        CREATE INDEX IF NOT EXISTS idx_leases_path ON leases(workspace_path);
      `);
    }

    // How a task intends to use its workspace. Defaults to 'write' so nothing
    // becomes shared without someone asking for it.
    const taskCols = cols("tasks");
    if (taskCols.length > 0 && !taskCols.includes("workspace_mode")) {
      this.#db.exec(
        `ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'write'`,
      );
    }
    if (taskCols.length > 0 && !taskCols.includes("plan_mode")) {
      this.#db.exec(`ALTER TABLE tasks ADD COLUMN plan_mode TEXT NOT NULL DEFAULT 'DIRECT_EXECUTION'`);
    }
    if (taskCols.length > 0 && !taskCols.includes("complexity_score")) {
      this.#db.exec(`ALTER TABLE tasks ADD COLUMN complexity_score INTEGER NOT NULL DEFAULT 0`);
    }
    if (taskCols.length > 0 && !taskCols.includes("breakdown_reason")) {
      this.#db.exec(`ALTER TABLE tasks ADD COLUMN breakdown_reason TEXT`);
    }

    // D48: the session key dispatch ACTUALLY SENT. A CONTINUE revision reuses
    // a composite key derived from its inherited ref (`…:s<ref>`), which is
    // not what session_ref stores — so session.message events (which carry
    // the sent key) could never be matched to their execution, and whole
    // task transcripts recorded nothing but the operator's own instruction
    // (TASK-E28D15F3/TASK-BFA56024). Nullable: rows from before this column
    // simply fall back to the old session_ref correlation.
    const executionCols = cols("executions");
    if (executionCols.length > 0 && !executionCols.includes("session_key")) {
      this.#db.exec(`ALTER TABLE executions ADD COLUMN session_key TEXT`);
    }
    // Created here, not in schema.sql: an index on a column a legacy database
    // does not have yet would fail before the ALTER above gets to add it.
    if (executionCols.length > 0) {
      this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_session_key ON executions(session_key)`);
    }

    // D51: jadwal reset kuota dua level menjadi milik Brain. Backfill dari
    // keluarga provider — jendela per-menit+harian untuk google, 5
    // jam+mingguan untuk sisanya — supaya kebijakan retry bisa memutuskan
    // sebelum sinyal provider pertama tiba. Brain yang dibuat setelah migrasi
    // mendapat nilai yang sama dari create() (brains.mjs), jadi dua jalan ini
    // tidak boleh berbeda pendapat.
    const brainCols2 = cols("brains");
    if (brainCols2.length > 0 && !brainCols2.includes("quota_reset_short_ms")) {
      this.#db.exec(`ALTER TABLE brains ADD COLUMN quota_reset_short_ms INTEGER`);
      this.#db.exec(`ALTER TABLE brains ADD COLUMN quota_reset_long_ms INTEGER`);
      this.#db.exec(`
        UPDATE brains SET
          quota_reset_short_ms = CASE provider
            WHEN 'google' THEN 60000 WHEN 'groq' THEN 60000 WHEN 'cerebras' THEN 60000
            ELSE 18000000 END,
          quota_reset_long_ms  = CASE provider
            WHEN 'google' THEN 86400000 WHEN 'groq' THEN 86400000 WHEN 'cerebras' THEN 86400000
            ELSE 604800000 END
      `);
    }

    // D80: lantai sandbox per Brain (0 = tidak pernah dibuat otomatis). Baris
    // lama mendapat 0 lewat DEFAULT — itu perilaku yang benar, bukan backfill:
    // armada yang tidak pernah meminta provisioning otomatis tidak boleh
    // mulai menumbuhkan agen hanya karena kolomnya muncul.
    const brainColsMin = cols("brains");
    if (brainColsMin.length > 0 && !brainColsMin.includes("min_sandboxes")) {
      this.#db.exec(`ALTER TABLE brains ADD COLUMN min_sandboxes INTEGER NOT NULL DEFAULT 0`);
    }

    // D84: contextWindow/maxTokens per model di cache gateway. Tidak ada
    // backfill: nilainya hanya diketahui gateway, dan "Refresh Models"
    // berikutnya yang mengisinya. NULL sampai saat itu adalah jawaban jujur —
    // menebaknya di sini akan menampilkan angka yang tidak pernah diukur.
    const gwCols = cols("gateway_models");
    if (gwCols.length > 0 && !gwCols.includes("context_window")) {
      this.#db.exec(`ALTER TABLE gateway_models ADD COLUMN context_window INTEGER`);
      this.#db.exec(`ALTER TABLE gateway_models ADD COLUMN max_tokens INTEGER`);
    }

    // D51: penghitung retry kuota jendela pendek. Default 0: task warisan
    // belum pernah gagal karenanya.
    if (taskCols.length > 0 && !taskCols.includes("quota_retries")) {
      this.#db.exec(`ALTER TABLE tasks ADD COLUMN quota_retries INTEGER NOT NULL DEFAULT 0`);
    }

    // D63 (POC-6 §5.1): window TYPES, tier, laju, dan context window menemani
    // dua durasi D51. Backfill lewat registry driver — tabel kebenaran yang
    // sama dipakai brains.create() — supaya migrasi dan create tidak pernah
    // berbeda pendapat (aturan D51: dua pintu, satu tabel). Durasi ms yang
    // sudah di-patch operator TIDAK disentuh; yang diisi hanya kolom baru.
    const brainCols3 = cols("brains");
    const POC6_BRAIN_COLS = [
      ["quota_tier", "TEXT"],
      ["quota_short_type", "TEXT"],
      ["quota_long_type", "TEXT"],
      ["quota_fixed_reset", "TEXT"],
      ["rpm", "INTEGER"],
      ["rpd", "INTEGER"],
      ["tpm", "INTEGER"],
      ["tpd", "INTEGER"],
      ["context_window_tokens", "INTEGER"],
    ];
    if (brainCols3.length > 0 && !brainCols3.includes("quota_tier")) {
      for (const [name, type] of POC6_BRAIN_COLS) {
        this.#db.exec(`ALTER TABLE brains ADD COLUMN ${name} ${type}`);
      }
      const rows = this.#db.prepare(`SELECT id, provider, model FROM brains`).all();
      const backfill = this.#db.prepare(`
        UPDATE brains SET quota_tier = ?, quota_short_type = ?, quota_long_type = ?, quota_fixed_reset = ?,
                          rpm = ?, rpd = ?, tpm = ?, tpd = ?
          WHERE id = ?`);
      for (const row of rows) {
        const d = quotaDriverFor(row.provider).defaults({ model: row.model });
        backfill.run(
          d.quotaTier,
          d.shortType,
          d.longType,
          d.fixedReset ? JSON.stringify(d.fixedReset) : null,
          d.rates.rpm,
          d.rates.rpd,
          d.rates.tpm,
          d.rates.tpd,
          row.id,
        );
      }
    }

    // D64: `brains.category` dihapus. Sejak Brain Map per (template, role,
    // level) jalur dispatch tidak pernah mengoper kategori ke resolve —
    // penyaringan kategori di fallback sudah mati di jalur hidup, dan kolomnya
    // hanya menambah field form yang tampak berarti padahal tidak. DROP,
    // bukan diabaikan: kolom hantu mengundang dipakai lagi lupa-lupa ingat.
    if (brainCols3.length > 0 && brainCols3.includes("category")) {
      this.#db.exec(`ALTER TABLE brains DROP COLUMN category`);
    }

    // D88: jangkar mingguan claude-code diukur operator (2026-09-09) — reset
    // Senin 02:00 WIB. Backfill hanya baris yang masih memegang default lama
    // (descriptor NULL); suntingan tangan operator (descriptor terisi) tidak
    // disentuh, aturan yang sama dengan backfill D63. Idempoten: baris yang
    // sudah terisi tidak pernah lolos WHERE lagi.
    if (brainCols3.length === 0 || brainCols3.includes("quota_tier")) {
      const d88 = quotaDriverFor("claude-code").defaults();
      this.#db
        .prepare(`UPDATE brains SET quota_fixed_reset = ? WHERE provider = 'claude-code' AND quota_fixed_reset IS NULL`)
        .run(d88.fixedReset ? JSON.stringify(d88.fixedReset) : null);
    }

    // D52: penghitung terpisah untuk penolakan transient (rate limit jendela
    // panjang, UNAVAILABLE) di jalur late-error — batas dan backoff-nya
    // berbeda dari quota_retries.
    if (taskCols.length > 0 && !taskCols.includes("resource_retries")) {
      this.#db.exec(`ALTER TABLE tasks ADD COLUMN resource_retries INTEGER NOT NULL DEFAULT 0`);
    }

    // POC-10 §10.3: batas agen chat per (provider, model), kolomnya sendiri
    // supaya kuota chat dan kuota task bisa disetel independen. Tanpa backfill:
    // DEFAULT 1 adalah kebijakan baru yang benar untuk baris lama — operator
    // belum pernah menyatakan batas chat apa pun, dan 1 adalah nilai paling
    // konservatif yang tidak membuka armada diam-diam.
    const resourceCols = cols("resources");
    if (resourceCols.length > 0 && !resourceCols.includes("chat_concurrency_limit")) {
      this.#db.exec(`ALTER TABLE resources ADD COLUMN chat_concurrency_limit INTEGER NOT NULL DEFAULT 1`);
    }
    // Tiga tabel chat (sessions/messages/sandboxes) dibuat oleh SCHEMA di atas
    // (CREATE TABLE IF NOT EXISTS) — tabel baru tidak butuh ALTER; catatan ini
    // hanya penanda bahwa mereka memang bagian migrasi POC-10 yang sama.
    // T3: kolom pengiriman pesan brain — tabel chat_messages dibuat di T1 tanpa
    // ini, dan DB yang sudah memakai T1 butuh ALTER (pola migrasi sama dengan
    // resource_retries di atas).
    const chatMessageCols = cols("chat_messages");
    if (chatMessageCols.length > 0) {
      if (!chatMessageCols.includes("status")) {
        this.#db.exec(`ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'DONE'`);
      }
      if (!chatMessageCols.includes("error")) {
        this.#db.exec(`ALTER TABLE chat_messages ADD COLUMN error TEXT`);
      }
    }

    // D54: penanda hapus-lunak. Nullable: baris lama tidak pernah dihapus,
    // jadi NULL berarti "hidup" tanpa perlu backfill.
    if (taskCols.length > 0 && !taskCols.includes("deleted_at")) {
      this.#db.exec(`ALTER TABLE tasks ADD COLUMN deleted_at INTEGER`);
    }

    // D71: aktivitas terakhir yang teramati. Watchdog lama memakai created_at
    // sebagai jam, jadi run sehat sepanjang 64 menit (TASK-E2854DB9) diparkir
    // di menit ke-30 sambil terus streaming. Backfill created_at: baris warisan
    // langsung dinilai dari usianya — konservatif, dan baris yang memang mati
    // tidak lolos dari pemeriksaan hanya karena migrasi baru berjalan.
    // Baris FINAL sengaja tidak disentuh: trigger imutabilitas meng-abort
    // UPDATE apa pun padahal, dan NULL pada baris final tidak pernah dibaca
    // (stalled() memfilter finalized_at IS NULL; COALESCE menutup sisanya).
    // Fixture warisan yang bahkan belum punya finalized_at sama saja
    // dilewati backfill-nya — semantik identik lewat COALESCE.
    const executionCols2 = cols("executions");
    if (executionCols2.length > 0 && !executionCols2.includes("last_event_at")) {
      this.#db.exec(`ALTER TABLE executions ADD COLUMN last_event_at INTEGER`);
      if (executionCols2.includes("finalized_at")) {
        this.#db.exec(
          `UPDATE executions SET last_event_at = created_at
             WHERE last_event_at IS NULL AND finalized_at IS NULL`,
        );
      }
    }

    // D71 koreksi jangkar: baris warisan yang di-backfill dari created_at
    // padahal transkripnya mencatat aktivitas lebih belakangan (TASK-E2854DB9:
    // created 20:17, pesan terakhir 21:21 — 64 menit yang membuat jam backfill
    // berbohong 1 jam). Pesan terakhir ADALAH aktivitas terakhir yang teramati;
    // konvergen dan idempoten — setelah diterapkan, kondisinya tidak pernah
    // benar lagi untuk baris yang sama. BENTUK TABEL DIBACA ULANG: blok ALTER
    // di atas menambah kolom pada boot ini, dan cols yang di-cache sebelumnya
    // masih belum mengetahuinya.
    if (
      cols("executions").includes("last_event_at") &&
      cols("executions").includes("finalized_at") &&
      cols("execution_messages").includes("at")
    ) {
      this.#db.exec(`
        UPDATE executions SET last_event_at = (
          SELECT MAX(at) FROM execution_messages m WHERE m.execution_id = executions.id
        )
        WHERE finalized_at IS NULL
          AND (SELECT MAX(at) FROM execution_messages m WHERE m.execution_id = executions.id)
              > COALESCE(last_event_at, 0)
      `);
    }

    // D37: template and profile move from a per-request parameter (typed into
    // the Control page every time) to a per-project setting (typed once, in
    // Settings → Project). Existing rows get the same defaults the code
    // already fell back to before this column existed, so a WORK request
    // made the day this migration runs behaves identically to the day before.
    const projectCols = cols("projects");
    if (projectCols.length > 0 && !projectCols.includes("template")) {
      this.#db.exec(`ALTER TABLE projects ADD COLUMN template TEXT NOT NULL DEFAULT 'software'`);
    }
    if (projectCols.length > 0 && !projectCols.includes("profile")) {
      this.#db.exec(`ALTER TABLE projects ADD COLUMN profile TEXT NOT NULL DEFAULT 'balanced'`);
    }

    // The profile axis is a first-class dimension of role_levels (spec §4.0):
    // (software, fast) and (software, quality) are different needs, so the key
    // is (template, profile, role). A database from the brief axis-removal era
    // (2026-09-04, one deployed build) carries the two-column shape; its rows
    // expand to all three profiles with the same value — the operator's intent
    // survives, and the grid becomes fully addressable. Databases that already
    // have the three-profile shape (the pre-removal era) already match the
    // schema and are left untouched.
    const roleLevelCols = cols("role_levels");
    if (roleLevelCols.length > 0 && !roleLevelCols.includes("profile")) {
      this.#db.exec(`
        ALTER TABLE role_levels RENAME TO role_levels_legacy;
        CREATE TABLE role_levels (
          template    TEXT NOT NULL,
          profile     TEXT NOT NULL CHECK (profile IN ('fast','balanced','quality')),
          role        TEXT NOT NULL,
          level       TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
          actor       TEXT NOT NULL DEFAULT 'operator',
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (template, profile, role)
        );
        INSERT INTO role_levels (template, profile, role, level, actor, updated_at)
          SELECT template, p.profile, role, level, actor, updated_at
            FROM role_levels_legacy, (SELECT 'fast' AS profile UNION ALL SELECT 'balanced' UNION ALL SELECT 'quality') p;
        DROP TABLE role_levels_legacy;
      `);
    }

    // brain_map grew a level axis: one pin per (template, role, level) grid
    // cell. Legacy pins were level-less and protected by "ignore pins below
    // the requirement" — so a pin carries into exactly the cells it could
    // legally serve: every level at or below the brain's own classification.
    // Pins whose brain row is gone were already dead at resolve time; they do
    // not survive the reshape.
    const brainMapCols = cols("brain_map");
    if (brainMapCols.length > 0 && !brainMapCols.includes("level")) {
      this.#db.exec(`
        ALTER TABLE brain_map RENAME TO brain_map_legacy;
        CREATE TABLE brain_map (
          template   TEXT NOT NULL,
          role       TEXT NOT NULL,
          level      TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
          brain_id   TEXT NOT NULL,
          actor      TEXT NOT NULL DEFAULT 'operator',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (template, role, level)
        );
        INSERT INTO brain_map (template, role, level, brain_id, actor, updated_at)
          SELECT m.template, m.role, l.level, m.brain_id, m.actor, m.updated_at
            FROM brain_map_legacy m
            JOIN brains b ON b.id = m.brain_id
            JOIN (SELECT 'low' AS level, 0 AS rank UNION ALL SELECT 'normal', 1 UNION ALL SELECT 'critical', 2) l
              ON l.rank <= (CASE b.level WHEN 'low' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END);
        DROP TABLE brain_map_legacy;
        CREATE INDEX IF NOT EXISTS idx_brain_map_brain ON brain_map(brain_id);
      `);
    }

    // D68: sel brain_map memegang daftar Brain terurut (failover peer).
    // Pemaku tunggal era sebelumnya menjadi list satu-anggota pada posisi 0 —
    // semantik lama ("sel ini memakai Brain X") bertahan persis, hanya
    // bentuknya yang mendapat sumbu urutan.
    const brainMapCols2 = cols("brain_map");
    if (brainMapCols2.length > 0 && !brainMapCols2.includes("position")) {
      this.#db.exec(`
        ALTER TABLE brain_map RENAME TO brain_map_legacy;
        CREATE TABLE brain_map (
          template   TEXT NOT NULL,
          role       TEXT NOT NULL,
          level      TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
          position   INTEGER NOT NULL DEFAULT 0,
          brain_id   TEXT NOT NULL,
          actor      TEXT NOT NULL DEFAULT 'operator',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (template, role, level, position)
        );
        INSERT INTO brain_map (template, role, level, position, brain_id, actor, updated_at)
          SELECT template, role, level, 0, brain_id, actor, updated_at FROM brain_map_legacy;
        DROP TABLE brain_map_legacy;
        CREATE INDEX IF NOT EXISTS idx_brain_map_brain ON brain_map(brain_id);
      `);
    }
  }

  async all(sql, params = []) {
    return this.#db.prepare(sql).all(...params);
  }

  async get(sql, params = []) {
    return this.#db.prepare(sql).get(...params) ?? null;
  }

  async run(sql, params = []) {
    return this.#db.prepare(sql).run(...params);
  }

  // Single-writer controller (replicas: 1), so a plain serialized transaction is
  // enough; nesting is folded into the outer transaction rather than using
  // savepoints, because no call path needs partial rollback.
  async tx(fn) {
    if (this.#inTx) return fn(this);
    this.#db.exec("BEGIN IMMEDIATE");
    this.#inTx = true;
    try {
      const out = await fn(this);
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    } finally {
      this.#inTx = false;
    }
  }

  async close() {
    this.#db.close();
  }
}

export function postgresSql(sql) {
  let index = 0;
  let out = "";
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      index += 1;
      out += `$${index}`;
    } else {
      out += ch;
    }
  }
  return out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO").replace(
    /(INSERT INTO execution_messages[\s\S]*?VALUES\s*\([^)]*\))/i,
    "$1 ON CONFLICT (execution_id, seq, role) DO NOTHING",
  );
}

export function postgresSchema() {
  return SCHEMA
    .replace(/^PRAGMA[^;]+;\s*/gm, "")
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")
    // SQLite INTEGER is a signed 64-bit value. PostgreSQL INTEGER is only
    // 32-bit, which cannot hold epoch milliseconds, token totals, or other
    // counters already present in controller.db. Preserve SQLite semantics.
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/CREATE TRIGGER IF NOT EXISTS[\s\S]*?\nEND;\s*/g, "");
}

class PostgresStore {
  #sql;
  #tx = new AsyncLocalStorage();

  constructor(uri) {
    this.#sql = new SQL(uri, {
      max: Number(process.env.DATABASE_POOL_MAX ?? 20),
      idleTimeout: Number(process.env.DATABASE_IDLE_TIMEOUT_SECONDS ?? 30),
      connectionTimeout: Number(process.env.DATABASE_CONNECT_TIMEOUT_SECONDS ?? 10),
      // pgproxy commonly means PgBouncer. Unnamed statements work in every
      // transaction-pooling configuration, including versions before 1.21.
      prepare: process.env.DATABASE_PREPARE === "1",
    });
  }

  async init() {
    await this.#sql.unsafe(postgresSchema()).simple();
    await this.#sql.unsafe("CREATE INDEX IF NOT EXISTS idx_executions_session_key ON executions(session_key)");
    // POC-10 §10.3 (padanan migrasi SqliteStore): basis data warisan tidak
    // di-ALTER oleh CREATE TABLE IF NOT EXISTS, jadi kolom batas chat
    // ditambahkan eksplisit di sini — idempoten lewat IF NOT EXISTS.
    await this.#sql.unsafe(
      "ALTER TABLE resources ADD COLUMN IF NOT EXISTS chat_concurrency_limit BIGINT NOT NULL DEFAULT 1",
    );
    // T3: kolom pengiriman pesan brain (padanan ALTER sqlite di atas).
    await this.#sql.unsafe(
      "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'DONE'",
    );
    await this.#sql.unsafe("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS error TEXT");
    await this.#sql.unsafe("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_mode TEXT NOT NULL DEFAULT 'DIRECT_EXECUTION'");
    await this.#sql.unsafe("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS complexity_score BIGINT NOT NULL DEFAULT 0");
    await this.#sql.unsafe("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS breakdown_reason TEXT");
    await this.#sql.unsafe(`
      CREATE OR REPLACE FUNCTION semanggi_reject_event_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'event_log is append-only'; END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION semanggi_guard_execution_update() RETURNS trigger AS $$
      BEGIN
        IF OLD.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'execution is finalized and immutable'; END IF;
        IF NEW.task_id <> OLD.task_id OR NEW.revision_no <> OLD.revision_no THEN
          RAISE EXCEPTION 'execution identity is immutable';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION semanggi_reject_execution_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'execution history is immutable'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS event_log_no_update ON event_log;
      CREATE TRIGGER event_log_no_update BEFORE UPDATE ON event_log FOR EACH ROW EXECUTE FUNCTION semanggi_reject_event_mutation();
      DROP TRIGGER IF EXISTS event_log_no_delete ON event_log;
      CREATE TRIGGER event_log_no_delete BEFORE DELETE ON event_log FOR EACH ROW EXECUTE FUNCTION semanggi_reject_event_mutation();
      DROP TRIGGER IF EXISTS executions_immutable_after_final ON executions;
      CREATE TRIGGER executions_immutable_after_final BEFORE UPDATE ON executions FOR EACH ROW EXECUTE FUNCTION semanggi_guard_execution_update();
      DROP TRIGGER IF EXISTS executions_no_delete ON executions;
      CREATE TRIGGER executions_no_delete BEFORE DELETE ON executions FOR EACH ROW EXECUTE FUNCTION semanggi_reject_execution_delete();
    `).simple();
    return this;
  }

  #client() {
    return this.#tx.getStore() ?? this.#sql;
  }

  async all(sql, params = []) {
    return await this.#client().unsafe(postgresSql(sql), params);
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] ?? null;
  }

  async run(sql, params = []) {
    const rows = await this.#client().unsafe(postgresSql(sql), params);
    return { changes: rows.count ?? rows.length ?? 0, rows };
  }

  async tx(fn) {
    if (this.#tx.getStore()) return fn(this);
    return this.#sql.begin(async (tx) => {
      return this.#tx.run(tx, () => fn(this));
    });
  }

  async advisoryLock(key, fn) {
    return this.tx(async () => {
      const row = await this.get("SELECT pg_try_advisory_xact_lock(hashtext(?)) AS acquired", [key]);
      if (!row?.acquired) return null;
      return fn();
    });
  }

  async close() {
    await this.#sql.close({ timeout: 5 });
  }
}

export function openStore({ driver = "sqlite", uri = null, location = ":memory:" } = {}) {
  const selected = String(driver ?? "sqlite").toLowerCase();
  if (selected === "sqlite") return new SqliteStore(uri || location);
  if (selected === "postgres" || selected === "postgresql") {
    if (!uri) throw new Error("DATABASE_URI is required when DATABASE_DRIVER=postgres");
    return withStartupRetry("postgres", async () => {
      const store = new PostgresStore(uri);
      try {
        return await store.init();
      } catch (error) {
        await store.close().catch(() => {});
        throw error;
      }
    });
  }
  throw new Error(`unsupported DATABASE_DRIVER "${driver}"; expected sqlite or postgres`);
}
