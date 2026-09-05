// Which agents exist, which ones Semanggi can actually use, and who made them.
//
// Two control planes write the same agent registry and neither knows about the
// other (D28/D32). AgentOS edits `openclaw.json` directly on disk; Semanggi
// creates agents through the gateway's RPC. The result is that the two see
// different things, and an operator looking at either list alone will draw the
// wrong conclusion.
//
// The discriminator is not a label anybody has to remember to set — it is
// measured, and it falls out of how the gateway behaves:
//
//   in the config file  →  AgentOS shows it
//   in `agents.list`    →  the gateway will actually run it
//
// Those two sets are NOT the same, and the gap is where the danger lives.
// Measured on the cluster: creating an agent through the AgentOS API wrote a
// complete-looking entry into the config and then failed to build its agent
// directory (EACCES). The entry sits in the file forever, AgentOS lists it as a
// real agent, and the gateway never advertises it. An operator would reasonably
// try to route work to it.
//
// So `agents.list` is treated as the source of truth for operability, and the
// config file only as the source of truth for existence.

/** Semanggi's own agents follow a naming convention set by provision-agents.mjs. */
const SEMANGGI_NAME = /^(semanggi|sem)-/i;

/** The gateway reports models as {primary}, and thinking levels as objects. */
const modelOf = (a) =>
  typeof a?.model === "string" ? a.model : (a?.model?.primary ?? a?.model?.id ?? null);

const levelsOf = (a) => {
  const raw = a?.thinkingOptions ?? a?.thinkingLevels ?? null;
  if (!Array.isArray(raw)) return null;
  return raw.map((x) => (typeof x === "string" ? x : (x?.id ?? x?.label ?? String(x))));
};

/**
 * Where an agent's working directory lives says who created it.
 *
 * Measured: Semanggi's provisioner puts it under the shared state dir; AgentOS
 * puts it inside the workspace at `.openclaw/agents/<id>/agent`. That is a
 * genuine behavioural difference, not a style choice — an AgentOS agent dir
 * travels with the workspace and ours does not.
 */
function originOf(configEntry, id) {
  const dir = configEntry?.agentDir ?? "";
  if (dir.includes("/.openclaw/agents/")) return "agentos";
  if (dir.includes("/state/agents/")) return "semanggi";
  return SEMANGGI_NAME.test(id) ? "semanggi" : "unknown";
}

/**
 * Builds one honest list from the two disagreeing sources.
 *
 * @param liveAgents  what `agents.list` returned (the gateway will run these)
 * @param configAgents  `agents.list` from the config file (AgentOS shows these)
 * @param catalog  routing catalog entries, to say what each agent is good for
 */
export function buildAgentInventory({ liveAgents = [], configAgents = [], catalog = [] } = {}) {
  const liveById = new Map(liveAgents.map((a) => [String(a.id), a]));
  const configById = new Map(configAgents.map((a) => [String(a.id), a]));
  const ids = new Set([...liveById.keys(), ...configById.keys()]);

  const rows = [];
  for (const id of [...ids].sort()) {
    const live = liveById.get(id) ?? null;
    const cfg = configById.get(id) ?? null;
    const model = modelOf(live) ?? cfg?.model ?? null;
    const workspace = live?.workspace ?? cfg?.workspace ?? null;
    const levels = levelsOf(live);

    // What could actually route here. An agent with no catalog entry is not
    // broken — it just is not part of any routing decision Semanggi makes.
    const matches = catalog.filter((c) => {
      if (!model) return false;
      if (`${c.provider}/${c.model}` !== model) return false;
      if (!c.thinking) return true;
      if ((c.effortMode ?? "guaranteed") !== "guaranteed") return true;
      return !levels || levels.includes(c.thinking);
    });

    // The three states an operator needs to tell apart.
    let state;
    let advice = null;
    if (live && cfg) {
      state = "operable";
    } else if (!live && cfg) {
      // The dangerous one: looks real in AgentOS, will never run.
      state = "config-only";
      advice =
        "listed in openclaw.json but not advertised by the gateway — usually a half-created agent " +
        "(config written, agent directory not). It will never run; delete and recreate it.";
    } else {
      // Advertised but absent from the config we can read. Not necessarily
      // wrong — the controller may simply be reading a config it does not own.
      state = "live-only";
      advice = "advertised by the gateway but absent from the config file this controller can read";
    }

    rows.push({
      id,
      name: live?.name ?? cfg?.name ?? id,
      model,
      workspace,
      thinkingLevels: levels,
      origin: originOf(cfg, id),
      state,
      // The bottom line, in one field: may Semanggi route work here?
      operableBySemanggi: state === "operable" && matches.length > 0,
      catalogEntries: matches.map((c) => c.name),
      advice,
    });
  }
  return rows;
}

/** Counts worth showing above the table, so the exceptions are visible first. */
export function summariseInventory(rows) {
  return {
    total: rows.length,
    operable: rows.filter((r) => r.operableBySemanggi).length,
    configOnly: rows.filter((r) => r.state === "config-only").length,
    liveOnly: rows.filter((r) => r.state === "live-only").length,
    bySemanggi: rows.filter((r) => r.origin === "semanggi").length,
    byAgentOs: rows.filter((r) => r.origin === "agentos").length,
    // Advertised and healthy, but no routing entry points at it. Not an error,
    // and worth seeing before somebody wonders why it never gets work.
    unroutable: rows.filter((r) => r.state === "operable" && r.catalogEntries.length === 0).length,
  };
}
