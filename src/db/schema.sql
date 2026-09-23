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
  -- POC-12: task intake records why this request is direct work or a visible
  -- parent/child plan. Child tasks remain ordinary tasks; no WorkItem table.
  plan_mode      TEXT NOT NULL DEFAULT 'DIRECT_EXECUTION' CHECK (plan_mode IN ('DIRECT_EXECUTION','LIGHTWEIGHT_PLAN','FULL_WORKPLAN')),
  complexity_score INTEGER NOT NULL DEFAULT 0,
  breakdown_reason TEXT,
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
  -- Aktivitas gateway terakhir yang teramati untuk eksekusi ini (pesan, tool
  -- frame, lifecycle start, atau "masih running" menurut sessions.describe).
  -- Watchdog memarkir berdasarkan kolom ini, bukan created_at: TASK-E2854DB9
  -- (64 menit, 103 pesan SETELAH diparkir) dan TASK-2C56D3A8 (2j48m, 440
  -- pesan setelahnya) sama-sama diparkir di menit ke-30 hanya karena usianya
  -- melewati batas — usia sejak dispatch tidak mengatakan apa-apa tentang
  -- hidup-matinya sebuah run (D71).
  last_event_at  INTEGER,
  -- Set when the execution reaches a terminal state; from then on the row is
  -- frozen (POC-4 §4: "Execution lama tetap immutable").
  finalized_at   INTEGER,
  UNIQUE (task_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
-- idx_executions_session_key dibuat oleh migrasi di db/index.mjs: indeks pada
-- kolom yang belum ada akan gagal di basis data warisan (D48).

-- POC-11: a checkpoint is durable resume evidence, not a second execution.
-- The execution row stays immutable after finalization; checkpoint metadata is
-- appended beside it and the next attempt is still createRevision(CONTINUE).
CREATE TABLE IF NOT EXISTS execution_checkpoints (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  execution_id     TEXT REFERENCES executions(id),
  checkpoint_type  TEXT NOT NULL,
  stop_reason      TEXT,
  objective        TEXT NOT NULL DEFAULT '',
  progress         TEXT NOT NULL DEFAULT '{}',
  workspace_state  TEXT NOT NULL DEFAULT '{}',
  context_summary  TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON execution_checkpoints(task_id, created_at);

CREATE TABLE IF NOT EXISTS resources (
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
  -- POC-10 §10.3: batas agen `sem-chat-*` per (provider, model), TERPISAH dari
  -- concurrency_limit task di atas. Kuota chat dan kuota task harus bisa
  -- disetel independen — chat yang ramai tidak boleh diam-diam memakan slot
  -- task produksi, dan sebaliknya. Default 1, lantai idle 0 (murni on-demand,
  -- tidak ada pre-warm untuk chat).
  chat_concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (chat_concurrency_limit >= 0),
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
  -- D63 (POC-6 §5.1): tipe jendela memberi makna pada dua durasi di atas —
  -- harian google adalah momen jam-tetap (quota_fixed_reset, sadar DST),
  -- groq menggelinding dari konsumsi pertama, cerebras mengisi bucket. Tier,
  -- laju, dan context window membuat Brain catatan jujur atas yang dijual
  -- provider. NULL = belum diketahui; backfill migrasi dan defaults driver
  -- mengisi baris/Brain baru dari satu tabel kebenaran (quota-drivers).
  quota_tier               TEXT, -- kelas paket provider: free|free-trial|lite|pro|…
  quota_short_type         TEXT CHECK (quota_short_type IN ('rolling','fixed-time','token-bucket','credits')),
  quota_long_type          TEXT CHECK (quota_long_type IN ('rolling','fixed-time','token-bucket','credits','credits-anniversary')),
  quota_fixed_reset        TEXT,  -- JSON {atHourLocal, timeZone, day?} untuk tipe fixed-time
  rpm                      INTEGER,
  rpd                      INTEGER,
  tpm                      INTEGER,
  tpd                      INTEGER,
  context_window_tokens    INTEGER,
  -- D80: lantai sandbox hidup untuk Brain ini. 0 (default) = tidak pernah
  -- dibuat otomatis. Keeper dan jalur on-demand admission membuat agen sampai
  -- lantai ini, dibatasi concurrency_limit resource (provider, model) —
  -- batas yang sama yang dipakai admission untuk konkurensi run, supaya
  -- "berapa agen boleh hidup" tidak pernah melebihi "berapa run boleh jalan".
  -- Plafon 99 bukan batas gateway, melainkan penolakan angka ketik-salah.
  min_sandboxes  INTEGER NOT NULL DEFAULT 0 CHECK (min_sandboxes BETWEEN 0 AND 99),
  level          TEXT NOT NULL DEFAULT 'normal'
                 CHECK (level IN ('low','normal','critical')),
  -- D64: `category` dihapus. Jalur dispatch (brainMap.resolve) tidak pernah
  -- mengoper kategori sejak Brain Map per (template, role, level) — lapisan
  -- fallback level tidak lagi menyaring per kategori, dan kolom ini hanya
  -- tersisa sebagai field form yang menyesatkan.
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
-- D68: satu sel memegang DAFTAR Brain terurut (failover peer), bukan satu.
-- Baris = satu anggota pada posisi tertentu; `position` menentukan urutan
-- coba saat dispatch (anggota pertama yang hidup menang, diturunkan ulang
-- pada TIAP percobaan dispatch — tanpa penunjuk tersimpan yang bisa basi).
--
-- Kunci per LEVEL: halamannya grid (template × role × level) dan setiap sel
-- adalah keputusan eksplisit operator untuk level itu. Brain yang
-- klasifikasinya di bawah level sel tetap boleh dipaku — peringatannya
-- (`belowLevel`) ikut di resolusi, bukan penolakan diam-diam.
--
-- Sel tanpa baris memakai default grid (DEFAULT_BRAIN_MAP, satu nama),
-- lalu kandidat level — yang tetap berjalan.
--
-- ON DELETE tidak dipakai: penghapusan brain lewat endpoint yang membersihkan
-- pemakuannya secara eksplisit dan melaporkan sel mana yang kembali ke default.
-- Posisi boleh berlobang setelah penghapusan: urutan dibaca ORDER BY position,
-- dan penulisan ulang sel selalu menomori dari 0.
-- (hapus diam-diam lewat FOREIGN KEY tidak memberi tahu operator apa yang
-- berubah). Resolusi sendiri memperlakukan brain_id yang menunjuk Brain yang
-- sudah tidak ada sama seperti yang dimatikan — "tidak dipaku", bukan gagal.
CREATE TABLE IF NOT EXISTS brain_map (
  template   TEXT NOT NULL,
  role       TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('low','normal','critical')),
  position   INTEGER NOT NULL DEFAULT 0,
  brain_id   TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'operator',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (template, role, level, position)
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
  -- D84: batas per model, dari config.get — models.list tidak membawanya
  -- (diukur live di 2026.8.2). NULL = gateway tidak melaporkannya; itu
  -- jawaban yang berbeda dari nol.
  context_window INTEGER,
  max_tokens     INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

-- --- POC-10: Command Center sebagai chat room umum ---------------------------

-- Satu percakapan operator↔Brain di dalam satu project.
--
-- gateway_session_ref memegang session key gateway untuk semantik CONTINUE
-- (jalur lambat transkrip D48 bergantung padanya); NULL berarti percakanan
-- belum pernah berjalan — dispatch berikutnya FRESH. Ganti Brain men-NULL-kan
-- ref ini: context window milik Brain lama tidak bisa dikloning (batasan
-- gateway yang sama dengan FORK D46), dan operator sudah memutuskan reset itu
-- harus eksplisit (POC-10 §10.2).
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brain_id            TEXT NOT NULL,
  title               TEXT,
  gateway_session_ref TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  actor               TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_active_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_id, last_active_at DESC);

-- Transkrip chat. `seq` ditugaskan per sesi (MAX+1 dalam satu transaksi),
-- bukan dipercayakan pada created_at: jam uji di repo ini sering diam di
-- satu milidetik, dan dua pesan dengan stempel sama adalah urutan yang
-- bergantung pada rencana eksekusi — pola yang sama dengan execution_messages
-- (seq milik sesi, bukan eksekusi).
CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('operator','brain','system')),
  content     TEXT NOT NULL,
  attachments TEXT,
  -- Hanya bermakna untuk role='brain': pesan operator SELALU 'DONE' saat
  -- ditulis. PENDING/RUNNING adalah baris yang dilepas lebih dulu supaya UI
  -- bisa polling (rekomendasi §8 POC-10) alih-alih menahan koneksi HTTP
  -- puluhan detik — masalah yang sama dengan alasan D74 memberi /doc seksi
  -- live. FAILED membawa alasan di `error`.
  status      TEXT NOT NULL DEFAULT 'DONE' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  error       TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, seq);

-- Sandbox chat: satu agen gateway `sem-chat-*` per (project, brain).
--
-- Dikunci per (project, brain) DAN BUKAN per sesi — dua sesi yang memilih
-- pasangan sama berbagi satu agen (masing-masing dengan gateway_session_ref
-- sendiri; percakapan tetap terpisah di gateway). Tanpa reaper: baris hilang
-- hanya saat operator kill manual (Process Manager D78) dan pesan berikutnya
-- memprovisikan ulang — last_used_at informasional, bukan jam penyapu.
-- brain_id sengaja tanpa FK: sesi/baris boleh menunjuk Brain yang sudah
-- dihapus; endpoint pesan yang menolaknya dengan alasan, bukan DB yang
-- meruntuhkan riwayat.
CREATE TABLE IF NOT EXISTS chat_sandboxes (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brain_id     TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, brain_id)
);
