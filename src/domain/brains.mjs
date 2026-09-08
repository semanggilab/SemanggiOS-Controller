// Brain: kombinasi (provider, model, thinking, effortMode) yang diberi nama.
//
// Katalog routing selama ini adalah daftar internal di `config/routing.json`.
// Mengangkatnya jadi konsep bernama membuat dua hal mungkin yang sebelumnya
// tidak: operator bisa mengkonfigurasinya lewat halaman, dan role AgentOS bisa
// dipetakan kepadanya.
//
// KENAPA BRAIN MELEKAT PADA AGEN, BUKAN PADA DISPATCH
//
// Terukur pada gateway 2026.7.1 dengan device ber-scope operator.admin:
//
//   agents.create { model: [...] }  →  at /model: must be string
//   agent { agentId: "…glm-5-1", model: "zai/glm-5.2" }
//                                  →  Model override "zai/glm-5.2" is not
//                                     allowed for agent "semanggi-glm-5-1"
//
// Satu agen membawa tepat satu model, dan gateway menolak menjalankan model di
// luar itu — bahkan untuk admin. Jadi Brain TIDAK bisa dipasangkan ke agen mana
// pun saat dispatch. Pooler memilih agen yang sudah membawa Brain yang tepat;
// ia tidak pernah mengonfigurasi ulang agen (D35).
import { quotaDriverFor } from "./quota-drivers/index.mjs";
/** Level yang menghubungkan profil project dengan kandidat Brain. */
export const Level = Object.freeze({ LOW: "low", NORMAL: "normal", CRITICAL: "critical" });

/**
 * Profil project AgentOS → level default.
 *
 * Ini hanya DEFAULT. Pemetaan per role (§4.0 spec) menimpanya, dan override per
 * task menimpa keduanya — kebutuhan project berubah di tengah jalan, dan
 * konfigurasi global tidak boleh mengunci itu.
 */
export const PROFILE_TO_LEVEL = Object.freeze({
  balanced: Level.NORMAL,
  fast: Level.LOW,
  quality: Level.CRITICAL,
});

export function levelForProfile(profile) {
  return PROFILE_TO_LEVEL[String(profile ?? "").toLowerCase()] ?? Level.NORMAL;
}

/**
 * Pemetaan bawaan (template × AgentOS profile × role) → level.
 *
 * AgentOS Level (fast/balanced/quality) adalah sumbu eksplisit: project
 * (software, fast) dan (software, quality) adalah dua project yang BERBEDA
 * kebutuhannya, jadi default role yang sama boleh berbeda tergantung Level —
 * bukan cuma override admin yang berbeda. `null` = "ikut profil project"
 * (levelForProfile). Seluruh kombinasi ditetapkan eksplisit supaya tidak ada
 * role yang levelnya ditebak saat runtime (spec induk §4.0).
 *
 * Aturan penurunannya (empat golongan role, spec §4.0):
 *   penentu arah  (analyst, architect, strategist)  → selalu critical
 *   produksi      (builder, researcher, writer)     → normal, naik di quality
 *   penilai       (reviewer, learner, analyst riset) → naik satu tingkat
 *   verifikasi    (tester, browser)                 → ikut profil
 */
export const PROFILES = Object.freeze(["fast", "balanced", "quality"]);

export const DEFAULT_ROLE_LEVELS = Object.freeze({
  software: Object.freeze({
    fast: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.NORMAL, reviewer: Level.NORMAL, tester: Level.LOW, learner: Level.NORMAL }),
    balanced: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.NORMAL, reviewer: Level.CRITICAL, tester: Level.NORMAL, learner: Level.CRITICAL }),
    quality: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.CRITICAL, reviewer: Level.CRITICAL, tester: Level.CRITICAL, learner: Level.CRITICAL }),
  }),
  frontend: Object.freeze({
    fast: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.NORMAL, reviewer: Level.NORMAL, tester: Level.LOW, learner: Level.NORMAL, browser: Level.LOW }),
    balanced: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.NORMAL, reviewer: Level.CRITICAL, tester: Level.NORMAL, learner: Level.CRITICAL, browser: Level.NORMAL }),
    quality: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.CRITICAL, reviewer: Level.CRITICAL, tester: Level.CRITICAL, learner: Level.CRITICAL, browser: Level.CRITICAL }),
  }),
  backend: Object.freeze({
    fast: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.NORMAL, reviewer: Level.NORMAL, tester: Level.LOW, learner: Level.NORMAL }),
    balanced: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.NORMAL, reviewer: Level.CRITICAL, tester: Level.NORMAL, learner: Level.CRITICAL }),
    quality: Object.freeze({ analyst: Level.CRITICAL, architect: Level.CRITICAL, builder: Level.CRITICAL, reviewer: Level.CRITICAL, tester: Level.CRITICAL, learner: Level.CRITICAL }),
  }),
  research: Object.freeze({
    fast: Object.freeze({ researcher: Level.NORMAL, writer: Level.NORMAL, reviewer: Level.NORMAL, analyst: Level.NORMAL }),
    balanced: Object.freeze({ researcher: Level.NORMAL, writer: Level.NORMAL, reviewer: Level.CRITICAL, analyst: Level.CRITICAL }),
    quality: Object.freeze({ researcher: Level.CRITICAL, writer: Level.CRITICAL, reviewer: Level.CRITICAL, analyst: Level.CRITICAL }),
  }),
  content: Object.freeze({
    fast: Object.freeze({ strategist: Level.CRITICAL, writer: Level.NORMAL, reviewer: Level.NORMAL, analyst: Level.NORMAL }),
    balanced: Object.freeze({ strategist: Level.CRITICAL, writer: Level.NORMAL, reviewer: Level.CRITICAL, analyst: Level.CRITICAL }),
    quality: Object.freeze({ strategist: Level.CRITICAL, writer: Level.CRITICAL, reviewer: Level.CRITICAL, analyst: Level.CRITICAL }),
  }),
});

/**
 * Daftar role sebuah template, apa pun profilenya.
 *
 * Himpunan role per template identik di semua profile (hanya levelnya yang
 * berbeda), tapi union tetap dihitung supaya menambah role pada satu profile
 * di kemudian hari tidak membuat role itu hilang dari halaman.
 */
export function rolesForTemplate(template) {
  const byProfile = DEFAULT_ROLE_LEVELS[String(template ?? "").toLowerCase()] ?? {};
  const roles = new Set();
  for (const mapping of Object.values(byProfile)) for (const role of Object.keys(mapping)) roles.add(role);
  return [...roles];
}

/**
 * Role yang TIDAK disediakan template AgentOS mana pun.
 *
 * Diperiksa langsung di `workspace-presets.ts`: sepuluh role tersedia
 * (Builder, Reviewer, Tester, Learner, Browser Agent, Research Lead, Archivist,
 * Strategist, Writer, Analyst) dan **tidak ada Architect**. Kata "architect"
 * muncul tepat sekali di seluruh berkas itu — di dalam *deskripsi* Learner pada
 * template backend, bukan sebagai role.
 *
 * Itu bukan kelalaian AgentOS melainkan asumsi templatenya: `docs/architecture.md`
 * yang di-scaffold berjudul "Current shape · Dependencies · Risks" — deskriptif
 * atas yang sudah ada, bukan preskriptif atas yang akan dibangun. Template itu
 * untuk memelihara sistem, bukan merancangnya.
 *
 * Skill Builder bahkan menjauhkannya dari pekerjaan desain secara eksplisit:
 * *"Prefer direct code or artifact changes over speculative planning."*
 *
 * `role` di AgentOS bertipe `string` bebas (bukan union), jadi operator boleh
 * menambahkan Architect sendiri lewat UI dengan preset `worker`. Tabel di atas
 * sudah menyiapkan levelnya supaya begitu role itu ada, ia langsung dirutekan
 * ke Brain critical — kesalahan desain adalah yang paling mahal dibatalkan.
 */
export const ROLES_NOT_IN_AGENTOS = Object.freeze(["architect"]);

/**
 * Level efektif untuk sebuah (template, role, profile, project).
 *
 * Urutan resolusi — yang lebih spesifik menang:
 *   1. override MILIK PROJECT (modal Project Role Level menyimpan snapshot
 *      penuh; begitu disimpan, project itu tidak lagi mengikuti global)
 *   2. override admin global untuk (template, profile, role)
 *   3. default bawaan (template, profile, role) — tabel di atas
 *   4. level profil project (levelForProfile) untuk role yang null
 */
export function resolveLevel({ template, role, profile, overrides = {}, projectOverrides = {} } = {}) {
  const key = String(role ?? "").toLowerCase();
  const fromProject = projectOverrides?.[key];
  if (fromProject) return fromProject;
  const fromOperator = overrides?.[key];
  if (fromOperator) return fromOperator;
  const fromTemplate = DEFAULT_ROLE_LEVELS[String(template ?? "").toLowerCase()]?.[String(profile ?? "").toLowerCase()]?.[key];
  return fromTemplate ?? levelForProfile(profile);
}

const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// POC-6 §5.1: the window-kind vocabulary drivers write and the schema CHECKs.
const SHORT_WINDOW_TYPES = ["rolling", "fixed-time", "token-bucket", "credits"];
const LONG_WINDOW_TYPES = [...SHORT_WINDOW_TYPES, "credits-anniversary"];

export function createBrains(store, { now, shortId }) {
  /** Bentuk yang dipakai routing dan registry agen. */
  const present = (row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider,
    model: row.model,
    thinking: row.thinking,
    effortMode: row.effort_mode,
    effortEvidence: row.effort_evidence,
    mode: row.mode,
    acpAgent: row.acp_agent,
    quotaResetShortMs: row.quota_reset_short_ms ?? null,
    quotaResetLongMs: row.quota_reset_long_ms ?? null,
    quotaTier: row.quota_tier ?? null,
    quotaShortType: row.quota_short_type ?? null,
    quotaLongType: row.quota_long_type ?? null,
    quotaFixedReset: parseFixedReset(row.quota_fixed_reset),
    rpm: row.rpm ?? null,
    rpd: row.rpd ?? null,
    tpm: row.tpm ?? null,
    tpd: row.tpd ?? null,
    contextWindowTokens: row.context_window_tokens ?? null,
    minSandboxes: row.min_sandboxes ?? 0,
    level: row.level,
    enabled: Boolean(row.enabled),
  });

  // quota_fixed_reset is stored as JSON text; a malformed row (hand-edited)
  // presents as null rather than poisoning every brain listing.
  function parseFixedReset(raw) {
    if (raw == null) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  // D51: jadwal reset default mengikuti keluarga provider. Pemanggil yang
  // menyertakan nilai eksplisit menang — operator yang tahu lebih baik dari
  // tabel ini harus bisa menulisnya, dan Brain ber-provider asing (bukan salah
  // satu kunci di bawah) menyimpan null daripada menebak.
  const windowOrNullOrThrow = (v, field, name) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`brain "${name}": ${field} must be a positive number of milliseconds or null`);
    }
    return Math.round(n);
  };

  // POC-6 §5.1 validators for the quota columns beyond durations.
  const tierOrNull = (v, name) => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(s)) throw new Error(`brain "${name}": quotaTier must be a slug-like plan name or null`);
    return s;
  };
  const typeOrNull = (v, allowed, field, name) => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).trim().toLowerCase();
    if (!allowed.includes(s)) throw new Error(`brain "${name}": ${field} must be one of ${allowed.join("|")}`);
    return s;
  };
  const rateOrNull = (v, field, name) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`brain "${name}": ${field} must be a positive integer or null`);
    return n;
  };
  // D80: lantai sandbox harus integer kecil — 0 berarti "tidak pernah dibuat
  // otomatis" dan itu default-nya. Plafon 99 bukan batas fisik gateway,
  // melainkan penolakan angka ketik-salah (999) yang akan membuat keeper
  // melahirkan sebuah armada.
  const minSandboxesOrThrow = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      throw new Error(`brain "${name}": minSandboxes must be an integer between 0 and 99`);
    }
    return n;
  };
  // Accepts the parsed object (API) and stores canonical JSON text (schema).
  const fixedResetOrNull = (v, name) => {
    if (v === null || v === undefined || v === "") return null;
    const obj = typeof v === "string" ? parseFixedReset(v) : v;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error(`brain "${name}": quotaFixedReset must be an object {atHourLocal, timeZone, day?} or null`);
    }
    if (obj.atHourLocal != null && !(Number.isInteger(obj.atHourLocal) && obj.atHourLocal >= 0 && obj.atHourLocal <= 23)) {
      throw new Error(`brain "${name}": quotaFixedReset.atHourLocal must be an hour 0-23`);
    }
    if (obj.day != null && !(Number.isInteger(obj.day) && obj.day >= 0 && obj.day <= 6)) {
      throw new Error(`brain "${name}": quotaFixedReset.day must be 0 (Sun) through 6 (Sat)`);
    }
    if (obj.timeZone != null && typeof obj.timeZone !== "string") {
      throw new Error(`brain "${name}": quotaFixedReset.timeZone must be an IANA zone name`);
    }
    return JSON.stringify(obj);
  };

  const brains = {
    async create({
      name,
      description = "",
      provider,
      model,
      thinking = null,
      // Default `guaranteed`: entri yang belum dikarakterisasi adalah klaim yang
      // harus diuji, bukan alasan menahan parameter (D31).
      effortMode = "guaranteed",
      effortEvidence = null,
      mode = "interactive",
      acpAgent = null,
      quotaResetShortMs,
      quotaResetLongMs,
      quotaTier,
      quotaShortType,
      quotaLongType,
      quotaFixedReset,
      rpm,
      rpd,
      tpm,
      tpd,
      contextWindowTokens,
      minSandboxes = 0,
      level = Level.NORMAL,
      enabled = true,
    }) {
      if (!name) throw new Error("brain needs a name");
      if (!provider || !model) throw new Error("brain needs provider and model");
      if (!["guaranteed", "preference"].includes(effortMode)) {
        throw new Error(`effortMode must be guaranteed or preference, got "${effortMode}"`);
      }
      // Sebuah klaim tanpa alasan tercatat tidak bisa ditinjau ulang saat
      // provider berubah — dan justru itulah yang paling sering terjadi.
      if (effortMode === "preference" && !effortEvidence) {
        throw new Error(`brain "${name}" is marked preference but carries no effortEvidence`);
      }
      if (!Object.values(Level).includes(level)) {
        throw new Error(`level must be one of ${Object.values(Level).join("|")}, got "${level}"`);
      }
      const minSandboxesVal = minSandboxesOrThrow(minSandboxes, name);
      const id = shortId("BRN");
      // POC-6: defaults come from the driver registry — windows, types, tier
      // and rates in one place, so what a new Brain gets and what the D63
      // migration backfilled can never drift apart. Explicit caller values
      // still win (the D51 rule), including per-model rates google cannot
      // express as a flat table.
      const driverDefaults = quotaDriverFor(provider).defaults({ model });
      const short = quotaResetShortMs === undefined ? driverDefaults.shortMs : windowOrNullOrThrow(quotaResetShortMs, "quotaResetShortMs", name);
      const long = quotaResetLongMs === undefined ? driverDefaults.longMs : windowOrNullOrThrow(quotaResetLongMs, "quotaResetLongMs", name);
      const tier = quotaTier === undefined ? driverDefaults.quotaTier : tierOrNull(quotaTier, name);
      const shortType = quotaShortType === undefined ? driverDefaults.shortType : typeOrNull(quotaShortType, SHORT_WINDOW_TYPES, "quotaShortType", name);
      const longType = quotaLongType === undefined ? driverDefaults.longType : typeOrNull(quotaLongType, LONG_WINDOW_TYPES, "quotaLongType", name);
      const fixedReset = quotaFixedReset === undefined
        ? (driverDefaults.fixedReset ? JSON.stringify(driverDefaults.fixedReset) : null)
        : fixedResetOrNull(quotaFixedReset, name);
      const rateOrDriver = (v, dflt, field) => (v === undefined ? dflt : rateOrNull(v, field, name));
      await store.run(
        `INSERT INTO brains (id, name, description, provider, model, thinking, effort_mode,
                             effort_evidence, mode, acp_agent, quota_reset_short_ms, quota_reset_long_ms,
                             quota_tier, quota_short_type, quota_long_type, quota_fixed_reset,
                             rpm, rpd, tpm, tpd, context_window_tokens, min_sandboxes,
                             level, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, slug(name), description, provider, model, thinking, effortMode, effortEvidence,
         mode, acpAgent, short, long,
         tier, shortType, longType, fixedReset,
         rateOrDriver(rpm, driverDefaults.rates.rpm, "rpm"),
         rateOrDriver(rpd, driverDefaults.rates.rpd, "rpd"),
         rateOrDriver(tpm, driverDefaults.rates.tpm, "tpm"),
         rateOrDriver(tpd, driverDefaults.rates.tpd, "tpd"),
         rateOrNull(contextWindowTokens, "contextWindowTokens", name),
         minSandboxesVal,
         level, enabled ? 1 : 0, now(), now()],
      );
      return brains.get(id);
    },

    /** Menerima id maupun nama — operator menyebut nama, kode menyebut id. */
    async get(idOrName) {
      const row =
        (await store.get(`SELECT * FROM brains WHERE id = ?`, [idOrName])) ??
        (await store.get(`SELECT * FROM brains WHERE name = ?`, [slug(idOrName)]));
      return row ? present(row) : null;
    },

    async list({ level, enabledOnly = false } = {}) {
      const where = [];
      const params = [];
      if (level) { where.push("level = ?"); params.push(level); }
      if (enabledOnly) where.push("enabled = 1");
      const rows = await store.all(
        `SELECT * FROM brains ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY level, name`,
        params,
      );
      return rows.map(present);
    },

    async update(id, patch = {}) {
      const before = await brains.get(id);
      if (!before) throw new Error(`unknown brain ${id}`);
      const sets = [];
      const params = [];
      const put = (col, val) => { sets.push(`${col} = ?`); params.push(val); };

      if (patch.description !== undefined) put("description", patch.description);
      if (patch.thinking !== undefined) put("thinking", patch.thinking);
      // D51: jadwal reset boleh berubah saat provider mengubah paketnya —
      // berbeda dari provider/model yang memang beku, jadwal adalah fakta
      // komersial yang bisa berpindah tanpa pindah model. POC-6 memperluas
      // kelas fakta komersial itu: tier, tipe jendela, deskriptor reset
      // jam-tetap, laju, dan context window ikut bisa dipatch operator.
      if (patch.quotaResetShortMs !== undefined) {
        put("quota_reset_short_ms", windowOrNullOrThrow(patch.quotaResetShortMs, "quotaResetShortMs", before.name));
      }
      if (patch.quotaResetLongMs !== undefined) {
        put("quota_reset_long_ms", windowOrNullOrThrow(patch.quotaResetLongMs, "quotaResetLongMs", before.name));
      }
      if (patch.quotaTier !== undefined) put("quota_tier", tierOrNull(patch.quotaTier, before.name));
      if (patch.quotaShortType !== undefined) {
        put("quota_short_type", typeOrNull(patch.quotaShortType, SHORT_WINDOW_TYPES, "quotaShortType", before.name));
      }
      if (patch.quotaLongType !== undefined) {
        put("quota_long_type", typeOrNull(patch.quotaLongType, LONG_WINDOW_TYPES, "quotaLongType", before.name));
      }
      if (patch.quotaFixedReset !== undefined) {
        put("quota_fixed_reset", fixedResetOrNull(patch.quotaFixedReset, before.name));
      }
      for (const [field, column] of [
        ["rpm", "rpm"],
        ["rpd", "rpd"],
        ["tpm", "tpm"],
        ["tpd", "tpd"],
        ["contextWindowTokens", "context_window_tokens"],
      ]) {
        if (patch[field] !== undefined) put(column, rateOrNull(patch[field], field, before.name));
      }
      if (patch.minSandboxes !== undefined) {
        put("min_sandboxes", minSandboxesOrThrow(patch.minSandboxes, before.name));
      }
      if (patch.level !== undefined) {
        if (!Object.values(Level).includes(patch.level)) throw new Error(`invalid level "${patch.level}"`);
        put("level", patch.level);
      }
      if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
      if (patch.effortMode !== undefined) {
        if (!["guaranteed", "preference"].includes(patch.effortMode)) {
          throw new Error(`effortMode must be guaranteed or preference`);
        }
        const evidence = patch.effortEvidence ?? before.effortEvidence;
        if (patch.effortMode === "preference" && !evidence) {
          throw new Error("marking a brain as preference requires effortEvidence");
        }
        put("effort_mode", patch.effortMode);
      }
      if (patch.effortEvidence !== undefined) put("effort_evidence", patch.effortEvidence);

      // Jalur harness ACP: `acpAgent` menyebut agen acpx yang memaku model
      // harness (routing.json "_acp_note"). Ia hanya masuk akal untuk
      // provider claude-code — provider lain dicapai lewat cocok model, jadi
      // acpAgent di sana adalah konfigurasi yang tidak akan pernah dipakai.
      // Provider sendiri tidak bisa diubah (lihat di bawah), maka pemeriksaan
      // ini memakai baris yang ada.
      if (patch.mode !== undefined) {
        if (!["interactive", "acp", "batch"].includes(patch.mode)) {
          throw new Error(`mode must be interactive, acp or batch, got "${patch.mode}"`);
        }
        put("mode", patch.mode);
      }
      if (patch.acpAgent !== undefined) {
        const agent = patch.acpAgent === null ? null : String(patch.acpAgent).trim();
        if (agent) {
          if (before.provider !== "claude-code") {
            throw new Error(`acpAgent only applies to claude-code brains, not provider "${before.provider}"`);
          }
          put("acp_agent", agent);
        } else {
          put("acp_agent", null);
        }
      }

      // Provider dan model TIDAK bisa diubah. Mengubahnya berarti Brain ini
      // menunjuk agen yang berbeda, dan setiap agen yang sudah dibuat untuknya
      // menjadi salah tanpa ada yang tahu. Buat Brain baru.
      if (patch.provider !== undefined || patch.model !== undefined) {
        throw new Error(
          "provider and model are immutable: an agent is provisioned per (project, role, brain), " +
            "so changing them would silently orphan every agent already created for this brain",
        );
      }
      if (!sets.length) return before;
      put("updated_at", now());
      params.push(id);
      await store.run(`UPDATE brains SET ${sets.join(", ")} WHERE id = ?`, params);
      return brains.get(id);
    },

    /**
     * Kandidat untuk sebuah level, yang aktif saja.
     *
     * D64: penyaringan kategori dihapus — jalur dispatch sudah lama tidak
     * mengoper kategori (Brain Map per template×role×level yang memutus),
     * jadi ini murni pool per level. Sejarahnya: versi pertama menulis
     * `category IS NULL OR category = ?` dengan parameter null, dan di SQL
     * `category = NULL` tidak pernah benar — setiap brain berkategori
     * tersaring habis. Kolomnya kini benar-benar tidak ada.
     */
    async candidatesFor({ level }) {
      const rows = await store.all(`SELECT * FROM brains WHERE enabled = 1 AND level = ? ORDER BY name`, [level]);
      return rows.map(present);
    },

    /**
     * Brain untuk satu (provider, model) — dipakai jalur kegagalan kuota
     * (D51) untuk membaca jadwal reset tanpa menunggu sinyal provider.
     * Beberapa Brain bisa berbagi model; yang pertama menang karena jadwal
     * reset milik model, bukan milik pilihan thinking/effort.
     */
    async forModel(provider, model) {
      const row = await store.get(
        `SELECT * FROM brains WHERE provider = ? AND model = ? ORDER BY enabled DESC, name LIMIT 1`,
        [provider, model],
      );
      return row ? present(row) : null;
    },

    /**
     * Menghapus Brain dan pemakuan brain_map yang menunjuknya.
     *
     * Ini kebalikan asumsi lama "brains tidak pernah dihapus, hanya
     * di-disable" (komentar brain_map di schema.sql): provider yang dicabut
     * dari gateway meninggalkan Brain yang tidak akan pernah bisa dipakai
     * lagi, dan menahannya tetap aktif hanya menyembunyikan baris mati di
     * halaman. Sel grid yang memaku Brain ini dikembalikan ke keadaan tidak
     * dipaku — semantik yang sama dengan yang sudah diberikan resolusi pada
     * brain yang hilang — dan sel yang dilepas dilaporkan balik supaya
     * operator tahu grid mana yang kembali ke default.
     *
     * Agen yang pernah di-provision untuknya TIDAK disentuh di sini: ia
     * milik gateway, dan pencabutan provider mencabut agen di sana sebagai
     * tindakan terpisah yang tercatat sendiri.
     */
    async delete(id) {
      const before = await brains.get(id);
      if (!before) throw new Error(`unknown brain ${id}`);
      const clearedMappings = await store.all(
        `SELECT template, role, level FROM brain_map WHERE brain_id = ?`,
        [before.id],
      );
      if (clearedMappings.length) {
        await store.run(`DELETE FROM brain_map WHERE brain_id = ?`, [before.id]);
      }
      await store.run(`DELETE FROM brains WHERE id = ?`, [before.id]);
      return { brain: before, clearedMappings };
    },
  };

  return brains;
}

/**
 * Mengubah katalog routing lama menjadi Brain.
 *
 * Dipakai sekali saat migrasi, dan idempoten supaya bisa dijalankan ulang.
 * Level diturunkan dari `routes`: sebuah entri katalog yang muncul di
 * `routes.<kategori>.critical` adalah Brain level critical.
 */
export function brainsFromRoutingConfig(routing = {}) {
  const catalog = routing.catalog ?? {};
  const levelOf = new Map();
  for (const [category, classes] of Object.entries(routing.routes ?? {})) {
    for (const [routeClass, route] of Object.entries(classes ?? {})) {
      const names = [...(route.preferred ?? []), ...(Array.isArray(route.fallback) ? route.fallback : [])];
      for (const n of names) {
        // Level tertinggi menang: sebuah Brain yang dipakai di jalur critical
        // adalah Brain critical, meski ia juga muncul di jalur normal.
        const rank = { low: 0, normal: 1, critical: 2 };
        const prev = levelOf.get(n);
        if (!prev || rank[routeClass] > rank[prev]) levelOf.set(n, routeClass);
      }
    }
  }

  const out = [];
  for (const [name, entry] of Object.entries(catalog)) {
    if (name.startsWith("_") || !entry || typeof entry !== "object") continue;
    const placed = levelOf.get(name);
    out.push({
      name,
      description: entry.effortEvidence ? `Diukur: ${String(entry.effortEvidence).slice(0, 160)}` : "",
      provider: entry.provider,
      model: entry.model,
      thinking: entry.thinking ?? null,
      effortMode: entry.effortMode ?? "guaranteed",
      effortEvidence: entry.effortEvidence ?? null,
      mode: entry.mode ?? "interactive",
      acpAgent: entry.acpAgent ?? null,
      level: placed ?? Level.NORMAL,
    });
  }
  return out;
}
