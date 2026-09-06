// Dispatch over the OpenClaw Gateway WebSocket.
//
// Spec §7.2 permits either AgentOS HTTP or "Gateway WS dengan token". The HTTP
// path turned out to be closed to us: AgentOS refuses write APIs from any
// client whose socket peer is not loopback (POC-4 D12). The Gateway, by
// contract, is built for token auth from other services — POC-1 and POC-2 both
// drive it that way.
//
// Wire contract read from the OpenClaw source in work/openclaw-source
// (packages/gateway-protocol/src/schema/frames.ts, src/gateway/server-methods/
// agent-request-types.ts, src/gateway/test-helpers.server.ts):
//
//   server → {type:"event", event:"connect.challenge", payload:{nonce}}
//   client → {type:"req", id, method:"connect", params:{minProtocol, maxProtocol,
//              client:{id,version,platform,mode}, role, scopes, auth:{token}}}
//   server → {type:"res", id, ok:true, payload:{type:"hello-ok", protocol,
//              features:{methods, capabilities}, ...}}
//   client → {type:"req", id, method:"agent.run", params:AgentRunRequest}
//
// VERSION CAVEAT: that source tree is 2026.8.1 while the cluster pins
// 2026.6.11. Rather than assume they agree, `connect` checks the advertised
// `features.methods` and refuses to continue if `agent.run` is missing. A
// version skew therefore fails loudly at startup instead of quietly at dispatch.
import { randomUUID } from "node:crypto";
import { buildDeviceBlock, loadOrCreateDeviceIdentity } from "./device-identity.mjs";
import { createAgentRegistry } from "./agent-registry.mjs";
import { nullLogger } from "../domain/logger.mjs";
import { withPreamble } from "./instruction.mjs";
import { usageFromMessage, isEmptyUsage } from "./session-events.mjs";
import { COMPLETED_STATUSES } from "../domain/thinking-probe.mjs";
import { quotaDriverFor } from "../domain/quota-drivers/index.mjs";

export class GatewayContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayContractError";
  }
}

// Newest first. `agent.run` is the 2026.8.x name; `agent` is what 2026.6.11
// advertises. Negotiated at connect from the server's own method list.
const DISPATCH_METHODS = ["agent.run", "agent"];

const PROTOCOL_MIN = 3;
const PROTOCOL_MAX = 4;

/**
 * The text a gateway error is classified on. Quota details usually arrive
 * nested inside a stringified error, so the quotes are escaped — unescape
 * once here rather than writing patterns that anticipate every nesting level.
 */
export function gatewayErrorText(errorLike) {
  const raw = typeof errorLike === "string" ? errorLike : JSON.stringify(errorLike ?? "");
  return raw.replace(/\\"/g, '"');
}

/** Recognises a provider quota refusal inside a gateway error payload. */
export function parseGatewayQuota(errorLike) {
  const text = gatewayErrorText(errorLike);
  if (!/rate limit|too many requests|session limit|usage limit|429/i.test(text)) return null;
  const resetsAt = Number(text.match(/"?resetsAt"?\s*[:=]\s*(\d+)/)?.[1] ?? 0) || null;
  const rateLimitType = text.match(/"?rateLimitType"?\s*[:=]\s*"?([a-z_]+)"?/i)?.[1] ?? null;
  // "resets 11:34" style messages carry no epoch; the caller falls back to a
  // retry window rather than inventing a timestamp.
  return { status: 429, resetsAt, rateLimitType, message: text.slice(0, 200), retryAfterSeconds: null };
}

/**
 * Derives the conversation key for a dispatch.
 *
 * CONTINUE inherits `session_ref` and therefore reuses the key derived from it;
 * FORK and FRESH arrive with no ref and get a key unique to their revision,
 * which the gateway treats as a new conversation.
 *
 * KNOWN LIMIT: a new key means an EMPTY conversation, not a copy of the parent.
 * On this gateway version FORK cannot branch history — there is no API to clone
 * a session — so FORK behaves as "start fresh, but recorded as descending from
 * the parent execution". That is a real gap against §5, and calling it a fork
 * without saying so would overstate what happens.
 */
/**
 * Is this candidate's reasoning effort a guarantee, or only a preference?
 *
 * The distinction is not bureaucratic. A catalog entry that claims "high
 * effort" while the provider ignores it is a lie the operator pays for twice:
 * once in the routing decision they made on that basis, and again when they
 * cannot understand why the expensive tier performed like the cheap one.
 *
 * Default is `guaranteed`, because that is what the measured majority do and
 * because an entry nobody has characterised should be treated as a claim to
 * verify, not as an excuse to withhold the parameter.
 */
export function effortIsGuaranteed(candidate) {
  return (candidate?.effortMode ?? "guaranteed") === "guaranteed";
}

export function sessionKeyFor(agentId, task, execution) {
  const ref = execution?.session_ref;
  const lineage = ref ? `s${ref}` : `r${execution?.revision_no ?? 1}`;
  return `agent:${agentId}:${task.id}:${lineage}`.toLowerCase();
}

export function createGatewayRuntime(config = {}, { WebSocketImpl = globalThis.WebSocket } = {}) {
  const {
    url = "ws://openclaw-gateway:18789",
    token,
    clientId = "gateway-client",
    clientMode = "backend",
    version = "0.1.0",
    connectTimeoutMs = 15_000,
    requestTimeoutMs = 600_000,
    // Device identity unlocks operator scopes; a bare token gets role without
    // scopes and dispatch is refused (D13). Set to null to connect token-only.
    identityPath = "/opt/semanggi/volumes/shared/service/semanggios/controller/device-identity.json",
    // operator.admin, granted by operator decision 2026-08-21. It unlocks two
    // things the controller genuinely needs: per-dispatch model override, and
    // agents.create for provisioning. Verified live — the same identity was
    // refused both at operator.write.
    scopes = ["operator.admin"],
    // Requested, not assumed. The gateway is asked at connect whether admin was
    // actually granted, and override is only used when it was; a demoted device
    // must fall back to agent matching rather than dispatching frames that get
    // rejected (D14).
    allowModelOverride = true,
    // Set false to dispatch straight to worker.agent_ref without checking that
    // the routed model will really be the model that runs. Only for tests.
    resolveAgentByModel = true,
    // Called for every `type:"event"` frame. This is how the controller learns a
    // run finished: the gateway pushes session events, and nothing else on this
    // version reports completion after the fact (D15).
    onEvent = null,
    log = nullLogger,
  } = config;

  let socket = null;
  let hello = null;
  let runMethod = null;
  const pending = new Map();
  // Request ids of dispatched runs, kept so a LATE refusal — the gateway's
  // second `res` frame for a request we already settled (see the late-error
  // branch below) — can still be tied back to the execution. The frame itself
  // carries no id we can act on, so the correlation is ours: recorded at send
  // time, bounded by age and size so a long-lived socket never leaks.
  const dispatchedRuns = new Map();
  const DISPATCHED_RUN_TTL_MS = 10 * 60 * 1000;
  function trackDispatchedRun(requestId, executionId) {
    const now = Date.now();
    for (const [key, entry] of dispatchedRuns) {
      if (entry.until < now) dispatchedRuns.delete(key);
    }
    if (dispatchedRuns.size >= 200) dispatchedRuns.delete(dispatchedRuns.keys().next().value);
    dispatchedRuns.set(requestId, { executionId, until: now + DISPATCHED_RUN_TTL_MS });
  }
  // Additive to `onEvent`, not a replacement for it: the module still has
  // exactly one external subscriber (D15's onEvent, wired to the session
  // event sink). This second, internal map lets `probeLevel` learn a
  // specific sessionKey's usage without a second subscription mechanism —
  // it's checked inline in the same message listener, right alongside the
  // external callback, and never removes or reorders what that callback sees.
  const usageWaiters = new Map();
  // Declared before `request` so the registry can call back into it.
  let registry = null;
  /** Scopes the gateway actually granted, as opposed to the ones we asked for. */
  const grantedScopes = () => hello?.auth?.scopes ?? [];

  function reset(reason) {
    for (const { reject } of pending.values()) reject(new Error(`gateway connection closed: ${reason}`));
    pending.clear();
    // A probe's own grace-period timer would eventually move on regardless,
    // but resolving to "no usage" immediately on disconnect means a probe in
    // flight during a reconnect reports promptly instead of sitting on its
    // full grace window for no reason.
    for (const { resolve } of usageWaiters.values()) resolve(null);
    usageWaiters.clear();
    socket = null;
    hello = null;
    runMethod = null;
  }

  async function connect() {
    if (hello && socket?.readyState === 1) return hello;
    if (!token) throw new GatewayContractError("gateway token is not configured");
    if (!WebSocketImpl) throw new GatewayContractError("no WebSocket implementation available");

    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url);
      socket = ws;
      let nonce;
      let settled = false;
      const connectId = randomUUID();

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        reject(new GatewayContractError(`gateway did not complete the handshake within ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);

      const sendConnect = () => {
        // Signing needs the challenge nonce. Without it we can still connect
        // token-only — useful for health checks — but scopes will be empty.
        let device;
        if (identityPath && nonce) {
          try {
            device = buildDeviceBlock({
              identity: loadOrCreateDeviceIdentity(identityPath),
              clientId,
              clientMode,
              role: "operator",
              scopes,
              token,
              nonce,
              platform: "linux",
            });
          } catch (err) {
            process.stderr.write(`[gateway] device auth unavailable: ${err.message}\n`);
          }
        }
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: PROTOCOL_MIN,
              maxProtocol: PROTOCOL_MAX,
              client: { id: clientId, version, platform: "linux", mode: clientMode },
              // tool-events: without this cap the gateway does not send the
              // structured tool lifecycle frames (session.tool), and the
              // transcript loses every tool result — the operator sees the
              // command the model ran but never what came back (D48).
              caps: ["tool-events"],
              commands: [],
              role: "operator",
              scopes,
              auth: { token },
              ...(device ? { device } : {}),
              // The connect challenge nonce belongs to `device`, not the root:
              // ConnectParamsSchema is a closed object and the live gateway
              // rejects a root-level nonce with
              //   INVALID_REQUEST "unexpected property 'nonce'".
              // We do not sign a device identity (token auth is enough for the
              // operator scopes we ask for), so the nonce is simply unused.
            },
          }),
        );
      };

      ws.addEventListener("open", () => {
        // The challenge is an event, not a response, and it may arrive before
        // or after `open`. Give it a brief window, then connect regardless:
        // device signing is optional for a token-auth operator client.
        setTimeout(() => {
          if (!settled) sendConnect();
        }, 250);
      });

      ws.addEventListener("message", (ev) => {
        let frame;
        try {
          frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }

        if (frame.type === "event" && frame.event === "connect.challenge") {
          nonce = frame.payload?.nonce;
          return;
        }

        if (frame.type === "event") {
          // Internal, additive check first: a probe waiting on THIS specific
          // sessionKey's usage should learn about it even though the run
          // producing it was never routed through the execution pipeline
          // (a probe has no task/execution row, so the external onEvent
          // path — which correlates by execution — has nothing to do with
          // it). Never throws outward; a probe that misses its usage still
          // completes via its own grace-period timeout.
          if (frame.event === "session.message" && usageWaiters.size > 0) {
            try {
              const key = frame.payload?.sessionKey ?? frame.payload?.session?.key ?? null;
              const waiter = key ? usageWaiters.get(key) : null;
              if (waiter) {
                const usage = usageFromMessage(frame.payload ?? {});
                if (usage && !isEmptyUsage(usage)) {
                  usageWaiters.delete(key);
                  waiter.resolve(usage);
                }
              }
            } catch (err) {
              process.stderr.write(`[gateway] usage waiter threw: ${err.message}\n`);
            }
          }
          // Never let a listener fault tear down the socket: a dropped
          // connection here would lose every subsequent completion event.
          try {
            onEvent?.(frame.event, frame.payload ?? {}, frame);
          } catch (err) {
            process.stderr.write(`[gateway] event listener threw: ${err.message}\n`);
          }
          return;
        }

        if (frame.type === "res" && frame.id === connectId) {
          clearTimeout(timer);
          settled = true;
          if (!frame.ok) {
            const detail = JSON.stringify(frame.error ?? {}).slice(0, 300);
            reject(new GatewayContractError(`gateway rejected the connection: ${detail}`));
            return;
          }
          hello = frame.payload ?? {};
          // Negotiate the dispatch method from what the server actually
          // advertises rather than trusting a source tree. Measured: OpenClaw
          // 2026.6.11 exposes a bare `agent`; 2026.8.1 renamed it `agent.run`.
          // Assuming either one would have failed against the other.
          const methods = hello.features?.methods;
          if (Array.isArray(methods)) {
            runMethod = DISPATCH_METHODS.find((m) => methods.includes(m)) ?? null;
            if (!runMethod) {
              reject(
                new GatewayContractError(
                  `this gateway advertises none of ${DISPATCH_METHODS.join(", ")} ` +
                    `(protocol ${hello.protocol}, ${methods.length} methods); ` +
                    `verify the dispatch method for the pinned OpenClaw version`,
                ),
              );
              return;
            }
          } else {
            runMethod = DISPATCH_METHODS[0];
          }
          resolve(hello);
          return;
        }

        // The gateway can answer the SAME request twice: an immediate
        // `accepted`, then a second `res` carrying a validation error. Measured:
        // a run accepted at 02:43 was refused in the same breath with
        //   UNAVAILABLE "Thinking level \"medium\" is not supported for zai/glm-4.7"
        // Our client had already settled the promise on the first frame, so the
        // refusal was dropped and the execution sat DISPATCHED with nobody
        // coming to finish it — the D20 deadlock, seen from its origin.
        //
        // The second frame cannot un-resolve a settled promise, so it is
        // surfaced as an event instead. The runId comes from our own send-time
        // bookkeeping (dispatchedRuns): the frame carries no usable identifier,
        // and without one the sink could never match the refusal to an
        // execution — which is exactly how the TASK-E28D15F3 incident spent
        // thirty minutes per attempt hiding a one-line config regression
        // behind the watchdog's generic message (D47).
        if (frame.type === "res" && !frame.ok && !pending.has(frame.id) && frame.error) {
          const tracked = dispatchedRuns.get(frame.id);
          dispatchedRuns.delete(frame.id);
          const executionId = tracked?.executionId ?? frame.payload?.runId ?? null;
          try {
            log.warn("gateway.late-error", { error: frame.error, exec: executionId });
            onEvent?.("gateway.late-error", { error: frame.error, runId: executionId }, frame);
          } catch {}
          return;
        }

        if (frame.type === "res" && pending.has(frame.id)) {
          const { resolve: res, reject: rej, timer: t } = pending.get(frame.id);
          clearTimeout(t);
          pending.delete(frame.id);
          if (frame.ok) res(frame.payload);
          else rej(Object.assign(new Error(JSON.stringify(frame.error ?? {}).slice(0, 400)), { gatewayError: frame.error }));
        }
      });

      ws.addEventListener("error", () => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        reject(new GatewayContractError(`gateway connection failed: ${url}`));
      });

      ws.addEventListener("close", (ev) => reset(ev?.reason || "closed"));
    });
  }

  async function request(method, params, { timeoutMs = requestTimeoutMs, onSent = null } = {}) {
    await connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      // Lets dispatch remember which request id flew under which execution,
      // so a late refusal can be correlated after this promise settles.
      try {
        onSent?.(id);
      } catch {}
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  const api = {
    connect,
    request,
    get hello() {
      return hello;
    },
    /** Which method this gateway accepts for a run; set during connect. */
    get dispatchMethod() {
      return runMethod;
    },

    /**
     * The agents the gateway will actually run.
     *
     * Distinct from the agent list in `openclaw.json`, and the difference is
     * the point: an entry can sit in the config forever without ever being
     * advertised here (D32). This list is therefore the operability test.
     */
    async listAgents() {
      const payload = await request("agents.list", {});
      const agents = payload?.agents ?? payload ?? [];
      return Array.isArray(agents) ? agents : [];
    },

    /**
     * D65: operator-initiated probe-agent creation for the Brain Test button.
     *
     * This is NOT the autonomous provisioning the registry deliberately
     * refuses (fleet shape during scheduling stays an operator decision) —
     * it fires only from an explicit Test click, creates exactly one
     * deterministic, conventionally-named agent (`sem-workspaces-probe-*`,
     * the same shape the probe fleet already uses), and is idempotent by
     * name. agents.create needs operator.admin, which the controller identity
     * has held since 2026-08-21 (model override); the shape {name, workspace,
     * model} is the one scripts/provision-agents.mjs measured on the wire.
     */
    async createProbeAgent({ name, workspace, model }) {
      const payload = await request("agents.create", { name, workspace, model });
      // Response shape from the gateway's createAgent result: {status,
      // agentId, name, workspace, ...} — the id is derived from the name
      // server-side, and status "existing" just means the deterministic name
      // already had this agent (idempotent by construction). agentId is the
      // field to read; `id` never exists on this payload and name is only the
      // last-ditch fallback.
      return { id: payload?.agentId ?? payload?.id ?? name, name };
    },

    async health() {
      try {
        const h = await connect();
        return { ok: true, protocol: h.protocol ?? null, methods: h.features?.methods?.length ?? null, dispatchMethod: runMethod };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * Models the gateway currently has onboarded and authenticated.
     *
     * MEASURED (2026-09-01, protocol 4): this is a live "what's actually usable
     * right now" list, not a static catalog — a fresh gateway with only `zai`
     * configured returns exactly the two zai models, nothing else. It never
     * lists a model's supported thinking/reasoning levels; only `reasoning:
     * true/false`. So this answers "what model names exist", not "what effort
     * levels work" — that second question is answered by thinking-levels.mjs,
     * which is seeded from measurement, not from this call.
     */
    async listModels() {
      await connect();
      if (!hello?.features?.methods?.includes("models.list")) return [];
      try {
        const payload = await request("models.list", {});
        const models = payload?.models ?? payload ?? [];
        return Array.isArray(models) ? models : [];
      } catch {
        return [];
      }
    },

    async dispatch({ task, execution, candidate, worker, workspacePath, instruction }) {
      if (!worker?.agent_ref) throw new GatewayContractError("worker has no agent_ref to dispatch to");
      // Connect first: the method name is negotiated during the handshake, and
      // reading it before then sends a frame with method:null.
      await connect();

      // P4-03 — no silent downgrade — has to hold on BOTH routes to the model,
      // so it is enforced twice rather than assumed once.
      //
      //   override active  → the gateway runs the routed model because we said
      //                      so explicitly; the agent's own model is irrelevant,
      //                      and matching on it would park tasks for no reason.
      //   override refused → the model that runs is the agent's, so an agent
      //                      offering a different model must be refused.
      //
      // `overrideActive` is read from the handshake, never from configuration:
      // a device demoted out of admin would otherwise keep sending overrides
      // that the gateway rejects, turning a scope change into dispatch failures.
      const canOverride = allowModelOverride && grantedScopes().includes("operator.admin");

      // Exact agent FIRST, override only as a fallback. Deliberate ordering:
      // an agent already configured for the routed model advertises the
      // reasoning levels that model really supports, so the effort can be
      // verified. Under an override the advertised levels describe the agent's
      // own model rather than the one that will run, and OpenClaw silently
      // clamps an unsupported level — so the override path can deliver reduced
      // effort without anyone noticing. Preferring the exact agent keeps that
      // blind spot rare instead of routine.
      let agentId = worker.agent_ref;
      let usedOverride = false;
      if (registry && candidate) {
        const base = { workspacePath: workspacePath ?? null, candidate, preferAgentId: worker.agent_ref };
        let agent = await registry.resolve({ ...base, ignoreModel: false });
        // A miss on cached data is not yet evidence that no agent can serve the
        // routed model: re-read the fleet and try the exact match again before
        // reaching for an override.
        //
        // This mattered on the cluster. Just after a gateway restart the fleet
        // briefly advertised `sem-qwen` with only `["off"]` thinking; the exact
        // match missed, the override path picked the worker's GLM agent, and
        // the gateway refused with `Thinking level "medium" is not supported for
        // zai/glm-4.7`. Falling back to a different agent made a transient blip
        // into a failed dispatch — worse than simply waiting a moment.
        if (!agent) agent = await registry.resolve({ ...base, ignoreModel: false }, { refresh: true });
        if (!agent && canOverride) {
          // Workspace still has to match: `cwd`/`workspaceDir` are rejected by
          // this gateway version regardless of scope (D14).
          agent = await registry.resolveOrThrow({ ...base, ignoreModel: true });
          usedOverride = true;
        } else if (!agent) {
          await registry.resolveOrThrow({ ...base, ignoreModel: false });
        }
        agentId = agent.id;
        // One line per dispatch, naming the decision. Diagnosing a misroute
        // from the gateway's error alone cost far more than this line costs.
        log.info("dispatch.resolved", {
          task: task.id,
          exec: execution.id,
          routedProvider: candidate.provider,
          routedModel: candidate.model,
          routedEffort: candidate.thinking ?? null,
          agent: agent.id,
          agentModel: agent.model,
          agentEfforts: agent.thinkingLevels ?? null,
          via: usedOverride ? "override" : "exact",
          workspace: workspacePath ?? null,
        });
      }

      // The execution id IS the idempotency key: one execution is one attempt,
      // so a retry after a lost response cannot start a second run (P4-11).
      //
      // Field set measured against the pinned gateway, not copied from the
      // newer source. `agent` on 2026.6.11 accepts message/agentId/
      // idempotencyKey/sessionKey/label/deliver/timeout/thinking and REJECTS
      // `cwd` and `workspaceDir` outright ("unexpected property"). The
      // workspace is therefore a property of the agent, not of the dispatch —
      // see docs/decisions.md D14.
      // The key dispatch SENDS — returned in the handoff so the controller can
      // correlate session.message events back to this execution (D48). For
      // CONTINUE revisions this is the composite `…:s<ref>` key, which is NOT
      // what ends up stored as session_ref.
      const sessionKey = sessionKeyFor(agentId, task, execution);
      const params = {
        // Preamble menyertai instruksi, tidak menggantikannya. Ia memuat hal
        // yang berbahaya kalau basi — Brain yang benar-benar berjalan, apakah
        // effort-nya aktif, direktori keluaran, mode lease — dan diturunkan
        // dari objek yang sama dengan keputusan routing, jadi tidak bisa
        // berbeda dari kenyataan (spec §8.8).
        message: withPreamble(instruction, {
          task,
          brain: candidate?.brain ?? candidate ?? null,
          role: worker?.role ?? null,
          workspacePath,
        }),
        idempotencyKey: execution.id,
        agentId,
        // A stable session key per task keeps CONTINUE/FORK on one conversation
        // thread; the harness-level Claude session is tracked separately in
        // Execution.session_ref (POC-3 E3-E6).
        // The session key IS the conversation on this gateway version — there is
        // no `sessionId` parameter to attach to. So the key has to encode the
        // session lineage, not just the task.
        //
        // Measured the hard way: keying on `agent:<agent>:<task>` alone made
        // CONTINUE work and FORK/FRESH silently continue the same conversation,
        // because every revision produced the identical key. Four revisions came
        // back sharing one session id.
        //
        // Now: an execution that inherited a session ref keeps talking to that
        // conversation; one that did not gets a key unique to its revision.
        // Keyed on the agent that WILL run, not the one the worker nominates —
        // the gateway rejects a mismatch outright and lowercases agent ids.
        sessionKey,
        label: task.id,
        // MUST be boolean. 2026.6.11 accepted the string "none"; 2026.7.1
        // rejects it with `at /deliver: must be boolean` — a schema change that
        // ships no warning and breaks dispatch entirely. We were already
        // correct, which is luck rather than design, so the type is asserted in
        // tests rather than left to the next person editing this object.
        deliver: false,
        // Sent only when the handshake actually granted admin. This is what
        // makes the routed model the model that runs, instead of hoping the
        // agent happens to be configured for it.
        ...(usedOverride && candidate?.provider ? { provider: candidate.provider } : {}),
        ...(usedOverride && candidate?.model ? { model: candidate.model } : {}),
        // Reasoning effort is part of the quality decision, not a detail: a
        // "critical" route that silently runs at the default effort is the same
        // class of downgrade as running the wrong model.
        //
        // But it is only sent when the catalog says the level is GUARANTEED —
        // measured to actually change the model's behaviour. Levels marked
        // `preference` are deliberately withheld, for two different reasons
        // that both end badly if ignored (see docs/decisions.md D31):
        //
        //   google/gemini-3.1-flash-lite  accepts every level and applies none.
        //     Measured n=3: off produced MORE output than high (533 vs 316,
        //     spread 9–479). Sending it would let a "high effort" label ride on
        //     a run that never did any.
        //   groq/qwen/qwen3.6-27b  accepts minimal/medium/high at the RPC and
        //     then never finishes — the run hangs until the watchdog reclaims
        //     it. Sending it turns a working model into a stalled task.
        ...(candidate?.thinking && effortIsGuaranteed(candidate) ? { thinking: candidate.thinking } : {}),
      };

      try {
        const payload = await request(runMethod, params, {
          onSent: (requestId) => trackDispatchedRun(requestId, execution.id),
        });
        return {
          runtimeRef: payload?.runId ?? payload?.id ?? execution.id,
          // The gateway names the conversation it attached the run to. Without
          // recording it, session_ref stays null forever and CONTINUE has
          // nothing to continue from — which is exactly how P4-10 failed the
          // first time it ran against the cluster.
          sessionRef: execution.session_ref ?? payload?.sessionKey ?? null,
          sessionKey,
          raw: payload,
        };
      } catch (err) {
        const errText = gatewayErrorText(err.gatewayError ?? err.message);
        const quota = parseGatewayQuota(err.gatewayError ?? err.message);
        if (quota) {
          err.status = 429;
          err.quota = { ...quota, provider: candidate.provider, model: candidate.model };
        } else {
          // POC-6 (D63): the gate above only knows the D52-era vocabulary,
          // and it MISSES real refusals — google's "RESOURCE_EXHAUSTED" says
          // neither "rate limit" nor "429". The provider driver classifies on
          // the same unescaped text: a "quota" verdict widens err.quota
          // exactly as the gate would have; a "fatal" verdict (groq's 413
          // structural wall, a 402 from a spent trial) rides as err.fatalQuota
          // for admission to block on instead of parking in WAIT_RUNTIME.
          const verdict = quotaDriverFor(candidate.provider).classifyError({
            status: err.status ?? null,
            text: errText,
          });
          if (verdict?.kind === "quota") {
            err.status = 429;
            err.quota = {
              status: 429,
              resetsAt: verdict.resetsAt ?? null,
              rateLimitType: verdict.rateLimitType ?? null,
              message: errText.slice(0, 200),
              retryAfterSeconds: null,
              provider: candidate.provider,
              model: candidate.model,
            };
          } else if (verdict?.kind === "fatal") {
            err.fatalQuota = {
              reason: verdict.reason ?? "provider fatal",
              structural: Boolean(verdict.structural),
              message: errText.slice(0, 200),
              provider: candidate.provider,
              model: candidate.model,
            };
          }
        }
        throw err;
      }
    },

    /**
     * Attach to a run that is still in flight.
     *
     * MEASURED LIMIT (D14): this is a live attach, not a result store. Called
     * after a run had already finished, the gateway answered
     *   {"status":"timeout","timeoutPhase":"gateway_draining"}
     * for a run that had completed five minutes earlier with stopReason=stop.
     * So a `timeout` here means "I could not watch it", never "it did not
     * finish" — treating the two as the same would let a completed task be
     * re-dispatched or marked failed.
     *
     * Completion is therefore always recovered from the controller's own store
     * plus `/api/snapshot` reconciliation. This method is an optimisation for
     * the happy path only, and callers must tolerate it returning nothing.
     *
     * @returns {Promise<{status: string, observed: boolean, raw: object}>}
     *   `observed:false` means the outcome is unknown and the reconciler owns it.
     */
    async waitForRun(runId, { timeoutMs = 300_000 } = {}) {
      await connect();
      if (!hello?.features?.methods?.includes("agent.wait")) {
        return { status: "unsupported", observed: false, raw: null };
      }
      try {
        const payload = await request("agent.wait", { runId }, { timeoutMs });
        const status = payload?.status ?? "unknown";
        // "timeout" is the gateway saying it stopped watching. It carries no
        // information about the run, so it must not be reported as an outcome.
        return { status, observed: status !== "timeout", raw: payload };
      } catch (err) {
        return { status: "error", observed: false, raw: { error: String(err.message).slice(0, 200) } };
      }
    },

    /**
     * Sends one throwaway prompt to an EXISTING agent and waits for the reply.
     *
     * This is the whole shape of a Brain "test connection": there is no RPC to
     * dry-run a (provider, model, thinking) combination in the abstract. One
     * agent carries exactly one model (D35), and the gateway refuses to run a
     * model the target agent isn't configured for — even for
     * `operator.admin` — so testing a Brain means finding an agent already
     * bound to its model and asking it something trivial. Callers are expected
     * to resolve `agentId` themselves (typically by matching
     * `listAgents()` against `${brain.provider}/${brain.model}`) and to treat
     * "no such agent" as its own outcome, not as a connection failure.
     *
     * "OK" means the run COMPLETED, not merely that it was accepted (D48).
     * The gateway answers some dispatches twice — an accepting frame, then a
     * refusal when the run fails to start (measured: a thinking level the
     * model does not support). Reporting the accept as OK made the Settings
     * page vouch for Brains that could never run (glm-5-2-max incident), so
     * only a status the gateway uses for a normally finished run passes;
     * everything else is reported with its reason.
     */
    async testAgent({ agentId, thinking = null, timeoutMs = 120_000 }) {
      await connect();
      const startedAt = Date.now();
      const key = `agent:${agentId}:semanggi-test:${randomUUID()}`;
      try {
        const dispatched = await request(runMethod, {
          agentId,
          message: 'Reply with ONLY this JSON, nothing else: {"ok":true}',
          idempotencyKey: randomUUID(),
          sessionKey: key,
          label: "semanggi-brain-test",
          deliver: false,
          ...(thinking ? { thinking } : {}),
        });
        const runId = dispatched?.runId ?? dispatched?.id;
        // The gateway's agent.watch stops after ~30s and answers status
        // "timeout" — measured on groq/qwen rate-limited runs, the real
        // verdict ("error: FailoverError: API rate limit reached") only
        // surfaces on a LATER wait. Giving up after the first timeout
        // conflated "still queued" with "hung" and reported a rate-limited
        // provider as a possible hang. Re-wait while the gateway keeps
        // answering timeout, bounded by the caller's window.
        let waited = { status: "unknown" };
        let status = "unknown";
        if (hello?.features?.methods?.includes("agent.wait")) {
          const maxWaits = Math.max(1, Math.floor(timeoutMs / 25_000));
          for (let attempt = 0; attempt < maxWaits && Date.now() - startedAt < timeoutMs; attempt += 1) {
            waited = await request("agent.wait", { runId }, { timeoutMs });
            status = waited.status ?? "unknown";
            if (status !== "timeout") break;
          }
        } else {
          waited = { status: "unsupported" };
          status = "unsupported";
        }
        const latencyMs = Date.now() - startedAt;
        if (COMPLETED_STATUSES.has(status)) {
          return { ok: true, status, latencyMs, raw: waited };
        }
        // The refusal detail arrives in two shapes on the wire: a plain string
        // (measured: cerebras run refused with 'Thinking level "high" is not
        // supported … Use one of: off.') or an object with .message. Reading
        // only the object shape made every string refusal degrade to the
        // generic "run did not complete normally" — the operator lost the one
        // sentence that said WHY, and a thinking-level rejection read like an
        // outage.
        const waitDetail =
          typeof waited?.error === "string" ? waited.error : waited?.error?.message ?? null;
        const waitedFor = Math.round((Date.now() - startedAt) / 1000);
        const error =
          status === "timeout"
            ? `run had not finished after ${waitedFor}s of waiting (the gateway kept answering "timeout" while it watched) — treated as unusable (possible hang)`
            : status === "unsupported"
              ? "this gateway does not support agent.wait — the run was dispatched but its completion could not be confirmed"
              : `run did not complete normally (status: ${status})${waitDetail ? ` — ${waitDetail}` : ""}`;
        return { ok: false, status, latencyMs, error, raw: waited };
      } catch (err) {
        return {
          ok: false,
          status: "error",
          latencyMs: Date.now() - startedAt,
          error: String(err.gatewayError?.message ?? err.message).slice(0, 300),
        };
      } finally {
        // Best-effort cleanup so a probe doesn't leave a live session pinned
        // to the agent forever. Failure here is not reported: the test's own
        // result already happened, and a cleanup miss is a cluster-hygiene
        // concern, not a "did the Brain work" concern.
        try {
          await request("sessions.abort", { key }, { timeoutMs: 10_000 });
        } catch {
          /* best-effort */
        }
      }
    },

    /**
     * Sends one throwaway prompt to an EXISTING agent at a SPECIFIC thinking
     * level and reports how much output it produced — the measurement
     * `testAgent` deliberately doesn't take (D31's evidence field needs a
     * token count, and `agent.wait`'s own response never carries usage; only
     * the async `session.message` event does, correlated by sessionKey).
     *
     * Same dispatch/wait/cleanup shape as `testAgent`, plus:
     *   - a usage waiter registered against this call's own sessionKey
     *     before dispatch, so the event that arrives while `agent.wait` is
     *     still blocking isn't missed;
     *   - a short grace window AFTER `agent.wait` settles, because the two
     *     are different channels (RPC vs event stream) with no ordering
     *     guarantee between them;
     *   - `status:"timeout"` is surfaced as-is, not retried or extended.
     *     D14 already established that a live-attach timeout means "could
     *     not observe it", not "it is stuck" — but for a PROBE the caller
     *     cares about a bounded wall-clock cost per candidate level far more
     *     than about resolving that ambiguity, so the orchestrator in
     *     thinking-probe.mjs treats it as "exclude this level" and moves on
     *     rather than waiting longer or trying again.
     */
    async probeLevel({ agentId, thinking = null, timeoutMs = 60_000, usageGraceMs = 5_000 }) {
      await connect();
      const startedAt = Date.now();
      const key = `agent:${agentId}:semanggi-probe:${randomUUID()}`;
      let resolveUsage;
      const usagePromise = new Promise((resolve) => {
        resolveUsage = resolve;
      });
      usageWaiters.set(key, { resolve: resolveUsage });
      try {
        const dispatched = await request(runMethod, {
          agentId,
          message: 'Reply with ONLY this JSON, nothing else: {"ok":true}',
          idempotencyKey: randomUUID(),
          sessionKey: key,
          label: "semanggi-thinking-probe",
          deliver: false,
          ...(thinking ? { thinking } : {}),
        });
        const runId = dispatched?.runId ?? dispatched?.id;
        const waited = hello?.features?.methods?.includes("agent.wait")
          ? await request("agent.wait", { runId }, { timeoutMs })
          : { status: "unsupported" };
        const usage = await Promise.race([
          usagePromise,
          new Promise((resolve) => setTimeout(() => resolve(null), usageGraceMs)),
        ]);
        return {
          ok: true,
          status: waited.status ?? "unknown",
          latencyMs: Date.now() - startedAt,
          usage,
          raw: waited,
        };
      } catch (err) {
        return {
          ok: false,
          status: "error",
          latencyMs: Date.now() - startedAt,
          usage: null,
          error: String(err.gatewayError?.message ?? err.message).slice(0, 300),
        };
      } finally {
        usageWaiters.delete(key);
        // Best-effort cleanup so a probe doesn't leave a live session pinned
        // to the agent forever — including a hung level that timed out
        // above and may still be running server-side.
        try {
          await request("sessions.abort", { key }, { timeoutMs: 10_000 });
        } catch {
          /* best-effort */
        }
      }
    },

    /**
     * Stops a run that is still in flight.
     *
     * Measured contract: `sessions.abort` takes `key` (the sessionKey) and
     * answers `{ok, abortedRunId, status}` — `status:"no-active-run"` when
     * there was nothing to stop. That distinction matters: "I stopped it" and
     * "there was nothing running" lead to different states, and treating them
     * alike would let a task be marked stopped while its run kept going.
     */
    async abortRun({ sessionKey }) {
      if (!sessionKey) return { ok: false, aborted: false, reason: "no session key" };
      await connect();
      try {
        const payload = await request("sessions.abort", { key: sessionKey }, { timeoutMs: 30_000 });
        const aborted = Boolean(payload?.abortedRunId);
        log.info("run.abort", { sessionKey, aborted, status: payload?.status ?? null });
        return { ok: true, aborted, status: payload?.status ?? null, raw: payload };
      } catch (err) {
        log.warn("run.abort-failed", { sessionKey, error: String(err.message).slice(0, 200) });
        return { ok: false, aborted: false, reason: String(err.message).slice(0, 200) };
      }
    },

    async close() {
      try {
        socket?.close();
      } catch {}
      reset("closed by controller");
    },
  };

  if (resolveAgentByModel) registry = createAgentRegistry({ runtime: api });
  return api;
}
