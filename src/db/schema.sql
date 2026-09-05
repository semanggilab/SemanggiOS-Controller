-- Semanggi Work Controller — schema (POC-4 §4).
--
-- Portability note: types are deliberately narrow (TEXT/INTEGER/REAL) and every
-- structured field is JSON-in-TEXT, so the same DDL maps onto PostgreSQL with
-- only the trigger syntax rewritten. Enforcement that the spec calls normative
-- (append-only EventLog, immutable finalized Execution) lives in the database,
-- not in application code, so a buggy service cannot violate it.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  weight         INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ARCHIVED')),
  workspace_path TEXT NOT NULL,
  -- AgentOS decomposition template for this project's WORK requests (D37).
  -- Not yet synced from AgentOS's own project.json (task #4, still open), so
  -- it lives here as the project's own setting until that sync exists.
  template       TEXT NOT NULL DEFAULT 'software',
  -- How expensive this project's roles think by default, absent a role-level
  -- override or a template default (see brains.mjs levelForProfile). Set once
  -- when the project is set up and changed from Settings → Project — not
  -- picked per WORK request, so every team member sends requests against the
  -- same baseline without having to know or repeat it.
  profile        TEXT NOT NULL DEFAULT 'balanced' CHECK (profile IN ('fast','balanced','quality')),
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id              TEXT PRIMARY KEY,
  role            TEXT NOT NULL,
  agent_ref       TEXT NOT NULL,               -- OpenClaw agent id
  skills          TEXT NOT NULL DEFAULT '[]',
  model_policy    TEXT NOT NULL DEFAULT '{}',
  subagent_policy TEXT NOT NULL DEFAULT '{}',
  project_access  TEXT NOT NULL DEFAULT '[]',
  max_concurrent  INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent >= 1),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  parent_task_id TEXT REFERENCES tasks(id),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  -- P0 Emergency .. P4 Background (POC-4 §5.2).
  priority       INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  quality_class  TEXT NOT NULL DEFAULT 'L2' CHECK (quality_class IN ('L0','L1','L2','L3','L4','L5')),
  status         TEXT NOT NULL,
  wait_reason    TEXT,                          -- detail for WAIT_* statuses
  worker_id      TEXT REFERENCES workers(id),
  session_policy TEXT NOT NULL DEFAULT 'FRESH' CHECK (session_policy IN ('CONTINUE','FORK','FRESH')),
  -- How this task intends to use the workspace. 'write' takes an exclusive
  -- lease; 'read' shares with other readers. Default 'write': a task becomes
  -- shareable only because someone said so.
  workspace_mode TEXT NOT NULL DEFAULT 'write' CHECK (workspace_mode IN ('read','write')),
  model_policy   TEXT NOT NULL DEFAULT '{}',
  approval_level TEXT NOT NULL DEFAULT 'L0' CHECK (approval_level IN ('L0','L1','L2','L3')),
  workspace_path TEXT,                          -- resolved lease target
  -- Instruction carried by a pending revision; consumed when the next execution
  -- row is created, so revision intent survives a controller restart.
  pending_instruction TEXT,
  expedite_until INTEGER,
  next_retry_at  INTEGER,                       -- e.g. quota next_available
  -- D51: berapa kali dispatch task ini sudah gagal karena kuota jendela
  -- pendek. Naik satu tiap parkir-retry; nol saat COMPLETE dan saat revisi —
  -- keberhasilan dan keputusan operator memulai hitungan baru.
  quota_retries  INTEGER NOT NULL DEFAULT 0,
  -- D52: penghitung terpisah untuk penolakan transient (rate limit jendela
  -- panjang, UNAVAILABLE) di jalur late-error. Terpisah dari quota_retries
  -- karena batas dan backoff-nya berbeda; aturan resetnya sama.
  resource_retries INTEGER NOT NULL DEFAULT 0,
  -- Set when the task is deleted. A row is only soft-deleted when immutable
  -- execution history still references it (the executions_no_delete trigger
  -- plus the FK make a hard delete impossible); tasks without executions are
  -- hard-deleted and leave only their event_log entries behind. Either way the
  -- row disappears from every listing once this is set (D54).
  deleted_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- Dependency edges. POC-4 §5.1 step 1 requires a dependency check but §4 does
-- not name the table; modelled explicitly rather than encoded in a JSON blob so
-- the admission query stays relational.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS executions (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  revision_no    INTEGER NOT NULL CHECK (revision_no >= 1),
  session_mode   TEXT NOT NULL CHECK (session_mode IN ('CONTINUE','FORK','FRESH')),
  -- Harness session id (Claude's own session), NOT an OpenClaw session key.
  -- POC-3 E3-E6: `sessions_spawn resumeSessionId` cannot work on the acpx
  -- backend, so CONTINUE/FORK resume through ACP `session/load` at the harness
  -- layer and the control plane is what remembers which session to continue.
  session_ref    TEXT,
  -- Kunci sesi yang DIKIRIM saat dispatch (sessionKeyFor). Untuk revisi
  -- CONTINUE ini kunci komposit `…:s<ref warisan>` — BUKAN session_ref yang
  -- tersimpan — dan event `session.message` membawa kunci ini. Tanpa kolom
  -- ini transkrip tidak bisa mengaitkan pesan ke eksekusi (D48).
  session_key    TEXT,
  runtime_ref    TEXT,                          -- AgentOS dispatch id
  sandbox_ref    TEXT,
  model_provider TEXT,
  model_id       TEXT,
  mode           TEXT,                          -- interactive | batch
  tokens_input   INTEGER NOT NULL DEFAULT 0,
  tokens_output  INTEGER NOT NULL DEFAULT 0,
  -- POC-3 E8 measured 8 fresh input tokens against 92,663 cache reads on a
  -- single batch run. A cost model that counts only input+output is wrong by
  -- two orders of magnitude, so the cache counters are first-class columns.
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
  cost           REAL NOT NULL DEFAULT 0,
  cost_unit      TEXT NOT NULL DEFAULT 'tokens',-- POC-3: subscription plans have no USD unit
  status         TEXT NOT NULL,
  result         TEXT,
  instruction    TEXT NOT NULL DEFAULT '',
  started_at     INTEGER,
  ended_at       INTEGER,
  created_at     INTEGER NOT NULL,
  -- Set when the execution reaches a terminal state; from then on the row is
  -- frozen (POC-4 §4: "Execution lama tetap immutable").
  finalized_at   INTEGER,
  UNIQUE (task_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
-- idx_executions_session_key dibuat oleh migrasi di db/index.mjs: indeks pada
-- kolom yang belum ada akan gagal di basis data warisan (D48).

CREATE TABLE IF NOT EXISTS resources (
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
  quota_policy      TEXT NOT NULL DEFAULT '{}',
  availability      TEXT NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (availability IN ('AVAILABLE','QUOTA_EXHAUSTED','UNAVAILABLE')),
  -- 'metered'      — pay per token, concurrency is the real constraint
  -- 'subscription' — a rolling plan window is the constraint (POC-3: Claude Pro
  --                  reports rateLimitType=five_hour with an absolute resetsAt);
  --                  concurrency_limit is a safety valve, not the quota
  credit_class      TEXT NOT NULL DEFAULT 'metered',
  -- Absolute epoch from the provider, never a locally computed guess.
  next_available_at INTEGER,
  window_kind       TEXT,                        -- e.g. five_hour
  last_quota_signal TEXT,                        -- verbatim provider message, for audit
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

-- Workspace leases are read/write, not plain mutual exclusion.
--
-- The original design took one exclusive lease per path for every dispatch.
-- Combined with one-workspace-per-project (2026-08-21) that serialised an
-- entire project: a documentation task that only reads the tree would block a
-- coding task, and vice versa, for no reason anyone could defend.
--
-- What the lease actually protects is CONCURRENT WRITES to a shared tree. So:
--   write : exclusive. No other lease of any mode may be held.
--   read  : shared. Any number may be held together; blocked only by a writer.
--
-- The primary key therefore includes execution_id, because several readers can
-- legitimately hold the same path at once. `mode` defaults to 'write' on
-- purpose: sharing is something a task opts into, never something it gets by
-- accident.
CREATE TABLE IF NOT EXISTS leases (
  workspace_path TEXT NOT NULL,
  execution_id   TEXT NOT NULL REFERENCES executions(id),
  owner          TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('read','write')),
  acquired_at    INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  heartbeat_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_path, execution_id)
);
CREATE INDEX IF NOT EXISTS idx_leases_path ON leases(workspace_path);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  execution_id TEXT REFERENCES executions(id),
  level        TEXT NOT NULL CHECK (level IN ('L0','L1','L2','L3')),
  question     TEXT NOT NULL,
  options      TEXT NOT NULL DEFAULT '["APPROVE","REJECT","MODIFY","COMMENT"]',
  decision     TEXT CHECK (decision IN ('APPROVE','REJECT','MODIFY','COMMENT')),
  note         TEXT,
  decided_by   TEXT,
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);

-- Append-only audit trail (POC-4 §4, P4-01).
CREATE TABLE IF NOT EXISTS event_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'controller',
  payload      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_subject ON event_log(subject_type, subject_id);

-- --- Normative enforcement -------------------------------------------------

CREATE TRIGGER IF NOT EXISTS event_log_no_update
BEFORE UPDATE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS event_log_no_delete
BEFORE DELETE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is append-only');
END;

-- A finalized execution may not be rewritten, and identity columns may never
-- change even while the execution is live.
CREATE TRIGGER IF NOT EXISTS executions_immutable_after_final
BEFORE UPDATE ON executions
WHEN OLD.finalized_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'execution is finalized and immutable');
END;

CREATE TRIGGER IF NOT EXISTS executions_identity_frozen
BEFORE UPDATE ON executions
WHEN NEW.task_id <> OLD.task_id OR NEW.revision_no <> OLD.revision_no
BEGIN
  SELECT RAISE(ABORT, 'execution identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS executions_no_delete
BEFORE DELETE ON executions
BEGIN
  SELECT RAISE(ABORT, 'execution history is immutable');
END;

-- Operators: who is allowed to act, and under whose name it is recorded.
--
-- Approvals must be attributable to a person (P4-08 stores `decided_by`), and a
-- single shared bearer token cannot do that honestly — everyone becomes the
-- same anonymous caller. So each operator has their own token.
--
-- The token is stored as a SHA-256 hash and never in the clear. A leaked
-- database should not hand over working credentials, and there is no feature
-- that needs to read a token back: authentication only ever compares hashes.
CREATE TABLE IF NOT EXISTS operators (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_sha256  TEXT NOT NULL UNIQUE,
  -- Maps a Slack user to this operator, so a button press in Slack is recorded
  -- against a real person rather than against "the Slack app".
  slack_user_id TEXT UNIQUE,
  role          TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator','admin','readonly')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_operators_slack ON operators(slack_user_id);

-- Apa yang model benar-benar katakan.
--
-- Sampai tabel ini ada, `executions.result` hanya menyimpan stopReason ("stop",
-- "aborted") dan `executions.instruction` menyimpan sisi kita. Artinya halaman
-- percakapan hanya bisa menampilkan separuh percakapan — dan separuh percakapan
-- lebih menyesatkan daripada tidak ada sama sekali, karena ia tampak lengkap.
--
-- Bentuk payload diukur, tidak ditebak (pelajaran D17): `session.message`
-- membawa message.role dan message.content yang berupa STRING untuk giliran
-- pengguna dan ARRAY blok untuk giliran asisten, dengan tipe blok
-- thinking | text | toolCall.
CREATE TABLE IF NOT EXISTS execution_messages (
  execution_id TEXT NOT NULL REFERENCES executions(id),
  -- messageSeq dari gateway: urut per sesi, bukan per eksekusi.
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  -- Teks yang sudah diratakan, untuk ditampilkan.
  content      TEXT NOT NULL DEFAULT '',
  -- Blok mentah (JSON) supaya penalaran dan panggilan tool tidak hilang, tetapi
  -- dibatasi ukurannya: satu giliran bertele-tele tidak boleh membengkakkan DB
  -- yang hidup di NFS.
  blocks       TEXT,
  at           INTEGER NOT NULL,
  PRIMARY KEY (execution_id, seq, role)
);

CREATE INDEX IF NOT EXISTS idx_execution_messages_exec ON execution_messages(execution_id, seq);

-- Brain: kombinasi (provider, model, thinking, effort) yang diberi nama.
--
-- Katalog routing dulu hanya daftar di berkas config. Menjadikannya tabel
-- membuatnya bisa dikonfigurasi operator lewat halaman dan dipetakan ke role
-- AgentOS — dua hal yang tidak mungkin selama ia berupa berkas.
--
-- provider dan model sengaja TIDAK bisa diubah setelah dibuat: agen
-- di-provision per (project, role, brain), jadi mengubahnya akan membuat setiap
-- agen yang sudah ada menunjuk model yang salah tanpa ada yang tahu.
CREATE TABLE IF NOT EXISTS brains (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL DEFAULT '',
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  thinking       TEXT,
  -- guaranteed = level terukur mengubah perilaku, dikirim sebagai `thinking`
  -- preference = diterima lalu diabaikan provider, atau berbahaya dikirim;
  --              TIDAK pernah dikirim, hanya dicatat sebagai niat (D31)
  effort_mode    TEXT NOT NULL DEFAULT 'guaranteed'
                 CHECK (effort_mode IN ('guaranteed','preference')),
  -- Klaim tanpa alasan tercatat tidak bisa ditinjau ulang saat provider berubah.
  effort_evidence TEXT,
  mode           TEXT NOT NULL DEFAULT 'interactive',
  acp_agent      TEXT,
  -- D51: jadwal reset kuota provider milik model ini (dua level). Jendela
  -- PENDek yang masuk kelas "retry in place" (< RETRYABLE_SHORT_WINDOW_MS,
  -- saat ini 10 menit) membuat kegagalan kuota dicoba ulang sampai
  -- QUOTA_RETRY_LIMIT kali sebelum task diblokir; jendela panjang hanya
  -- informasi operator. NULL = belum diketahui (tidak pernah retry in place).
  quota_reset_short_ms INTEGER,
  quota_reset_long_ms  INTEGER,
  level          TEXT NOT NULL DEFAULT 'normal'
                 CHECK (level IN ('low','normal','critical')),
  category       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brains_level ON brains(level, enabled);

-- Pemetaan (template AgentOS × profile × role) -> level, disetel admin.
--
-- Profile (fast/balanced/quality) adalah sumbu eksplisit: default role yang
-- sama boleh berbeda tergantung AgentOS Level project — (software, fast) dan
-- (software, quality) adalah dua kebutuhan yang berbeda. Baris hanya ada
-- untuk sel grid yang sengaja menyimpang dari DEFAULT_ROLE_LEVELS; kosong
-- berarti "ikut default bawaan".
CREATE TABLE IF NOT EXISTS role_levels (
  template    TEXT NOT NULL,
  profile     TEXT NOT NULL CHECK (profile IN ('fast','balanced','quality')),
  role        TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
  actor       TEXT NOT NULL DEFAULT 'operator',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (template, profile, role)
);

-- Pemetaan role -> level MILIK SATU PROJECT (Settings → Project → Edit).
--
-- Terpisah dari role_levels (global, admin-wide) dengan sengaja: begitu
-- operator menyimpan modal Project Role Level, project itu mendapat
-- pemetaannya sendiri yang tidak lagi mengikuti role_levels global bahkan
-- kalau role_levels berubah kemudian. Baris di sini SELALU menang atas
-- role_levels dan atas DEFAULT_ROLE_LEVELS (lihat resolveLevel()).
--
-- Diisi sekaligus sebagai satu snapshot penuh saat modal disimpan (bukan
-- sparse diff), supaya "project punya mapping-nya sendiri" berarti persis
-- itu: representasi lengkap, bukan tambalan atas default yang bisa berubah
-- di belakang layar. Role boleh di luar kosakata template — project nyata
-- kadang mendaftarkan role tambahan.
CREATE TABLE IF NOT EXISTS project_role_levels (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
  actor      TEXT NOT NULL DEFAULT 'operator',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, role)
);

-- Pemetaan (template AgentOS × role × level) -> Brain tertentu, disetel admin.
--
-- Berbeda maksud dari role_levels di atas, dan keduanya memang dibutuhkan:
-- role_levels menjawab "seberapa mahal role ini boleh berpikir", brain_map
-- menjawab "kalau ada beberapa Brain di level itu, yang MANA yang dipakai".
-- Tanpa brain_map, pilihan jatuh ke default grid, lalu kandidat pertama level
-- — benar secara level, tetapi tidak bisa dikendalikan operator.
--
-- Kunci per LEVEL: halamannya grid (template × role × level) dan setiap sel
-- adalah keputusan eksplisit operator untuk level itu. Brain yang
-- klasifikasinya di bawah level sel tetap boleh dipaku — peringatannya
-- (`belowLevel`) ikut di resolusi, bukan penolakan diam-diam.
--
-- Baris hanya ada untuk sel grid yang sengaja dipaku. Kosong berarti "pakai
-- default grid (DEFAULT_BRAIN_MAP), lalu kandidat level", yang tetap jalan.
--
-- ON DELETE tidak dipakai: brains tidak pernah dihapus (hanya di-disable),
-- karena agen sudah terlanjur di-provision atas namanya. Yang bisa terjadi
-- adalah brain_id menunjuk Brain yang dimatikan — itu diperiksa saat resolusi
-- dan diperlakukan sebagai "tidak dipaku", bukan sebagai kegagalan.
CREATE TABLE IF NOT EXISTS brain_map (
  template   TEXT NOT NULL,
  role       TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
  brain_id   TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'operator',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (template, role, level)
);

CREATE INDEX IF NOT EXISTS idx_brain_map_brain ON brain_map(brain_id);

-- Katalog kosakata thinking/reasoning yang benar-benar diukur per model.
--
-- Diseed dari config/thinking-levels.json, bukan diturunkan langsung dari
-- gateway: gateway tidak punya RPC yang menjawab "level apa saja yang didukung
-- model ini" (config.schema.lookup menjawab "path not found" untuk itu), jadi
-- satu-satunya cara mendapatkannya adalah benar-benar mendispatch run pada
-- tiap level dan membaca hasilnya. Itu dikerjakan sesekali lewat skrip probe
-- terpisah, bukan pada tiap muat halaman.
CREATE TABLE IF NOT EXISTS thinking_levels (
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  levels      TEXT NOT NULL,   -- JSON array, urutan dari termurah ke termahal
  effort_mode TEXT NOT NULL DEFAULT 'guaranteed'
              CHECK (effort_mode IN ('guaranteed','preference')),
  evidence    TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

-- Snapshot terakhir dari `models.list` gateway.
--
-- Sama alasannya dengan thinking_levels di atas: memanggil gateway pada
-- setiap render form Brain hanya untuk menampilkan opsi model yang sama
-- adalah kerja yang tidak perlu dan menambah latensi ke satu-satunya panggilan
-- yang benar-benar butuh data segar (tombol "Refresh Models"). Baris di sini
-- selalu ditulis ulang penuh oleh refresh terakhir (bukan diakumulasi), jadi
-- sebuah model yang sudah dilepas dari gateway juga ikut hilang dari daftar.
CREATE TABLE IF NOT EXISTS gateway_models (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,   -- id model dari gateway, mis. "glm-5.2"
  name       TEXT,
  reasoning  INTEGER NOT NULL DEFAULT 0,
  available  INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
