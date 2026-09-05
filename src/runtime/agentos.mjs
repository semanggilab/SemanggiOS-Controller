// Runtime adapter — the controller's only door to AgentOS.
//
// The contract below is not inferred from documentation; it was verified
// against the running AgentOS 0.7.6 during POC-4 §11 (see
// docs/poc4-source-verification.md):
//
//   1. Instance protection gates everything except /api/health, so a bearer
//      token alone is refused with 401 instance-auth-required. A session login
//      is required first and its cookie must accompany every call.
//   2. Safe methods work cross-service; write methods are refused from a
//      non-loopback origin. Hence the loopback forwarder.
//   3. Dispatch is POST /api/mission {mission, workspaceId} → {dispatchId}.
//   4. There is no API to read a dispatch record. Status comes from the SSE
//      stream and /api/snapshot; the mission-control JSON files on NFS are
//      AgentOS's private state and are deliberately not read.
import { startLoopbackForwarder } from "./loopback.mjs";

export class RuntimeContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeContractError";
  }
}

/** Recognises a provider quota refusal in whatever shape it arrives. */
export function parseQuotaSignal({ status, headers, body }) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const is429 = status === 429 || /rate limit|too many requests|session limit|usage limit/i.test(text);
  if (!is429) return null;

  // POC-3 observed both forms: an absolute epoch in the ACP stream
  // ({"resetsAt":1787113200,"rateLimitType":"five_hour"}) and a human string in
  // the batch result ("resets 9:40am (UTC)"). The epoch is authoritative.
  const resetsAt = Number(text.match(/"resetsAt"\s*:\s*(\d+)/)?.[1] ?? 0) || null;
  const rateLimitType = text.match(/"rateLimitType"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const retryAfter = Number(headers?.get?.("retry-after")) || null;
  const message = text.match(/"result"\s*:\s*"([^"]{0,200})"/)?.[1] ?? text.slice(0, 200);

  return { status: 429, resetsAt, rateLimitType, retryAfterSeconds: retryAfter, message };
}

/**
 * @param config.upstreamHost  AgentOS service DNS name (e.g. "agentos")
 * @param config.username      bootstrapped admin username
 * @param config.password      admin password (from a Swarm secret)
 * @param config.apiToken      agentos_api_token (from a Swarm secret)
 */
export function createAgentOSRuntime(config = {}, { fetchImpl = globalThis.fetch, forwarder = null } = {}) {
  const { upstreamHost, upstreamPort = 3000, username = "admin", password, apiToken } = config;
  let link = forwarder;
  let cookie = null;

  async function ensureLink() {
    if (link) return link;
    if (!upstreamHost) throw new RuntimeContractError("upstreamHost is not configured");
    link = await startLoopbackForwarder({ port: config.loopbackPort ?? 0, upstreamHost, upstreamPort });
    return link;
  }

  async function login() {
    const { origin } = await ensureLink();
    if (!password) throw new RuntimeContractError("admin password is not configured");
    const res = await fetchImpl(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, referer: `${origin}/login` },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new RuntimeContractError(`AgentOS login failed: HTTP ${res.status}`);
    cookie = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("agentos_instance_session="));
    if (!cookie) throw new RuntimeContractError("AgentOS login returned no session cookie");
    return cookie;
  }

  async function call(path, { method = "GET", body } = {}, { retry = true } = {}) {
    const { origin } = await ensureLink();
    if (!cookie) await login();
    const res = await fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        referer: `${origin}/`,
        ...(apiToken ? { authorization: `Bearer ${apiToken}`, "x-agentos-api-token": apiToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Sessions expire; one silent re-login is worth it, a loop is not.
    if (res.status === 401 && retry) {
      cookie = null;
      return call(path, { method, body }, { retry: false });
    }
    return res;
  }

  return {
    async health() {
      const { origin } = await ensureLink();
      const res = await fetchImpl(`${origin}/api/health`);
      return { ok: res.ok, status: res.status };
    },

    async dispatch({ task, execution, candidate, worker, workspacePath, instruction }) {
      if (!task.project_id) throw new RuntimeContractError("task has no project");
      const workspaceId = task.workspace_id ?? worker?.workspace_id ?? task.project_id;

      const res = await call("/api/mission", {
        method: "POST",
        body: { mission: instruction, workspaceId },
      });
      const text = await res.text();

      if (!res.ok) {
        const quota = parseQuotaSignal({ status: res.status, headers: res.headers, body: text });
        const err = new Error(`AgentOS dispatch failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        err.status = res.status;
        // Attaching the parsed signal lets the caller park the task on
        // WAIT_QUOTA with a real reset time instead of treating a quota refusal
        // as a generic runtime error.
        if (quota) err.quota = { ...quota, provider: candidate.provider, model: candidate.model };
        throw err;
      }

      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        throw new RuntimeContractError(`AgentOS returned non-JSON for /api/mission: ${text.slice(0, 120)}`);
      }
      if (!body.dispatchId) throw new RuntimeContractError("AgentOS response carried no dispatchId");

      return {
        runtimeRef: body.dispatchId,
        // The harness session id is learned later from the execution stream;
        // CONTINUE/FORK resume relies on it, so it is not invented here.
        sessionRef: execution.session_ref ?? null,
      };
    },

    /**
     * Reconciliation source. POC-2 E3/E7 found dispatch records that stay
     * `running` or report `timeout` after the work actually succeeded, so a
     * single poll is not trusted; the snapshot revision tells us when to look.
     */
    async snapshot() {
      const res = await call("/api/snapshot");
      if (!res.ok) return null;
      return res.json();
    },

    async close() {
      if (link?.close) await link.close();
      link = null;
      cookie = null;
    },
  };
}
