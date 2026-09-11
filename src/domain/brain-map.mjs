// Brain Map: pemetaan (template AgentOS × role × level) → DAFTAR Brain terurut.
//
// KENAPA INI TERPISAH DARI role_levels
//
// Keduanya menjawab pertanyaan yang berbeda dan sama-sama perlu:
//
//   role_levels  "seberapa mahal role ini boleh berpikir?"   → low|normal|critical
//   brain_map    "di level itu, Brain yang MANA?"            → daftar Brain bernama,
//                                                               urutan = urutan coba
//
// Tanpa brain_map, pilihan jatuh ke kandidat pertama pada level tersebut. Itu
// tidak salah — levelnya tetap dihormati — tetapi operator tidak bisa
// mengendalikannya, dan urutan kandidat berasal dari berkas routing yang hanya
// bisa diubah lewat deploy. Halaman Brain Map ada supaya keputusan itu bisa
// dipindahkan ke orang yang menjalankan projectnya.
//
// KENAPA DAFTAR TERURUT, BUKAN SATU BRAIN (D68)
//
// Satu pemaku berarti satu titik kegagalan: Brain itu habis kuota → task
// parkir, padahal ada peer setara di sebelahnya. Daftar terurut membuat sel
// memegang rencana failover operator: anggota pertama yang hidup menang.
//
// Urutan dievaluasi ulang pada TIAP percobaan dispatch — tidak ada penunjuk
// tersimpan ("sedang di anggota ke-i") yang pernah direset. Itu desain, bukan
// kelalaian: penunjuk yang bertahan membuat task lama menolak Brain yang
// sudah sembuh (fail-back tidak pernah terjadi) dan butuh aturan reset
// tambahan. Evaluasi per-dispatch memberi keduanya gratis: pemilihan selalu
// anggota hidup PERTAMA, jadi pemulihan otomatis kembali ke urutan awal, dan
// "reset saat task baru" menjadi korolari, bukan aturan tersendiri.
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
 *
 * Baris `chat` (POC-10 §10.1/§7.4) mengikuti prioritas operator untuk chat
 * room: gratis dulu — gemini-flash-high di low/normal — naik ke glm-5-2-max
 * hanya di critical. Operator bebas memaku ulang sel chat lewat halaman yang
 * sama; nilai ini hanya titik awal yang tidak menyulitkan dompet.
 */
export const DEFAULT_BRAIN_MAP = Object.freeze({
  software: Object.freeze({
    analyst: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    architect: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    builder: Object.freeze({ [Level.LOW]: "glm-5-1-on", [Level.NORMAL]: "glm-5-1-on", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    tester: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    learner: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    chat: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
  frontend: Object.freeze({
    analyst: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    architect: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    builder: Object.freeze({ [Level.LOW]: "glm-5-1-on", [Level.NORMAL]: "glm-5-1-on", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    tester: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    learner: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    browser: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-1-on" }),
    chat: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
  backend: Object.freeze({
    analyst: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    architect: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    builder: Object.freeze({ [Level.LOW]: "glm-5-1-on", [Level.NORMAL]: "glm-5-1-on", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    tester: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    learner: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    chat: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
  research: Object.freeze({
    researcher: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
    writer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "qwen-high" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
    analyst: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
    chat: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
  content: Object.freeze({
    strategist: Object.freeze({ [Level.LOW]: "glm-5-2-max", [Level.NORMAL]: "glm-5-2-max", [Level.CRITICAL]: "glm-5-2-max" }),
    writer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
    reviewer: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
    analyst: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "qwen-high", [Level.CRITICAL]: "qwen-high" }),
    chat: Object.freeze({ [Level.LOW]: "gemini-flash-high", [Level.NORMAL]: "gemini-flash-high", [Level.CRITICAL]: "glm-5-2-max" }),
  }),
});

export function createBrainMap(store, { now } = {}) {
  const present = (r) => ({
    template: r.template,
    role: r.role,
    level: r.level,
    position: r.position,
    brainId: r.brain_id,
    actor: r.actor,
    updatedAt: r.updated_at,
  });

  const api = {
    /** Semua baris anggota, apa adanya, terurut per sel lalu posisi. */
    async list({ template } = {}) {
      const rows = template
        ? await store.all(
            `SELECT * FROM brain_map WHERE template = ? ORDER BY role, level, position`,
            [norm(template)],
          )
        : await store.all(`SELECT * FROM brain_map ORDER BY template, role, level, position`);
      return rows.map(present);
    },

    /** Daftar terurut milik satu sel; kosong berarti sel tidak dipaku. */
    async getCell(template, role, level) {
      const rows = await store.all(
        `SELECT * FROM brain_map WHERE template = ? AND role = ? AND level = ? ORDER BY position`,
        [norm(template), norm(role), norm(level)],
      );
      return rows.map(present);
    },

    /**
     * Tulis daftar terurut untuk sebuah (template, role, level).
     *
     * `brainIds` adalah array terurut (index 0 = dicoba pertama); `brainId`
     * skalar diterima sebagai list satu-anggota — jalur lama yang membuat
     * migrasi UI tidak harus atomik.
     *
     * Validasi saat disetel, bukan saat dispatch:
     *   - setiap anggota harus sudah ada (unknown → tolak)
     *   - tidak boleh ada anggota kembar
     *   - SELURUH daftar tidak boleh dimatikan — sel demikian tidak pernah
     *     jalan, kelas kesalahan yang sama dengan agen `config-only` di D32.
     *     Anggota tunggal yang dimatikan tetap ditolak (list satu-anggota
     *     semua-mati); anggota dimatikan DI TENGAH daftar diperbolehkan:
     *     ia diskip saat resolve dan hidup kembali begitu diaktifkan.
     */
    async set({ template, role, level, brainId, brainIds, actor = "operator" }, { brains } = {}) {
      const t = norm(template);
      const r = norm(role);
      const l = norm(level);
      if (!t || !r || !l) throw new Error("template, role and level are required");
      if (!(l in RANK)) throw new Error(`invalid level "${level}"`);
      const raw = brainId != null ? [brainId] : brainIds;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("brainIds (ordered, non-empty) is required — send [] or null via the API to clear");
      }
      const resolved = [];
      if (!brains) {
        resolved.push(...raw.map((id) => ({ id, name: String(id), enabled: true })));
      } else {
        for (const id of raw) {
          const brain = await brains.get(id);
          if (!brain) throw new Error(`unknown brain "${id}"`);
          if (resolved.some((b) => b.id === brain.id)) {
            throw new Error(`duplicate brain "${brain.name}" — a failover list names each peer once`);
          }
          resolved.push(brain);
        }
        if (resolved.every((b) => !b.enabled)) {
          throw new Error(
            `every brain in the list is disabled (${resolved.map((b) => b.name).join(", ")}); ` +
              "the cell would never run",
          );
        }
      }
      await store.tx(async () => {
        await store.run(`DELETE FROM brain_map WHERE template = ? AND role = ? AND level = ?`, [t, r, l]);
        let position = 0;
        for (const brain of resolved) {
          await store.run(
            `INSERT INTO brain_map (template, role, level, position, brain_id, actor, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [t, r, l, position++, brain.id, actor, now()],
          );
        }
      });
      return api.getCell(t, r, l);
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
     * Daftar kandidat terurut untuk sebuah (template, role, level).
     *
     * @returns {{source, candidates, skipped, names, reason}}
     *   `source` salah satu dari:
     *     `pinned`      sel grid ini punya daftar operator
     *     `default`     belum dipaku; default grid (DEFAULT_BRAIN_MAP)
     *     `level`       tidak dipaku dan tanpa default; pool level (urut nama)
     *     `unresolved`  tidak ada kandidat sama sekali — task akan WAIT_RESOURCE
     *
     * `candidates` = anggota hidup (ada + enabled) pada urutannya, masing-masing
     * membawa `belowLevel`. `skipped` = anggota daftar yang tidak bisa melayani
     * sekarang beserta alasannya — dipakai untuk menegaskan kenapa failover
     * turun, bukan untuk menghapus anggota (fail-back otomatis begitu ia hidup).
     * `names` = urutan NAMA untuk model_policy.preferred: seluruh anggota yang
     * barisnya masih ada, termasuk yang dimatikan — admission yang memutuskan
     * siapa yang hidup, per percobaan dispatch.
     *
     * `belowLevel` menandai Brain yang klasifikasinya di bawah level sel.
     * Dengan kunci per level, memilih Brain demikian adalah keputusan eksplisit
     * operator — jadi ia dipakai, dan peringatannya ikut bersamanya.
     */
    async resolve({ template, role, level, brains } = {}) {
      const l = norm(level);
      const notes = [];
      const skipped = [];

      const members = await api.getCell(template, role, l);
      if (members.length > 0) {
        const candidates = [];
        const names = [];
        for (const m of members) {
          const brain = await brains.get(m.brainId);
          if (!brain) {
            // brains.delete() membersihkan pemaku, jadi baris menggantung hanya
            // lahir dari tangan di DB — tetap dilaporkan, bukan ditelan.
            skipped.push({ position: m.position, name: m.brainId, reason: "brain tidak ada" });
            continue;
          }
          names.push(brain.name);
          if (!brain.enabled) {
            skipped.push({ position: m.position, name: brain.name, reason: "dimatikan" });
            continue;
          }
          candidates.push({ brain, position: m.position, belowLevel: RANK[brain.level] < RANK[l] || undefined });
        }
        if (candidates.length > 0) {
          return { source: "pinned", candidates, skipped, names, reason: null };
        }
        notes.push(
          `seluruh pemaku tidak tersedia: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`,
        );
      }

      // Lapisan default grid. Hanya Brain yang benar-benar hidup: default
      // tidak boleh menghidupkan kembali Brain yang operator matikan.
      const defaultName = DEFAULT_BRAIN_MAP[norm(template)]?.[norm(role)]?.[l];
      if (defaultName) {
        const brain = await brains.get(defaultName);
        if (brain?.enabled) {
          return {
            source: "default",
            candidates: [{ brain, position: 0, belowLevel: RANK[brain.level] < RANK[l] || undefined }],
            skipped,
            names: [brain.name],
            reason: notes[0] ?? null,
          };
        }
        notes.push(notes[0] ?? `default grid "${defaultName}" tidak tersedia (tidak ada atau dimatikan); jatuh ke kandidat level`);
      }

      // D64: pool level tanpa penyaringan kategori — resolve tidak pernah
      // menerima kategori sejak grid (template, role, level) yang memutus.
      // Seluruh pool jadi daftar: failover berlaku juga untuk sel yang tidak
      // pernah disentuh operator.
      const pool = await brains.candidatesFor({ level: l });
      if (pool.length > 0) {
        return {
          source: "level",
          candidates: pool.map((brain) => ({ brain, belowLevel: undefined })),
          skipped,
          names: pool.map((b) => b.name),
          reason: notes[0] ?? null,
        };
      }
      return {
        source: "unresolved",
        candidates: [],
        skipped,
        names: [],
        reason: notes[0] ?? `tidak ada Brain aktif pada level ${l}`,
      };
    },
  };

  return api;
}
