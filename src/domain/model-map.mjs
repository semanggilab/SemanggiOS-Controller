// Model Map — gabungan dua tabel yang menjawab satu pertanyaan operator:
// "model apa saja yang kita punya, dan fakta terukur apa yang sudah ada
// untuknya?"
//
// KENAPA GABUNGAN, BUKAN SATU TABEL
//
// `resources` dan `thinking_levels` beririsan pada kunci (provider, model)
// tetapi punya PENULIS yang berbeda: baris resource ditulis operator dan
// ditimpa sinyal live 429 (availability, next_available_at), baris
// thinking-levels ditulis alur probe (D38 — fakta terukur, bukan iklan
// agents.list). Menyatukan mereka ke satu tabel berarti satu baris dengan
// tiga penulis dan irama tulis berbeda; menggabungkan di lapisan baca
// memberikan satu halaman tanpa mencampur kepemilikan itu.
//
// Baris yang hanya ada di satu sisi TIDAK disembunyikan: resource tanpa
// pengukuran thinking tetap tampil (levels null), dan thinking-levels tanpa
// baris resource tetap tampil — baris kedua jenis itu memarkir task di
// WAIT_RESOURCE saat dirutekan (admission langkah 4), jadi menyembunyikannya
// di halaman ini justru menyembunyikan persis masalah yang dicari operator.

/**
 * @param {Array<object>} resources baris mentah repos.resources.list()
 *   (snake_case, quota_policy sudah ter-hydrate menjadi objek).
 * @param {Array<object>} thinkingLevels baris thinkingLevels.list()
 *   (sudah presented: levels/effortMode/evidence/updatedAt).
 * @returns {Array<object>} baris Model Map, terurut provider lalu model.
 */
export function mergeModelMap(resources, thinkingLevels) {
  const key = (provider, model) =>
    `${String(provider ?? "").trim().toLowerCase()}/${String(model ?? "").trim().toLowerCase()}`;

  const byKey = new Map();
  const rowFor = (provider, model) => {
    const k = key(provider, model);
    let row = byKey.get(k);
    if (!row) {
      row = { provider: String(provider), model: String(model), sources: [] };
      byKey.set(k, row);
    }
    return row;
  };

  for (const r of resources ?? []) {
    // Sisi kiri baris memakai ejaan resource: dialah pintu tulis operator,
    // jadi ejaan yang dipakai operator di halaman ini harus identik dengan
    // yang disimpan tabel resources.
    const row = rowFor(r.provider, r.model);
    row.provider = r.provider;
    row.model = r.model;
    row.creditClass = r.credit_class ?? null;
    row.concurrencyLimit = r.concurrency_limit ?? null;
    row.quotaPolicy = r.quota_policy ?? null;
    row.windowKind = r.window_kind ?? null;
    // Sinyal live — dibaca, tidak pernah ditulis dari halaman ini.
    row.availability = r.availability ?? null;
    row.nextAvailableAt = r.next_available_at ?? null;
    row.lastQuotaSignal = r.last_quota_signal ?? null;
    row.resourceUpdatedAt = r.updated_at ?? null;
    if (!row.sources.includes("resource")) row.sources.push("resource");
  }

  for (const t of thinkingLevels ?? []) {
    const row = rowFor(t.provider, t.model);
    row.levels = t.levels ?? null;
    row.effortMode = t.effortMode ?? null;
    row.evidence = t.evidence ?? null;
    row.levelsUpdatedAt = t.updatedAt ?? null;
    if (!row.sources.includes("thinking-levels")) row.sources.push("thinking-levels");
  }

  return [...byKey.values()]
    .map((row) => ({
      creditClass: null,
      concurrencyLimit: null,
      quotaPolicy: null,
      windowKind: null,
      availability: null,
      nextAvailableAt: null,
      lastQuotaSignal: null,
      resourceUpdatedAt: null,
      levels: null,
      effortMode: null,
      evidence: null,
      levelsUpdatedAt: null,
      ...row,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
