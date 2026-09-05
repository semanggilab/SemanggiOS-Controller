// Brain Map: pemetaan (template AgentOS × role × level) → Brain tertentu.
//
// KENAPA INI TERPISAH DARI role_levels
//
// Keduanya menjawab pertanyaan yang berbeda dan sama-sama perlu:
//
//   role_levels  "seberapa mahal role ini boleh berpikir?"   → low|normal|critical
//   brain_map    "di level itu, Brain yang MANA?"            → satu Brain bernama
//
// Tanpa brain_map, pilihan jatuh ke kandidat pertama pada level tersebut. Itu
// tidak salah — levelnya tetap dihormati — tetapi operator tidak bisa
// mengendalikannya, dan urutan kandidat berasal dari berkas routing yang hanya
// bisa diubah lewat deploy. Halaman Brain Map ada supaya keputusan itu bisa
// dipindahkan ke orang yang menjalankan projectnya.
//
// KENAPA KUNCINYA PER LEVEL, BUKAN PER ROLE SAJA
//
// Dulu satu pemaku (template, role) berlaku untuk semua level, dan satu aturan
// melindunginya: pemaku di bawah level kebutuhan diabaikan, karena memakainya
// adalah penurunan diam-diam (P4-03). Sekarang halamannya grid
// (template × role × level): operator memilih Brain UNTUK sel level itu —
// keputusan eksplisit, bukan default yang bocor. Maka aturannya berubah bentuk:
// pemaku SELALU dipakai, tetapi Brain yang klasifikasinya di bawah level sel
// ditandai `belowLevel` di resolusi dan halamanannya — peringatan terlihat,
// pilihan tetap milik operator. Menolaknya akan memalsukan grid: sel yang
// diisi operator lalu diam-diam tidak berjalan (kelas kesalahan `stale` D32).

import { Level } from "./brains.mjs";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Urutan kekuatan level. Dipakai untuk laporan `belowLevel` — Brain yang
 * klasifikasinya di bawah level sel — bukan lagi untuk menolak pemaku.
 */
const RANK = Object.freeze({ [Level.LOW]: 0, [Level.NORMAL]: 1, [Level.CRITICAL]: 2 });

/**
 * Default pemaku per (template, role, level) → NAMA Brain (tersimpan slug).
 *
 * Nilainya ditetapkan operator 2026-09-04 dan menjadi isi awal grid Brain Map.
 * Ini lapisan kedua dari tiga: pemaku operator (tabel) > default ini >
 * kandidat pertama level (katalog routing). Menonaktifkan sebuah Brain
 * menonaktifkan default-nya juga — default tidak boleh menghidupkan kembali
 * sesuatu yang operator matikan.
 */
export const DEFAULT_BRAIN_MAP = Object.freeze({
  software: Object.freeze({
    analyst: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    architect: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    builder: Object.freeze({ [Level.LOW]: "glm-5-1-on", [Level.NORMAL]: "glm-5-1-on", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    tester: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    learner: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
  frontend: Object.freeze({
    analyst: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    architect: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    builder: Object.freeze({ [Level.LOW]: "glm-5-1-on", [Level.NORMAL]: "glm-5-1-on", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    tester: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    learner: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    browser: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-1-on" }),
  }),
  backend: Object.freeze({
    analyst: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    architect: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    builder: Object.freeze({ [Level.LOW]: "glm-5-1-on", [Level.NORMAL]: "glm-5-1-on", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    tester: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    learner: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
  research: Object.freeze({
    researcher: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
    writer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
    analyst: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
  }),
  content: Object.freeze({
    strategist: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    writer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
    analyst: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
  }),
});

export function createBrainMap(store, { now } = {}) {
  const api = {
    /** Semua pemaku, apa adanya. */
    async list({ template } = {}) {
      const rows = template
        ? await store.all(`SELECT * FROM brain_map WHERE template = ? ORDER BY role, level`, [norm(template)])
        : await store.all(`SELECT * FROM brain_map ORDER BY template, role, level`);
      return rows.map((r) => ({
        template: r.template,
        role: r.role,
        level: r.level,
        brainId: r.brain_id,
        actor: r.actor,
        updatedAt: r.updated_at,
      }));
    },

    async get(template, role, level) {
      const row = await store.get(`SELECT * FROM brain_map WHERE template = ? AND role = ? AND level = ?`, [
        norm(template),
        norm(role),
        norm(level),
      ]);
      return row
        ? {
            template: row.template,
            role: row.role,
            level: row.level,
            brainId: row.brain_id,
            actor: row.actor,
            updatedAt: row.updated_at,
          }
        : null;
    },

    /**
     * Paku sebuah (template, role, level) ke sebuah Brain.
     *
     * `brainId` harus sudah ada dan aktif: memaku ke Brain yang dimatikan
     * menghasilkan konfigurasi yang tampak benar di halaman dan tidak pernah
     * terpilih saat dispatch — kelas kesalahan yang sama dengan agen
     * `config-only` di D32, dan sama sulitnya dilihat.
     */
    async set({ template, role, level, brainId, actor = "operator" }, { brains } = {}) {
      const t = norm(template);
      const r = norm(role);
      const l = norm(level);
      if (!t || !r || !l || !brainId) throw new Error("template, role, level and brainId are required");
      if (!(l in RANK)) throw new Error(`invalid level "${level}"`);
      if (brains) {
        const brain = await brains.get(brainId);
        if (!brain) throw new Error(`unknown brain "${brainId}"`);
        if (!brain.enabled) {
          throw new Error(
            `brain "${brain.name}" is disabled; pinning it would produce a mapping that never runs`,
          );
        }
        brainId = brain.id;
      }
      await store.run(
        `INSERT INTO brain_map (template, role, level, brain_id, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(template, role, level) DO UPDATE SET brain_id = excluded.brain_id,
           actor = excluded.actor, updated_at = excluded.updated_at`,
        [t, r, l, brainId, actor, now()],
      );
      return api.get(t, r, l);
    },

    /** Lepas pemaku. Sel kembali ke default grid, lalu kandidat level. */
    async clear({ template, role, level }) {
      await store.run(`DELETE FROM brain_map WHERE template = ? AND role = ? AND level = ?`, [
        norm(template),
        norm(role),
        norm(level),
      ]);
      return { template: norm(template), role: norm(role), level: norm(level), brainId: null };
    },

    /**
     * Brain efektif untuk sebuah (template, role, level).
     *
     * @returns {{brain, source, reason, belowLevel}} `source` salah satu dari:
     *   `pinned`      operator memaku sel grid ini
     *   `default`     belum dipaku; default grid (DEFAULT_BRAIN_MAP)
     *   `level`       tidak dipaku dan tanpa default; kandidat pertama level
     *   `unresolved`  tidak ada kandidat sama sekali — task akan WAIT_RESOURCE
     *
     * `belowLevel` menandai Brain yang klasifikasinya di bawah level sel.
     * Dengan kunci per level, memilih Brain demikian adalah keputusan eksplisit
     * operator — jadi ia dipakai, dan peringatannya ikut bersamanya.
     */
    async resolve({ template, role, level, brains, category = null } = {}) {
      const l = norm(level);
      let rejected = null;

      const pinned = await api.get(template, role, l);
      if (pinned) {
        const brain = await brains.get(pinned.brainId);
        if (!brain) {
          rejected = `brain "${pinned.brainId}" yang dipaku sudah tidak ada`;
        } else if (!brain.enabled) {
          rejected = `brain "${brain.name}" yang dipaku sedang dimatikan`;
        } else {
          return {
            brain,
            source: "pinned",
            reason: null,
            belowLevel: RANK[brain.level] < RANK[l] || undefined,
          };
        }
      }

      // Lapisan default grid. Hanya Brain yang benar-benar hidup: default
      // tidak boleh menghidupkan kembali Brain yang operator matikan.
      const defaultName = DEFAULT_BRAIN_MAP[norm(template)]?.[norm(role)]?.[l];
      if (defaultName) {
        const brain = await brains.get(defaultName);
        if (brain?.enabled) {
          return {
            brain,
            source: "default",
            reason: rejected,
            belowLevel: RANK[brain.level] < RANK[l] || undefined,
          };
        }
        rejected =
          rejected ?? `default grid "${defaultName}" tidak tersedia (tidak ada atau dimatikan); jatuh ke kandidat level`;
      }

      const candidates = await brains.candidatesFor({ level: l, category: category ?? undefined });
      if (candidates.length > 0) {
        return { brain: candidates[0], source: "level", reason: rejected, belowLevel: undefined };
      }
      return {
        brain: null,
        source: "unresolved",
        reason: rejected ?? `tidak ada Brain aktif pada level ${l}`,
        belowLevel: undefined,
      };
    },
  };

  return api;
}
