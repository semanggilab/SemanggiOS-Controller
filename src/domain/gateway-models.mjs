// Cache of the gateway's own `models.list` answer.
//
// Same shape of problem as thinking-levels.mjs, one door down: `models.list`
// is a live RPC, and every open of the Add/Edit Brain form used to pay for
// it again even though the answer rarely changes between one form open and
// the next. This module is the place that answer is kept between a live
// "Refresh Models" call and whatever reads the list afterward — a page load,
// a re-render, another operator opening the same form a minute later.
//
// It is a cache, not a source of truth: the gateway is still asked directly
// every time "Refresh Models" is pressed (see server.mjs's refresh route),
// and this module only remembers the last answer for everyone else.
//
// D84 — DUA SUMBER, SATU BARIS
//
// `contextWindow` dan `maxTokens` TIDAK datang dari `models.list`. Diukur
// live di 2026.8.2: satu entri models.list berisi persis
// {id, provider, name, reasoning, available} — tidak ada satu pun angka
// batas di dalamnya. Keduanya tinggal di `models.providers[].models[]` milik
// config gateway, dan dibaca lewat `config.get` (runtime.modelLimits()).
//
// Keduanya disimpan di baris yang sama karena keduanya menjawab pertanyaan
// yang sama — "model ini bisa apa" — dan operator yang membuka Model Map
// tidak peduli RPC mana yang mengangkutnya. Yang tidak boleh terjadi adalah
// sebaliknya: satu model muncul dua kali karena dua RPC mengejanya berbeda,
// jadi kedua sisi dinormalisasi dengan `norm()` yang sama.

const norm = (s) => String(s ?? "").trim().toLowerCase();

export function createGatewayModelsCache(store, { now } = {}) {
  const api = {
    async list() {
      const rows = await store.all(`SELECT * FROM gateway_models ORDER BY provider, model`);
      return rows.map(present);
    },

    /**
     * Overwrites the cache with exactly what the gateway just reported.
     *
     * Full replace, not merge: a model the gateway stopped advertising (an
     * expired credential, a de-configured provider) must disappear from the
     * cache too, or the Brain form would keep offering a model that no
     * longer exists to route to.
     */
    async replaceAll(models, limits = []) {
      // Peta batas dari config.get, dikunci dengan ejaan yang SAMA dengan
      // baris models.list — dua RPC, satu kunci, atau satu model akan muncul
      // sebagai dua baris yang tidak pernah bertemu.
      const limitBy = new Map();
      for (const l of Array.isArray(limits) ? limits : []) {
        const k = `${norm(l?.provider)}/${norm(l?.model ?? l?.id)}`;
        if (k !== "/") limitBy.set(k, l);
      }

      const rows = (Array.isArray(models) ? models : [])
        .map((m) => {
          const provider = norm(m?.provider);
          const model = norm(m?.id ?? m?.model);
          const limit = limitBy.get(`${provider}/${model}`) ?? {};
          return {
            provider,
            model,
            name: m?.name ?? null,
            reasoning: m?.reasoning ? 1 : 0,
            available: m?.available === false ? 0 : 1,
            // Angka yang tidak dilaporkan tetap NULL, bukan 0: "tidak tahu"
            // dan "nol" adalah dua jawaban berbeda, dan 0 di kolom context
            // window akan terbaca sebagai model yang tidak bisa apa-apa.
            contextWindow: positiveOrNull(limit.contextWindow),
            maxTokens: positiveOrNull(limit.maxTokens),
          };
        })
        .filter((r) => r.provider && r.model);

      await store.tx(async (tx) => {
        await tx.run(`DELETE FROM gateway_models`);
        for (const r of rows) {
          await tx.run(
            `INSERT INTO gateway_models (provider, model, name, reasoning, available, context_window, max_tokens, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, model) DO UPDATE SET name = excluded.name,
               reasoning = excluded.reasoning, available = excluded.available,
               context_window = excluded.context_window, max_tokens = excluded.max_tokens,
               updated_at = excluded.updated_at`,
            [r.provider, r.model, r.name, r.reasoning, r.available, r.contextWindow, r.maxTokens, now()],
          );
        }
      });
      return api.list();
    },
  };
  return api;
}

/** Angka batas yang sah, atau null. Nol dan negatif bukan batas. */
function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function present(row) {
  return {
    id: row.model,
    provider: row.provider,
    name: row.name,
    reasoning: Boolean(row.reasoning),
    available: Boolean(row.available),
    // Dinormalkan SAAT DIBACA, bukan hanya saat ditulis (D92).
    //
    // Nilainya sudah lolos positiveOrNull sebelum disimpan, jadi penulisan
    // aman. Yang tidak aman adalah pembacaan: driver Postgres mengembalikan
    // bigint sebagai STRING, sementara SQLite mengembalikannya sebagai angka.
    // Kontrak API ini menjanjikan angka, dan pembacanya memperlakukan yang
    // bukan angka sebagai "tidak diketahui" — terukur: setelah pindah ke
    // Postgres, kolom Context window di Model Map menampilkan "—" untuk SETIAP
    // model meski nilainya utuh di config maupun di tabel.
    //
    // Kegagalan seperti ini tidak berbunyi. Ia tampak seperti data yang memang
    // belum diisi.
    contextWindow: positiveOrNull(row.context_window),
    maxTokens: positiveOrNull(row.max_tokens),
    updatedAt: row.updated_at,
  };
}
