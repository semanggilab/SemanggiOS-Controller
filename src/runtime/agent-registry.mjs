// Resolving a routed model to a concrete OpenClaw agent.
//
// WHY THIS EXISTS
//
// There are two ways the routed model can become the model that actually runs,
// and P4-03 — no silent downgrade — has to hold on both.
//
//   1. Model override at dispatch. Needs `operator.admin`; granted to the
//      controller on 2026-08-21. The override *makes* the routed model run, so
//      the agent's own configured model is irrelevant.
//   2. No override. The model that runs is whatever the agent is configured
//      with, so an agent offering something else must be refused.
//
// Case 2 is the dangerous one and is why this module exists. Routing picks
// `glm-5.2-high`, dispatch goes to an agent configured `zai/glm-4.7`, the run
// completes looking successful — having used a weaker model than the quality
// class demanded. Nothing in the transport was catching that.
//
// So the caller passes `ignoreModel` to say which case it is, and when nothing
// matches we refuse. Refusing parks the task as a resource problem an operator
// can see and fix, which is the correct failure: the spec is explicit that
// availability decides *dispatch or wait*, never *which model*.
//
// The scope is checked from the handshake rather than from configuration
// (`hello.auth.scopes`), so a device demoted out of admin degrades into case 2
// instead of sending overrides the gateway will reject.
//
// PROVISIONING — SCRIPT UNTUK OPERATOR, OTOMATIS DALAM PAGAR (D80)
//
// `agents.create` is admin-gated (`src/gateway/methods/core-descriptors.ts`),
// and the controller holds admin, so it can create agents at runtime. Until
// D78 it deliberately did not — fleet shape is an operator decision with
// consequences beyond one task — and that stance lived here as
// "PROVISIONING STAYS A SCRIPT". D80 reversed it BY OPERATOR REQUEST, but the
// reversal kept the original worry and answered it with fences instead of
// trust: automatic creation only ever names `sem-auto-*` agents, never touches
// claude-code (ACP agents are routing-pinned), is capped per model by
// resources.concurrency_limit, and requires an explicit resource row — no row,
// no fleet. The rules live in `domain/sandbox-provision.mjs`; the operator's
// bulk path remains `scripts/provision-agents.mjs`.

// OpenClaw clamps an unsupported reasoning effort down to the nearest level it
// does support, silently:
//
//   src/auto-reply/thinking.ts  resolveSupportedThinkingLevelFromProfile()
//     ranked.find((entry) => entry.id !== "off" && entry.rank <= requestedRank)
//
// So asking for "high" against a model whose profile stops at "low" runs at
// "low" and reports success. That is the same class of failure as running the
// wrong model — a "critical" route quietly served at reduced effort — so the
// routed level is checked against what the agent actually advertises rather
// than trusted to arrive intact.
export class AgentUnavailableError extends Error {
  constructor(message, { workspacePath, provider, model, available } = {}) {
    super(message);
    this.name = "AgentUnavailableError";
    // Admission reads this to park the task rather than fail it.
    this.retriable = true;
    this.workspacePath = workspacePath;
    this.provider = provider;
    this.model = model;
    this.available = available ?? [];
  }
}

/** The gateway reports a configured model as a single "provider/model" string. */
export function modelKey(provider, model) {
  return `${provider}/${model}`;
}

/**
 * `claude-code` runs reach the Claude harness over ACP (POC-3). The harness
 * model is not the agent's model, so matching the agent on
 * `claude-code/claude-code` would never succeed and would be meaningless if
 * it did. Workspace still has to match.
 *
 * D85 — APA YANG SALAH SEBELUMNYA
 *
 * Komentar lama di sini berbunyi "dispatched to an orchestrator agent that
 * then drives the Claude harness", dan `resolve()` bertindak sesuai itu:
 * pencocokan model DIMATIKAN untuk harness, tanpa ada yang menggantikannya.
 * Akibatnya setiap agen di workspace itu lolos — termasuk `preferAgentId`
 * milik worker, yang selalu diperiksa lebih dulu.
 *
 * Terukur 2026-09-08 pada TASK-5A24B39E: dirutekan ke Brain `claude-opus-high`
 * (`acpAgent: claude-opus`), dijalankan oleh `sdmk-kader-architect` pada
 * `zai/glm-5.2`, dan dicatat `via: "exact"` seolah pencocokan berhasil.
 * Buktinya datang dari pesan kuotanya sendiri: "Usage limit reached for
 * 5 hour. Your limit will reset at ..." adalah kalimat milik ZAI, bukan
 * Anthropic. Operator melihatnya karena langganan Claude-nya justru sehat.
 *
 * Yang hilang bukan sekadar model yang benar. Run itu memakai kuota provider
 * LAIN, dan melewati seluruh kontrak POC-3 — sandbox `--cap-drop ALL`,
 * `.claude-home` di NFS, dan interposer gerbang izin — tanpa meninggalkan
 * satu baris log pun. Nol container `openclaw.acp=1`, nol `.claude-home`,
 * nol `session/request_permission` dalam 24 jam, sementara transkrip
 * TASK-90D214DF mencatat `exec` tiga kali.
 *
 * Karena itu harness kini dicocokkan pada NAMA agen ACP (`acpAgent`), bukan
 * pada model dan bukan pada "agen mana pun di workspace ini".
 */
function isHarnessRouted(candidate) {
  return candidate?.provider === "claude-code";
}

/** Nama agen ACP yang dipaku sebuah kandidat harness, ternormalisasi. */
function acpAgentOf(candidate) {
  return String(candidate?.acpAgent ?? "").trim().toLowerCase() || null;
}

export function createAgentRegistry({ runtime, ttlMs = 30_000, now = () => Date.now() } = {}) {
  if (!runtime) throw new Error("agent registry needs a gateway runtime");

  let cache = null;
  let cachedAt = 0;

  async function list({ refresh = false } = {}) {
    if (!refresh && cache && now() - cachedAt < ttlMs) return cache;
    const payload = await runtime.request("agents.list", {});
    const agents = Array.isArray(payload?.agents) ? payload.agents : [];
    cache = agents.map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      workspace: a.workspace ?? null,
      // Shape measured on the wire: {"model":{"primary":"zai/glm-4.7"}}.
      model: a.model?.primary ?? null,
      // Also on the wire: thinkingLevels:[{id:"off"},{id:"low"}], thinkingDefault.
      // The set is resolved per model, so a glm agent may offer only off/low
      // while a Claude one offers up to high.
      thinkingLevels: Array.isArray(a.thinkingLevels) ? a.thinkingLevels.map((t) => t.id ?? t) : null,
      thinkingDefault: a.thinkingDefault ?? null,
    }));
    cachedAt = now();
    return cache;
  }

  /**
   * @returns {Promise<{id: string, model: string|null, workspace: string|null}|null>}
   */
  async function resolve({ workspacePath, candidate, preferAgentId = null, ignoreModel = false }, opts = {}) {
    const agents = await list(opts);
    // `ignoreModel` is set when the caller will override the model at dispatch
    // (operator.admin). The routed model is then guaranteed by the override
    // itself, so requiring the agent to also match would reject perfectly good
    // agents and park work for nothing.
    const harness = isHarnessRouted(candidate);
    // D85: untuk harness, `acpAgent` MENGGANTIKAN pencocokan model — bukan
    // sekadar mematikannya. Lihat catatan di isHarnessRouted.
    const wantAcpAgent = harness ? acpAgentOf(candidate) : null;
    const wantModel = ignoreModel || harness ? null : modelKey(candidate.provider, candidate.model);

    // A preference-mode level is never sent to the gateway, so requiring the
    // agent to advertise it would park work for a parameter nobody will use.
    const wantThinking =
      candidate?.thinking && (candidate?.effortMode ?? "guaranteed") === "guaranteed" ? candidate.thinking : null;

    const matches = (a) => {
      if (workspacePath && a.workspace !== workspacePath) return false;
      if (harness) {
        // Berlaku juga saat `ignoreModel` — override model TIDAK mengubah
        // agen mana yang sah untuk sebuah harness. Justru sebaliknya: jalur
        // override itulah yang paling mudah menyerahkan run ke agen asing,
        // karena ia sengaja berhenti memeriksa model.
        //
        // Tanpa `acpAgent`, sebuah Brain harness tidak bisa dirutekan sama
        // sekali. Mengembalikan "tidak ada yang cocok" adalah jawaban yang
        // benar — menerima agen mana pun adalah bug yang D85 perbaiki.
        if (!wantAcpAgent) return false;
        return String(a.id ?? "").toLowerCase() === wantAcpAgent;
      }
      if (wantModel && a.model !== wantModel) return false;
      // Only checked when the agent tells us what it supports AND we are not
      // overriding the model: with an override the advertised levels belong to
      // the agent's own model, not the one that will run, so they say nothing.
      if (wantThinking && !ignoreModel && a.thinkingLevels && !a.thinkingLevels.includes(wantThinking)) return false;
      return true;
    };

    // An explicitly assigned worker agent wins when it satisfies the routing
    // decision — a worker's agent_ref is an operator's deliberate pairing, and
    // silently preferring some other equally-matching agent would make dispatch
    // unpredictable.
    if (preferAgentId) {
      const preferred = agents.find((a) => a.id === preferAgentId);
      if (preferred && matches(preferred)) return preferred;
    }
    return agents.find(matches) ?? null;
  }

  async function resolveOrThrow(args) {
    // One retry against a fresh list: an operator provisioning an agent while
    // the controller runs should not have to wait out the cache.
    let found = await resolve(args);
    if (!found) found = await resolve(args, { refresh: true });
    if (found) return found;

    const { workspacePath, candidate, ignoreModel } = args;
    const agents = await list();
    const inWorkspace = agents.filter((a) => !workspacePath || a.workspace === workspacePath);
    const detail = inWorkspace.length
      ? `agents in that workspace offer: ${[...new Set(inWorkspace.map((a) => a.model ?? "?"))].join(", ")}`
      : `no agent is configured for workspace ${workspacePath}`;

    // D85: kegagalan harness MUST menyebut nama agen ACP yang dicari. Pesan
    // lama ("no agent providing claude-code/claude-code") menunjuk model yang
    // memang tidak akan pernah ada dan mengirim operator mencari hal yang
    // salah; yang sebenarnya kurang adalah agen bernama `acpAgent`.
    const effort = candidate?.thinking ? ` at thinking="${candidate.thinking}"` : "";
    const want = isHarnessRouted(candidate)
      ? acpAgentOf(candidate)
        ? `the ACP harness agent "${acpAgentOf(candidate)}" this Brain pins`
        : "an ACP harness agent (this Brain pins none — set acpAgent on it)"
      : ignoreModel
        ? "any agent"
        : `an agent providing ${modelKey(candidate.provider, candidate.model)}${effort}`;
    throw new AgentUnavailableError(
      `no ${want} for ${workspacePath}; ` +
        `${detail}. Provision one with scripts/provision-agents.mjs ` +
        `rather than dispatching at a different model or reduced reasoning effort (P4-03).`,
      { workspacePath, provider: candidate.provider, model: candidate.model, available: inWorkspace },
    );
  }

  return { list, resolve, resolveOrThrow, invalidate: () => (cache = null) };
}
