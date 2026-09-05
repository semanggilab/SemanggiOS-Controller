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
    async replaceAll(models) {
      const rows = (Array.isArray(models) ? models : [])
        .map((m) => ({
          provider: norm(m?.provider),
          model: norm(m?.id ?? m?.model),
          name: m?.name ?? null,
          reasoning: m?.reasoning ? 1 : 0,
          available: m?.available === false ? 0 : 1,
        }))
        .filter((r) => r.provider && r.model);

      await store.tx(async (tx) => {
        await tx.run(`DELETE FROM gateway_models`);
        for (const r of rows) {
          await tx.run(
            `INSERT INTO gateway_models (provider, model, name, reasoning, available, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, model) DO UPDATE SET name = excluded.name,
               reasoning = excluded.reasoning, available = excluded.available, updated_at = excluded.updated_at`,
            [r.provider, r.model, r.name, r.reasoning, r.available, now()],
          );
        }
      });
      return api.list();
    },
  };
  return api;
}

function present(row) {
  return {
    id: row.model,
    provider: row.provider,
    name: row.name,
    reasoning: Boolean(row.reasoning),
    available: Boolean(row.available),
    updatedAt: row.updated_at,
  };
}
