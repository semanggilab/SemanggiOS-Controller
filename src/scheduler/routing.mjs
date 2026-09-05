// Model routing policy — POC-4 §5.3.
//
// The binding rule: quality decides the *candidate set*, availability decides
// *dispatch or wait*. Availability is never allowed to widen the candidate set,
// because that is exactly the silent downgrade the spec forbids (P4-03).

/**
 * Quality class (L0..L5, the organisation-wide vocabulary) mapped onto the
 * routing tiers the policy file is written in. Overridable per deployment so a
 * team can add tiers without editing code.
 */
export const DEFAULT_CLASS_MAP = Object.freeze({
  L5: "critical",
  L4: "critical",
  L3: "normal",
  L2: "normal",
  L1: "low",
  L0: "low",
});

export class RoutingPolicy {
  #catalog;
  #routes;
  #classMap;
  #fallbackCategory;

  constructor({ catalog = {}, routes = {}, classMap = DEFAULT_CLASS_MAP, defaultCategory = null } = {}) {
    this.#catalog = catalog;
    this.#routes = routes;
    this.#classMap = { ...DEFAULT_CLASS_MAP, ...classMap };
    this.#fallbackCategory = defaultCategory;
  }

  /**
   * The catalog, read-only, for surfaces that have to offer a choice.
   *
   * Slack and the operator UI both need to answer "what can I actually ask
   * for?", and the honest answer is exactly this list — a name that isn't in it
   * routes to nothing and parks the task in WAIT_RESOURCE. Entries starting
   * with `_` are prose notes in the policy file, not models.
   */
  catalogEntries() {
    return Object.entries(this.#catalog)
      .filter(([name, entry]) => !name.startsWith("_") && entry && typeof entry === "object")
      .map(([name, entry]) => ({ name, ...entry }));
  }

  /**
   * Resolves what an operator typed to a catalog name.
   *
   * Accepts an exact name ("glm-5.2-high"), a model plus an effort
   * ("glm-5.2 high"), or a bare model ("glm-5.2") — the last of which is
   * ambiguous whenever the catalog offers more than one effort for it, and is
   * reported as such rather than resolved to whichever came first. Picking
   * silently would mean an operator asking for a model and getting an effort
   * level they never named, which is the same class of surprise as a silent
   * downgrade.
   *
   * @returns {{ok:true,name,entry}|{ok:false,reason,candidates:string[]}}
   */
  matchCatalog(model, effort = null) {
    const entries = this.catalogEntries();
    const wanted = String(model ?? "").trim().toLowerCase();

    if (wanted) {
      const exact = entries.find((e) => e.name.toLowerCase() === wanted);
      if (exact && !effort) return { ok: true, name: exact.name, entry: exact };
    }
    if (wanted && effort) {
      const joined = `${wanted}-${effort}`.toLowerCase();
      const hit = entries.find((e) => e.name.toLowerCase() === joined);
      if (hit) return { ok: true, name: hit.name, entry: hit };
    }

    // Fall back to matching the underlying provider model, which is what an
    // operator is more likely to have in mind than our naming scheme.
    let pool = wanted
      ? entries.filter((e) => e.model?.toLowerCase() === wanted || e.name.toLowerCase().startsWith(wanted))
      : entries;
    if (effort) pool = pool.filter((e) => (e.thinking ?? null) === effort);

    if (pool.length === 1) return { ok: true, name: pool[0].name, entry: pool[0] };
    if (pool.length === 0) {
      return {
        ok: false,
        reason: `no catalog entry for "${model ?? "?"}"${effort ? ` at ${effort}` : ""}`,
        candidates: entries.map((e) => e.name),
      };
    }
    return {
      ok: false,
      reason: `"${model}"${effort ? ` at ${effort}` : ""} matches ${pool.length} entries`,
      candidates: pool.map((e) => e.name),
    };
  }

  routeClassFor(task) {
    return task.model_policy?.class ?? this.#classMap[task.quality_class] ?? "normal";
  }

  categoryFor(task) {
    return task.model_policy?.category ?? this.#fallbackCategory;
  }

  /**
   * @returns {{ok: true, candidates: Array}|{ok: false, reason: string}}
   *   candidates are ordered by operator preference (POC-4 §5.3: "urutan =
   *   preferensi kebiasaan operator"), each {logical, provider, model, mode}.
   */
  resolve(task) {
    const explicit = task.model_policy?.preferred;
    const category = this.categoryFor(task);
    const routeClass = this.routeClassFor(task);

    let logicalNames;
    if (Array.isArray(explicit) && explicit.length > 0) {
      logicalNames = explicit;
    } else {
      if (!category) {
        return { ok: false, reason: "task has no model category and no default is configured" };
      }
      const route = this.#routes[category]?.[routeClass];
      if (!route) {
        return { ok: false, reason: `no routing policy for ${category}/${routeClass}` };
      }
      const fallback = route.fallback;
      const extra = Array.isArray(fallback) ? fallback : [];
      logicalNames = [...(route.preferred ?? []), ...extra];
    }

    const candidates = [];
    const unmapped = [];
    for (const logical of logicalNames) {
      const entry = this.#catalog[logical];
      if (!entry) {
        unmapped.push(logical);
        continue;
      }
      candidates.push({ logical, ...entry });
    }

    if (candidates.length === 0) {
      const detail = unmapped.length ? `unmapped model names: ${unmapped.join(", ")}` : "policy lists no models";
      return { ok: false, reason: `${category ?? "explicit"}/${routeClass}: ${detail}` };
    }

    // A partially broken catalog is a configuration fault worth surfacing, but
    // it must not stop a task that still has valid candidates.
    return { ok: true, candidates, unmapped };
  }
}

/**
 * `claude-code` is its own resource class (POC-4 §4) and may only be reached
 * through the POC-3 ACP or batch path (§5.3). Enforced here so no future route
 * can quietly send it down the ordinary model path.
 */
export function assertDispatchPathAllowed(candidate) {
  if (candidate.provider === "claude-code" && !["acp", "batch"].includes(candidate.mode)) {
    throw new Error(
      `claude-code may only dispatch via the ACP or batch path (POC-3), got mode="${candidate.mode}"`,
    );
  }
  return candidate;
}
