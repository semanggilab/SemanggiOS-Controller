// Katalog kosakata thinking/reasoning per (provider, model).
//
// Ini bukan cache dari sebuah RPC — tidak ada RPC yang menjawabnya. Isinya
// diseed dari `config/thinking-levels.json`, sebuah berkas yang ditulis dari
// pengukuran nyata (dispatch sungguhan, baca hasilnya). "Refresh" di sini
// berarti menyinkronkan DB dari berkas itu, BUKAN mengukur ulang secara
// langsung — pengukuran ulang mahal (butuh dispatch nyata per level) dan
// dikerjakan lewat skrip probe terpisah yang menulis ke berkas ini.

const norm = (s) => String(s ?? "").trim().toLowerCase();

export function createThinkingLevels(store, { now } = {}) {
  const api = {
    async list({ provider, model } = {}) {
      const rows = provider && model
        ? await store.all(`SELECT * FROM thinking_levels WHERE provider = ? AND model = ?`, [norm(provider), norm(model)])
        : await store.all(`SELECT * FROM thinking_levels ORDER BY provider, model`);
      return rows.map(present);
    },

    async get(provider, model) {
      const row = await store.get(`SELECT * FROM thinking_levels WHERE provider = ? AND model = ?`, [
        norm(provider),
        norm(model),
      ]);
      return row ? present(row) : null;
    },

    async upsert({ provider, model, levels, effortMode = "guaranteed", evidence = null }) {
      const p = norm(provider);
      const m = norm(model);
      if (!p || !m) throw new Error("provider and model are required");
      if (!Array.isArray(levels)) throw new Error("levels must be an array");
      if (!["guaranteed", "preference"].includes(effortMode)) {
        throw new Error("effortMode must be guaranteed or preference");
      }
      await store.run(
        `INSERT INTO thinking_levels (provider, model, levels, effort_mode, evidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET levels = excluded.levels,
           effort_mode = excluded.effort_mode, evidence = excluded.evidence, updated_at = excluded.updated_at`,
        [p, m, JSON.stringify(levels), effortMode, evidence, now()],
      );
      return api.get(p, m);
    },

    // D67: sisi pengukuran dari penghapusan baris Model Map. Fakta terukur
    // tanpa baris resource tidak bermasalah, tetapi operator yang menghapus
    // "model" dari halaman itu bermaksud menghapus keduanya — menyisakan
    // baris satu sisi justru memunculkan kembali baris yang baru dihapus,
    // kali ini sebagai baris "no resource entry".
    async delete(provider, model) {
      await store.run(`DELETE FROM thinking_levels WHERE provider = ? AND model = ?`, [
        norm(provider),
        norm(model),
      ]);
    },

    /**
     * Menyinkronkan DB dari `config/thinking-levels.json`.
     *
     * Bukan pengukuran ulang — lihat catatan di kepala berkas. Mengembalikan
     * jumlah entri yang disinkronkan supaya pemanggil (dan UI) tahu ini benar
     * membaca sesuatu, bukan diam-diam tidak melakukan apa pun.
     */
    async refresh(seedPath) {
      const { readFileSync } = await import("node:fs");
      const url = seedPath ?? new URL("../../config/thinking-levels.json", import.meta.url);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(url, "utf8"));
      } catch (err) {
        throw new Error(`could not read thinking-levels seed: ${err.message}`);
      }
      const entries = Array.isArray(parsed?.models) ? parsed.models : [];
      let synced = 0;
      for (const entry of entries) {
        await api.upsert({
          provider: entry.provider,
          model: entry.model,
          levels: entry.levels ?? [],
          effortMode: entry.effortMode ?? "guaranteed",
          evidence: entry.evidence ?? null,
        });
        synced += 1;
      }
      return { synced, at: now() };
    },
  };
  return api;
}

function present(row) {
  return {
    provider: row.provider,
    model: row.model,
    levels: JSON.parse(row.levels),
    effortMode: row.effort_mode,
    evidence: row.evidence,
    updatedAt: row.updated_at,
  };
}
