# Architecture decisions — POC-4 dan fase UI

Each entry records a choice the spec left open, or a place where implementation forced a decision. POC-4 §9 requires the storage choice to be recorded in the implementation PR; the rest are here for the same reason.

**Cakupan:** D1–D35 adalah POC-4 (controller, scheduler, routing, Slack, Brain). D36–D41 adalah fase UI — halaman Semanggi di dalam AgentOS, setelan project, probe level empiris, transkrip yang lengkap, dan jalur build image. D42–D45 adalah era Brain sebagai sumber routing. D46–D48 adalah era loop cepat NFS dan kejujuran kontrak gateway: iterasi tanpa build image, penolakan lambat yang dipetakan ke eksekusi, uji koneksi yang jujur, dan transkrip yang menangkap output tool.

**Cara membaca:** judul yang ~~dicoret~~ adalah keputusan yang **sudah tidak berlaku** — isinya sengaja dipertahankan karena alasan sebuah keputusan gugur seringkali lebih berguna daripada keputusan penggantinya. Judul tanpa coretan berlaku sampai ada entri yang membatalkannya secara eksplisit.

| Keputusan | Digantikan oleh | Kenapa |
|---|---|---|
| ~~D12-original~~ (write path lewat loopback forwarder) | D12, D13 | Loopback forwarder memalsukan pemeriksaan asal; dispatch pindah ke Gateway WS langsung |
| ~~D8~~ (kontrak dispatch AgentOS sengaja tidak diimplementasikan) | D12, D13 | Jalur itu tidak lagi ditunggu — dispatch tidak pernah lewat AgentOS |
| ~~D17~~ sebagian ("Gemini tidak melapor usage") | D19 | Gemini melapor; permintaannya yang tidak pernah mengirim `stream_options.include_usage` |
| ~~D30~~ sebagian (dua janji upgrade 7.1) | D34 | `workspaceDir` dan `agentRuntime.acp.agent` terbukti tidak ada di 7.1 |

## D1 — SQLite now, Postgres-portable by construction

§3 allows "PostgreSQL (atau SQLite untuk lab)". SQLite via Node's built-in `node:sqlite` was chosen for the lab stack:

- The controller is `replicas: 1` by mandate, so there is exactly one writer. The main reason to reach for Postgres — concurrent writers — does not apply.
- Adding a Postgres service means another Swarm service, another NFS volume, and another secret, on a cluster whose manager node had 5.6 GB free during POC-3.
- `node:sqlite` is in the standard library, so the controller has **zero runtime dependencies**. For a service that holds scheduling state and an audit trail, that is a meaningful reduction in supply-chain surface.

Portability was paid for up front rather than promised: the store interface in `src/db/index.mjs` is **async** even though the SQLite driver is synchronous, and every query uses positional `?` placeholders in one adapter. Swapping in Postgres means writing one driver, not editing call sites.

Known cost: `node:sqlite` is flagged experimental on Node 22 (stable on 24, which the gateway image already ships). Revisit before production.

## D2 — Nine waiting states, not three

Spec induk §5.1 names `WAIT_RESOURCE | WAIT_DEP | WAIT_HUMAN`. POC-4 §5.1 defines nine admission checks and P4-02 requires each blocker to be distinguishable. Implementing only three states would make P4-02 untestable and would leave an operator staring at `WAIT_RESOURCE` with no way to tell "no policy" from "quota exhausted" from "provider saturated".

The waiting states are therefore the pipeline's nine. The invariant both specs actually share — *a blocked admission is `WAIT_*`, never `FAILED`* — is enforced in the transition table: there is no edge from `QUEUED` or any `WAIT_*` state to `FAILED`.

## D3 — Rejected approval yields BLOCKED, not FAILED or CANCELLED

§6 says an operator may APPROVE / REJECT / MODIFY / COMMENT. A rejection means the work is intact but must not proceed — that is `BLOCKED`, which already has the recovery path the spec wants (`BLOCKED → RESUMABLE → QUEUED` via a revision). `FAILED` would misreport a deliberate human decision as a malfunction.

`COMMENT` was made a separate endpoint that does **not** close the approval. A comment is a question or a note; treating it as a decision would resume a task nobody actually approved.

`decided_by` is mandatory. An approval that cannot be attributed is not an approval.

## D4 — Expedite is a TTL boost with a tie-break, never a priority rewrite

P4-05 requires the boost to lapse. Priority is left untouched and only the selector reads `expedite_until`, so expiry needs no cleanup job — the boost simply stops applying.

The boost is two priority levels. That can land on a tie with an existing task at the same effective priority, which would make an operator's expedite invisible. So a *live* expedite also wins the tie-break ahead of FIFO. An operator who expedites a task expects it to move.

## D5 — Weighted fair queueing by virtual finish time, with P0 as the one exception

§5.2 requires weighted fairness combined with priority and forbids starving low-weight projects. Implemented as classic WFQ: the next project served is the one whose next dispatch lands earliest on the weighted timeline. A weight-5 project gets ~5× the throughput of a weight-1 project, and the weight-1 project is always served because its virtual time stops advancing while it waits.

P0 Emergency bypasses fairness entirely. That is a deliberate hole in the fairness guarantee: "Emergency" that queues behind fair-share accounting is not an emergency. It is bounded by P0 being operator-assigned.

Fairness counters are derived from the execution table inside a rolling window, not held in memory, so a restarted controller resumes the same fairness position (P4-04 + P4-11).

## D6 — Lease is peeked at step 3 and taken at step 9

§5.1 puts the workspace lease check at step 3, before quota and concurrency. Taking the lease there would let a task hold a workspace while it waits on quota five steps later, blocking every other task on that path for no benefit. So step 3 *peeks* and step 9 *acquires*; losing an acquisition race falls back to `WAIT_WORKSPACE`.

Expired leases are reclaimed on acquisition, and the previous owner's execution is marked `BLOCKED` (§5.5) rather than silently overwritten.

## D7 — Immutability enforced by the database

P4-01 requires an append-only EventLog and immutable executions. Both are enforced by SQL triggers, so a bug in application code — or a future maintainer with a repository method — cannot violate them. Finalization stamps `finalized_at`; from then on every UPDATE to that row aborts.

Audit payloads are passed through a redactor before insertion. An audit trail that can absorb a token is a secret leak with good intentions.

## ~~D8 — The AgentOS dispatch contract is left unimplemented on purpose~~ *(tidak lagi berlaku — D12/D13)*

§11 butir 1 requires the assignment/work-item API to be verified against AgentOS 0.7.6 before code is written against it, and POC-1 §17 forbids speculative configuration. Rather than invent a plausible endpoint, `createAgentOSRuntime` requires the path and payload builder to be configured and throws `RuntimeContractUnverifiedError` naming the checklist item otherwise.

This is the difference between "not built yet" and "built wrong and passing tests against my own invention".

**Kenapa gugur:** kontrak itu tidak lagi ditunggu. Dispatch tidak pernah lewat AgentOS sama sekali (D12), melainkan langsung ke Gateway WS (D13). `createAgentOSRuntime` tetap ada sebagai pembaca `/api/snapshot` untuk reconciler — **baca saja**. Prinsip yang melahirkannya tetap berlaku dan justru terbukti berulang kali sesudahnya (D34, D38, D41): jangan menulis kode terhadap kontrak yang belum diverifikasi dengan mengirim permintaan.

## D9 — JSON routing policy instead of YAML

§9 shows `quota.yaml`. JSON is used instead so the controller keeps zero dependencies (Node cannot parse YAML natively, and a YAML parser is a dependency for a config file read once at boot). The structure is identical and converts mechanically. `tests/unit/routing-config.test.mjs` validates the shipped example, so a broken policy fails at `npm test` rather than as an unexplained `WAIT_RESOURCE` in production.

## D10 — Dependency edges are a table

§4 lists a dependency *check* but no dependency storage. Modelled as a relational edge table rather than a JSON blob on the task, so the admission query stays relational and a dependency cycle is visible to the database.

## D11 — Retrofit of POC-2/POC-3 findings (2026-08-19)

Phases 1–3 were written against assumptions the cluster later contradicted. Four changes, each traceable to a measurement:

**Cache tokens are first-class.** POC-3 E8 measured one batch run at 8 fresh input tokens against 92,663 cache reads. `Execution` gained `tokens_cache_read` and `tokens_cache_creation`, and `billableTokens()` includes them. A model counting only input+output was wrong by ~95×. `recordUsage()` normalises both observed shapes — the batch JSON (`input_tokens`/`cache_read_input_tokens`) and the ACP `usage_update` (`used`/`size`/`cost`) — so nothing downstream needs to know which path ran.

**`session_ref` means the harness session, not an OpenClaw key.** `sessions_spawn resumeSessionId` cannot work on the acpx backend, so CONTINUE/FORK resume through ACP `session/load` and the controller is what remembers which session to continue. `executions.create` inherits the most recent non-null `session_ref` for CONTINUE/FORK; FRESH takes whatever the runtime reports for the new session. Dispatch no longer overwrites an inherited ref — doing so would silently turn a resume into a fresh run, the exact false positive POC-3 E3 caught.

**Quota is a scheduling fact, not an error.** `applyQuotaSignal()` turns a 429 into `QUOTA_EXHAUSTED` with the provider's absolute `resetsAt`, the window kind (`five_hour`), and the verbatim message for audit. Dispatch failures carrying a quota signal park the task on `WAIT_QUOTA` with a real ETA instead of `WAIT_RUNTIME`. `credit_class: subscription` now means "a rolling plan window is the constraint", with concurrency as a safety valve rather than the quota.

**`RUNNING → WAIT_HUMAN` is legal.** The permission interposer holds a tool call mid-turn, so a live run can be waiting on a person. Approval returns it to `RUNNING`; rejection moves it to `BLOCKED`. Re-admitting the task would be wrong — there is nothing new to dispatch.

## D12 — CORRECTED: a loopback forwarder does NOT unlock the AgentOS write path

**The first version of this decision was wrong, and the integration test caught it.** It is left here rather than deleted because the mistake is instructive.

The reasoning was: writes need a loopback origin, so forward a local port to the AgentOS service and speak to `127.0.0.1`. Unit tests passed. Against the real AgentOS it failed with a *different* error than the one seen in §11:

```
403 {"error":"Unsafe remote mutation blocked. Forwarded non-local clients
     cannot use AgentOS write APIs.","code":"unsafe-forwarded-client"}
```

Reading the guard settles it. There are two gates in sequence:

```js
if (observedHosts.find(notLocal))           → needs AGENTOS_TRUSTED_OPERATOR_ORIGINS (exact HTTPS origin)
if (xForwardedFor.split(",").find(notLocal)) → "unsafe-forwarded-client"
```

A TCP forwarder fixes the Host and Origin headers but cannot change the socket peer, and AgentOS derives `x-forwarded-for` from it. So the request still arrives as a remote client. **Loopback has to be real, not simulated** — the POC-1 proxy works because it runs *inside* the AgentOS container, where the peer genuinely is 127.0.0.1.

Confirmed by diagnosis: sending `x-forwarded-for: 127.0.0.1` explicitly makes the login return 200. That is not adopted. It defeats precisely the control that exists to stop remote writes, and a control plane whose write path depends on misreporting its own identity is not one worth building.

### Options, for an operator decision

| Option | Cost | Notes |
|---|---|---|
| **Gateway WS instead of AgentOS HTTP** | Medium | Spec §7.2 already permits it ("AgentOS API **atau** Gateway WS dengan token"). The Gateway is built for token auth from other services and POC-1/2 proved it works. Trade-off: dispatch no longer flows through AgentOS |
| TLS + `AGENTOS_TRUSTED_OPERATOR_ORIGINS` | High | The officially supported remote path. Needs a certificate, an exact host match, and `x-forwarded-proto: https` from a real terminator |
| Upstream request to AgentOS | Unknown | A service-token write path. `agentos_api_token` looks intended for this but instance protection and the origin guard override it |
| Spoof `x-forwarded-for` | Low | **Not recommended.** Works, and defeats the control |

Until this is decided, `src/runtime/agentos.mjs` remains correct for everything it can do — health, authenticated reads, snapshot, quota parsing — and dispatch is honestly blocked rather than quietly relying on a bypass.

## ~~D12-original — The AgentOS write path goes through a loopback forwarder~~ *(tidak lagi berlaku — D12, D13)*

POC-4 §11 verified from a separate service on the overlay: `GET /api/operations` returns 200, `POST /api/mission` returns **403** — *"Unsafe remote mutation blocked. Use same-origin localhost or configure an exact HTTPS origin"*. Safe methods bypass the origin guard; writes do not.

The alternative is TLS plus `AGENTOS_TRUSTED_OPERATOR_ORIGINS` with an exact host match, for traffic that never leaves the overlay. Instead the controller forwards a loopback port to the AgentOS service — the same pattern POC-1 already uses for AgentOS → Gateway, so this is an established shape rather than a new one. The port binds to `127.0.0.1` only, because it grants operator-scope access.

Auth is three layers, all verified: session login (`POST /api/auth/login` → `agentos_instance_session` cookie), then that cookie plus `Authorization: Bearer` and `x-agentos-api-token` on every call. A bare token is refused with `401 instance-auth-required`.

## D13 — Gateway WS as the dispatch transport (RESOLVED)

Spec §7.2 permits Gateway WS as the dispatch transport, and D12 made it the recommended one. Implemented in `src/runtime/gateway-ws.mjs` and taken to the live gateway. Three things were learned that no amount of reading would have settled:

**1. A root-level `nonce` is rejected.** The first live handshake returned
`INVALID_REQUEST "unexpected property 'nonce'"`. `ConnectParamsSchema` is a closed object and the connect-challenge nonce belongs inside `device`, which a token-auth client does not send. Removed.

**2. The run method is not `agent.run` on the pinned version.** The 2026.8.1 source calls it `agent.run`; the pinned 2026.6.11 gateway advertises a bare **`agent`** among its 191 methods and no `agent.run` at all. The adapter now negotiates from `hello.features.methods` — newest name first, falling back — and refuses to connect if neither exists. Hardcoding either name would have failed silently against the other version, which is exactly the class of mistake the earlier POC-3 archaeology was about.

**3. Token auth grants role but not scopes.** Handshake succeeds (protocol 4), `hello.auth` reports `{"role":"operator","scopes":[]}`, and dispatch is refused with `missing scope: operator.write`. Requesting `operator.admin` changes nothing: scopes come from **device auth** (`deviceAuthScope`), not from the shared token.

This is the same wall POC-1 hit with AgentOS, and it was solved the same way there: a paired device identity. `docs/poc2-evidence.md` records it — identity files copied into the AgentOS runtime produced `authStatus.native.ok=true` with full operator scopes.

So the controller needs to pair as a device: generate an Ed25519 identity, sign the connect challenge nonce, and have an operator approve the pairing once. That is a deliberate trust decision — the controller becomes a recognised operator device — and it needs a human, so it is the natural stopping point rather than something to improvise.

**Status: RESOLVED 2026-08-21.** The operator approved the pairing, and the thing pairing blocked has now been demonstrated. With the device identity at `/opt/semanggi/volumes/shared/service/semanggios/controller/device-identity.json`, the handshake returns

```
{"role":"operator","scopes":["operator.read","operator.write"],"deviceToken":"wTHM…Cnmw"}
```

and three real dispatches ran to completion on the cluster. Gateway log, unedited:

```
16:34:32 [provider-transport-fetch] response provider=zai model=glm-4.7 status=200 elapsedMs=94144
16:34:32 D13-OK
16:34:32 [agent] run D13-LIVE-1787304777268#1 ended with stopReason=stop
```

`D13-OK` was the exact string the instruction asked for, so this is the model executing the prompt — not merely a queue accepting a frame.

**Idempotency confirmed by the gateway, not just by us.** Re-sending the same `idempotencyKey` returned the *same* `runId` with `status:"in_flight"` instead of `"accepted"`. P4-11's guarantee is therefore enforced on both sides.

## D14 — The `agent` params are narrower than the newer schema, in two ways that matter

D13 negotiated the *method* name correctly but still sent the newer schema's *fields*. The first live dispatch failed with `unexpected property 'cwd'`. Rather than guess again, the accepted field set was measured directly against the pinned gateway by probing one field at a time under a single shared `idempotencyKey` — idempotency means the probes validate without each one becoming a billed model turn.

Accepted: `message`, `agentId`, `idempotencyKey` (**required**), `sessionKey`, `label`, `deliver`, `timeout`, `thinking`.

Two rejections carry design weight:

**1. `cwd` and `workspaceDir` are refused outright.** The workspace is a property of the *agent*, not of the dispatch. The controller therefore cannot aim a task at an arbitrary directory through this method; a per-task workspace requires creating a workspace+agent pair, which is exactly what POC-2 did. `workspacePath` stays in the dispatch handoff for the AgentOS adapter and for the approval bridge, but the Gateway adapter ignores it.

**2. `provider`/`model` return "provider/model overrides are not authorized" under `operator.write`.** This one contradicts a design assumption: §5.3 routing picks a *model* per task, but this transport cannot apply that choice — the agent's configured model wins. Three ways out, none free: escalate to `operator.admin` (a broader trust grant than dispatch needs), pre-create one agent per model and let routing select the *agent* (more config, but the scope stays narrow), or accept per-agent models and drop per-task model routing. Recommended: the second. Flagged rather than silently worked around; `allowModelOverride` defaults to `false` so the intent stays visible in code.

**3. `agent.wait` is a live attach, not a result store.** Called after a run had already finished, it answered `{"status":"timeout","timeoutPhase":"gateway_draining"}` — the run had completed 5 minutes earlier with `stopReason=stop`. So completion cannot be read back from the gateway after the fact, which independently justifies the snapshot-polling reconciler: a controller that restarts mid-run must recover state from its own store plus a snapshot, never by asking the gateway what happened.

### D14 addendum — what "one agent per model" actually costs, and what an upgrade would and would not fix

Two questions came back on the recommendation, and both have measurable answers.

**An agent is a config entry, not a running process.** `openclaw agents list` returns identity, workspace, agent dir, model and routing rules — declarative state, zero cost while idle. What *is* sticky is the **session sandbox**: one container per session key, created on first use and left running afterwards. Measured on the cluster:

```
openclaw-sbx-agent-poc2-e1-poc2-e1-worker-mai-4d63e385
  Status: running   Age: 3d   Idle: 3m 53s
  Session: agent:poc2-e1-poc2-e1-worker:main
```

So one-agent-per-model costs N config entries (free) plus up to N idle containers *once each has actually been used*, reclaimed by `openclaw sandbox prune`. The bound is the number of models — a handful — not the number of tasks. That is a far smaller footprint than the phrase "an agent per model" suggests.

One caveat the same check surfaced: `poc3-e1-poc3-e1-worker` carries `sandbox: {"mode":"off"}`, which is why the D13 dispatches produced no sandbox at all. Correct for POC-3, where the ACP wrapper supplies its own Docker isolation — but it means the D13 runs say nothing about sandbox behaviour, and should not be cited as if they did.

**Upgrading to 2026.8.1 fixes one of the two problems, not both.**

*Workspace: fixed.* `AgentRunRequest` in the 2026.8.1 source declares both `cwd?: string` and `workspaceDir?: string`. The rejection really is a version gap.

*Model override: not fixed.* The gate is authorization, not schema, and it lives in 2026.8.1 itself — `src/gateway/agent-turn/agent-request-preflight.ts:214`, reached from

```ts
function canClientUseModelOverride(client) {
  return hasAdminScope(client) || client?.internal?.allowModelOverride === true;
}
// src/gateway/operator-scopes.ts: export const ADMIN_SCOPE = "operator.admin"
```

Upgrading changes nothing here. Only `operator.admin` opens it, and that grant is much broader than dispatch needs. The two problems are therefore independent and should be decided separately.

*Upgrade risk is lower than expected on the wire, higher off it.* `PROTOCOL_VERSION = 4` and `MIN_CLIENT_PROTOCOL_VERSION = 4` in 2026.8.1, and the running 2026.6.11 gateway already reports protocol 4 — no wire break. The method rename `agent` → `agent.run` is already handled by the negotiation added in D13. The actual cost sits elsewhere: the runbook treats AgentOS and OpenClaw as a single compatibility change set, so an upgrade drags in the custom gateway image (`ARG OPENCLAW_IMAGE`), the ACP wrapper and interposer, and a re-run of the POC-1..3 evidence.

## D15 — The controller has no completion signal, and that is what blocks P4-10

Found by deploying the controller and running a real task end to end. The dispatch works:

```
22:57:21 [model-fetch] start  provider=zai model=glm-5.1
22:57:27 [model-fetch] response status=200 elapsedMs=5851
22:57:27 P410-FRESH-OK
22:57:27 [agent] run TASK-097B0C51#8 ended with stopReason=stop
```

A task created through the controller API was routed, matched to an agent, dispatched over the Gateway WS and answered correctly by glm-5.1. What does **not** work is the other direction: the execution stays `DISPATCHED` forever, because nothing tells the controller the run ended.

Three sources were considered and none of them closes it on the pinned version:

| Source | Why not |
|---|---|
| `agent.wait` | A live attach, not a result store (D14). After the fact it answers `timeout/gateway_draining` for a run that finished cleanly. |
| AgentOS `/api/snapshot` | Covers AgentOS dispatch records. Runs started directly on the Gateway do not appear there. |
| Gateway events | `sessions.subscribe` / `sessions.messages.subscribe` exist and are `operator.read`. **Not yet wired.** |

The consequence is not cosmetic. A task stuck in `DISPATCHED` cannot take a revision — `illegal task transition DISPATCHED -> QUEUED` — so **CONTINUE, FORK and FRESH cannot be exercised through the controller at all**. P4-10 is therefore blocked on this, not on session handling: the session plumbing itself was fixed and unit-tested (`sessionRef` now records the gateway's `sessionKey`, and an inherited ref still wins).

### RESOLVED IN PRINCIPLE 2026-08-21 — `sessions.subscribe` carries everything needed

Tested against the live gateway rather than assumed. One `sessions.subscribe` (no params; it answers `{"subscribed":true}`) is enough — `sessions.messages.subscribe` is a different thing and requires a `key`.

The decisive frame, captured verbatim while a real run finished:

```json
{"type":"event","event":"agent","payload":{
  "runId":"d15-1787330757967",
  "stream":"lifecycle",
  "data":{"phase":"end","startedAt":1787330758327,"endedAt":1787330764140,
          "aborted":false,"stopReason":"stop"},
  "sessionKey":"agent:semanggi-glm-5-1:d15",
  "sessionId":"4ca451bf-9980-4691-ac50-783aefb99b78"}}
```

**`runId` is the `idempotencyKey` we sent, which is the execution id.** That is the missing link: the completion signal ties itself back to the execution without any correlation table.

What the stream provides, measured:

| Need | Where it comes from |
|---|---|
| Terminal signal | `agent` / `stream:"lifecycle"` / `data.phase:"end"`, with `stopReason` and `aborted` |
| Which execution | `payload.runId` — equals our `idempotencyKey` |
| Durable session identity | `payload.sessionId` (a real UUID; better than `sessionKey`, which is only our own naming) |
| Start/end timing | `data.startedAt` / `data.endedAt` |
| Token usage | `session.message` events carry `usage` alongside `provider` and `model` |
| Progress, if wanted | `agent` / `stream:"assistant"` deltas and `chat` `state:"final"` |

Also observed: `sessions.changed` fires on `phase:"start"` and `phase:"end"`, and `health`/`tick`/`presence` arrive continuously — useful as a liveness signal for the subscription itself.

**Implementation shape.** Subscribe once after connect; on `phase:"end"` map `runId` → execution and drive it terminal from `stopReason` (`aborted:true` → CANCELLED, non-`stop` → FAILED, else COMPLETE); record usage from `session.message`; store `sessionId` as `session_ref`. Keep the snapshot reconciler as the slow path, because a subscription that drops between reconnects will miss events — the stream is the fast path, never the only path. The adapter now takes an `onEvent` hook for exactly this, and the listener is wrapped so a fault in it cannot tear down the socket.

This must land before the Slack surface: an operator interface over a control plane that never sees work finish would be actively misleading.

### D15 addendum — implemented, and one thing it exposed

Shipped as `src/runtime/session-events.mjs`, wired in `main.mjs`, and verified on the cluster: a task created through the API now reaches `COMPLETE` on its own.

```
[session-events] subscribed to session events: {"subscribed":true}
[session-events] run TASK-41497D65#1 -> COMPLETE
```

The subscription is re-established on a timer, not just at boot: the gateway forgets it when the socket drops, and a controller that subscribed once would look healthy while receiving nothing. The snapshot reconciler stays as the slow path, so every handler is safe to re-run — a replayed completion against a finalised execution is ignored, not an error.

**What it exposed: FORK and FRESH were not branching.** With completion working, P4-10 could finally run, and all four revisions came back sharing one session id. The cause was ours: `sessionKey` was `agent:<agent>:<task>`, identical for every revision, and on this gateway the key *is* the conversation — there is no `sessionId` parameter to attach to. So the key now encodes lineage (`…:s<sessionRef>` when resuming, `…:r<revision>` otherwise), and FORK no longer inherits a ref.

Re-run live, five revisions on one task:

```
FRESH    rev 1  -> 5fac2dcc-9389-4786-a5d5-fbc950949390
CONTINUE rev 2  -> 5fac2dcc-…   (same)
CONTINUE rev 3  -> 5fac2dcc-…   (same)
FORK     rev 4  -> fde7eeb8-358f-473a-b175-810e47ddb6b9
FRESH    rev 5  -> 58fe0666-b711-4506-bbcd-9dd5ef523aa7
```

**A limitation worth stating plainly: FORK starts an empty conversation, not a copy.** Nothing in this gateway version can clone a session, so "fork" means "new conversation, recorded as descending from the parent" — the parent's history does not come along. Calling that a fork without the caveat would overstate it. If branching with history matters, it needs either an upstream capability or an application-level replay of the parent transcript into the new session.

**Still open: token usage is not being captured.** The completed executions show `tokens 0`. The `session.message` events carry `usage`, but evidently not in the shape or with the `runId` the sink expects. The plumbing (`recordUsage`, cache-aware `billableTokens`, cost in tokens) is tested and correct; the extraction is not yet matching the live payload. This makes cost accounting blind for gateway-dispatched runs and should be the next thing fixed.

## D16 — Reasoning effort for the Claude harness is a different lever entirely

The gateway's `thinking` parameter governs the OpenClaw agent. The Claude harness is a separate process behind ACP and never sees it, so `claude-opus-high` in the routing catalog was, until now, a name with nothing behind it.

Measured inside the sandbox image:

```
--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
```

So opus and sonnet **do** support `medium` and `high` — the tiers the GLM models could not offer. The binary also contains an `"effort"` settings key, and the wrapper already writes `settings.json` into the harness `$HOME` for the Bash gate, so that is where effort now goes.

acpx gives each ACP agent one `command` string and no per-agent environment or arguments, so the mechanism is one thin command per (model, effort) pair — `semanggi-acp-claude-opus` (high) and `-sonnet` (medium) — each setting `SEMANGGI_HARNESS_MODEL` and `SEMANGGI_HARNESS_EFFORT` before handing off to the single real wrapper, which keeps the sandbox, permission gate and mount contract in one place. Verified on the cluster; the wrapper writes:

```json
{ "effort": "high", "permissions": { "ask": ["Bash"], "defaultMode": "default" } }
```

**One more quiet-downgrade trap, closed.** An unrecognised effort is not an error — the CLI warns `Unknown --effort value 'x' — ignoring it and using the default effort` and continues. A typo would therefore reduce effort silently, so the wrapper validates the value against `low|medium|high|xhigh|max` and refuses to start otherwise.

**Not yet proven:** that Claude Code honours the `effort` *settings key* as opposed to only the `--effort` flag. The key and `effortLevel` both appear in the binary, which is suggestive, not conclusive. What is confirmed is that the file is written correctly and the harness starts. Proving the effort actually applied needs a run whose output distinguishes the tiers, and that is worth doing before treating `claude-opus-high` as a quality guarantee.

## D17 — Token accounting: two bugs, and one thing the providers simply do not tell us

`tokens 0` on every completed execution turned out to be two mistakes of mine, both from writing the handler against an assumed payload rather than a measured one.

**1. Wrong correlation key.** `session.message` carries **no `runId` at all** — it has `sessionKey`, `sessionId`, `messageId`, `messageSeq`. Usage was being filed under `payload.runId`, which was always `undefined`, so nothing was ever stored. Usage is now keyed by `sessionKey`, and the lifecycle `end` event (which carries both `runId` and `sessionKey`) closes the loop.

**2. Wrong field names.** None of the Anthropic-style spellings appear on this wire:

```json
"usage": { "input": 10157, "output": 37, "totalTokens": 10322,
           "cacheRead": 128, "cacheWrite": 0, "cost": { "total": 0.01236712 } }
```

(10157 + 37 + 128 = 10322, so `totalTokens` already includes cache reads.) The `input_tokens`/`cache_read_input_tokens` spellings are kept as a fallback because that is genuinely what `claude -p --output-format json` reports on the batch path — two real producers, two shapes.

Verified live after the fix:

```
status: COMPLETE | model zai/glm-5.1
tokens: in 8631  out 60  cacheRead 1664
billable: 10355  | cost 0.010996 usd
```

**3. Not a bug: some providers report nothing.** `google/gemini-3.1-flash-lite` through the OpenAI-compatible path returns a real frame carrying zeros —
`{"input":0,"output":0,"totalTokens":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}` — while `zai/glm-5.1` on the same socket reports real numbers. Recording those zeros would stamp the execution with a confident "0 tokens, $0.00", which reads as *this run was free* rather than *this provider does not tell us*. An all-zero frame is therefore ignored, leaving the fields at their defaults so the difference stays visible.

The practical consequence: **quota and cost forecasting is accurate for zai, and blind for Gemini** (Groq untested). Any budgeting built on these numbers has to treat a zero as unknown, not as free. Fixing it properly means either a provider that reports usage or counting tokens ourselves at the adapter.

**Cost unit follows the credit class.** For metered providers the provider's own `cost.total` is recorded in USD; for a subscription plan it is ignored and cost stays in tokens, because POC-3 E8 established that a Pro plan's USD figure corresponds to no invoice. Tokens remain what the quota window counts either way.

## D18 — Reasoning effort for opus/sonnet: the flag approach is the only one available

Asked directly: can the controller send effort per dispatch, or is `-opus-high` → (model opus, effort high via settings) the mechanism?

**The flag approach is the mechanism, and it is not a workaround — on this version it is the only path.** Three things were tested:

| Attempt | Result |
|---|---|
| `thinking` on the dispatch | Reaches the **OpenClaw agent**, never the harness. The harness is a separate process behind ACP. |
| `agents.create` / `agents.update` with `agentRuntime` | `INVALID_REQUEST "unexpected property 'agentRuntime'"` |
| `config set agents.list[N].agentRuntime` | `Config validation failed: Unrecognized key: "agentRuntime"` |

`AgentRuntimeAcpConfig` with `acp.agent` exists in the 2026.8.1 source, which is why it looked available — it is simply not in 2026.6.11. So per-agent harness selection is a version away, not a scope or API problem.

What works today: one thin command per (model, effort) pair, each setting `SEMANGGI_HARNESS_MODEL` and `SEMANGGI_HARNESS_EFFORT` before handing off to the single real wrapper, which writes them into the harness `settings.json`. Verified: the wrapper produces `{"effort":"high", "permissions":{...}}`.

**The honest caveat about controller control.** The controller picks a *logical model* (`claude-opus-high`), and the catalog names an `acpAgent` for it — but on this gateway nothing binds that name to the dispatch. Which ACP agent actually runs is decided by `acp.defaultAgent` (global) or by the orchestrator naming it when it spawns the session, which is instruction-level and unenforceable. So `acpAgent` in the catalog is **declared intent, not enforced routing**, and it should be read that way until the gateway is upgraded. Enforcing it is exactly what `agentRuntime.acp.agent` would give us.

## D19 — Mengapa GLM butuh plugin, Gemini dan Groq tidak

Pertanyaan operator, dan menjawabnya membalik satu kesimpulan D17.

**Provider generik vs provider berplugin.** OpenClaw punya transport `openai-completions` bawaan. Apa pun yang bicara dialek itu cukup didaftarkan sebagai entri konfigurasi:

```jsonc
"models": { "providers": { "groq": { "baseUrl": "https://api.groq.com/openai/v1", "apiKey": {...} } } }
```

Itulah yang dipakai Gemini (lewat endpoint `/v1beta/openai`) dan Groq. Tidak ada plugin, dan keduanya berjalan.

**Yang disumbang plugin zai** (diperiksa di `dist/index.js` yang terpasang):

| Sumbangan | Bukti |
|---|---|
| Mendaftarkan `zai` sebagai provider dikenal | satu `registerProvider` |
| Katalog model + metadata | `glm-4.7`, `glm-4.7-flash`, `glm-4.7-flashx`, `glm-5`, `glm-5.2` beserta `contextWindow` |
| Parameter khas GLM | `reasoning_effort`, plus `mapThinkingLevelToZaiReasoningEffort()` |

Yang **tidak** disumbangnya: parsing usage (kata "usage" hanya muncul sekali di seluruh bundle). Itu milik inti.

**Konsekuensi yang berlawanan dengan dugaan.** Karena katalog plugin berhenti di `glm-5.2`, model `glm-5.1` dan `glm-5.3` tidak dikenalinya dan jatuh ke profil generik `off/low`. Sementara Gemini dan Qwen — yang justru *tanpa* plugin — mendapat profil dasar penuh `off/minimal/low/medium/adaptive/high`. Jadi di sini plugin **mempersempit**, bukan memperkaya: ia membatasi level ke yang bisa dipetakan ke `reasoning_effort` GLM.

### Koreksi terhadap D17: Gemini bukan tidak melapor — permintaannya yang tidak dikirim

D17 menyimpulkan "provider ini tidak memberi tahu". Salah. Diuji langsung ke endpoint:

```
Gemini non-stream : "usage":{"completion_tokens":4,"prompt_tokens":2,"total_tokens":6}   ← ada
Gemini stream     : chunk terakhir hanya `data: [DONE]`                                   ← tidak ada
Gemini stream + stream_options.include_usage : "usage":{...}                              ← ADA
Groq  stream      : usage disertakan apa adanya                                           ← ada
```

Gateway memakai streaming. Dan di dalam dist-nya:

```js
if (compat.supportsUsageInStreaming) params.stream_options = { include_usage: true };
```

`supportsUsageInStreaming` ditentukan heuristik `provider-model-compat`, yang mematikannya untuk endpoint kustom non-OpenAI — persis kategori `google` kita. Jadi OpenClaw memang **tidak pernah meminta** usage-nya.

Bisa dikonfigurasi, dan sudah diperbaiki:

```jsonc
"models": { "providers": { "google": { "models": [
  { "id": "gemini-3.1-flash-lite", "name": "Gemini 3.1 Flash Lite",
    "compat": { "supportsUsageInStreaming": true } } ] } } }
```

Terbukti hidup sesudahnya: `google/gemini-3.1-flash-lite … in 10804 out 12 billable 10816`. (Cost tetap 0 karena lapisan compat Gemini hanya mengembalikan jumlah token, bukan angka biaya — dan token yang menjadi dasar kuota, jadi itu memadai.)

**Groq tidak perlu flag ini** — streamnya sudah menyertakan usage. Saya sempat menambahkannya juga, dan itu **merusak**: mendeklarasikan entri model eksplisit menggantikan metadata auto-deteksi, sehingga level thinking `sem-qwen` menyusut dari `off/minimal/low/medium/high` menjadi `["off"]`. Task `qwen-medium` lalu ditolak — yang benar menurut P4-03, tetapi penyebabnya adalah konfigurasi saya sendiri. Entri Groq dikembalikan. Pelajarannya: **entri model eksplisit itu pengganti, bukan tambahan** — deklarasikan hanya bila memang perlu, dan periksa ulang level thinking sesudahnya.

## D20 — Dispatch yang ditolak gateway setelah lease diambil menyumbat antrean

Ditemukan sebagai akibat kesalahan di atas. Ketika run ditolak (`UNAVAILABLE: Model override … is not allowed`), eksekusi tetap `DISPATCHED` dan **lease workspace-nya tertahan**, sehingga task berikutnya di project itu parkir `WAIT_WORKSPACE` selamanya.

Sebabnya struktural: sejak D15, status terminal datang dari event `agent` lifecycle `end`. Run yang tidak pernah benar-benar mulai tidak pernah mengirim event itu. Reconciler yang seharusnya menjadi jalur lambat digerakkan oleh `/api/snapshot` AgentOS — yang **tidak melihat run Gateway sama sekali** (D15). Jadi saat ini tidak ada jalur waktu-habis untuk eksekusi `DISPATCHED` yang macet.

Yang dibutuhkan, dan belum ada:

1. **Timeout dispatch.** Eksekusi yang `DISPATCHED` lebih lama dari ambang tanpa event apa pun harus dijadikan `BLOCKED` dan lease-nya dilepas. Reconciler sudah punya konsep `staleAfterMs`; ia hanya perlu sumber yang melihat run Gateway.
2. **Perlakukan penolakan sinkron sebagai kegagalan dispatch.** Error respons pada `agent` seharusnya langsung melepas lease alih-alih menunggu event yang tidak akan datang.

Sampai itu ada, satu dispatch yang ditolak membekukan seluruh project. Ini prioritas tertinggi berikutnya — di atas Slack dan UI.

## D20 addendum — terpasang, dan asal-usulnya ternyata lebih dalam

Watchdog dispatch terpasang di `scheduler.mjs` dan terbukti bekerja di cluster: dua task yang menggantung berpindah ke `BLOCKED` dan lease-nya dilepas, `leases: []` tercapai.

Dua hal yang ditemukan saat memasangnya, keduanya mengoreksi diagnosis awal:

**1. Penolakan sinkron sudah benar sejak awal.** Dugaan pertama menyalahkan jalur itu; ternyata `admission` memang sudah melepas lease dan menandai eksekusi `FAILED`. Perilaku itu tetap dikunci dengan tes karena load-bearing, tetapi ia bukan penyebabnya.

**2. Kondisi sapuan lease yang pertama salah.** Versi awal melepas lease bila eksekusi pemiliknya `finalized_at`-nya terisi. Tetapi `BLOCKED` **sengaja bukan status terminal** — ia tetap bisa dilanjutkan — sehingga field itu tidak pernah distempel, dan sapuan berjalan melewati eksekusi BLOCKED yang masih memegang lease. Terlihat langsung di cluster. Kondisinya sekarang "tidak sedang berjalan" (bukan DISPATCHED/RUNNING), yang sesuai dengan alasan lease itu ada: mencegah dua eksekusi RUNNING berbagi path (P4-07).

## D21 — Gateway menjawab satu permintaan dua kali, dan itu sumber kebuntuan D20

Ini akar yang sebenarnya, ditemukan setelah dispatch qwen berulang kali menggantung meski routing-nya benar.

Log dispatch yang ditambahkan membuktikan controller memilih dengan tepat:

```
[dispatch] task=TASK-7E7E201F routed=groq/qwen/qwen3.6-27b@medium -> agent=sem-qwen (groq/qwen/qwen3.6-27b) exact
```

Tanpa override, agen benar. Namun gateway menolak:

```
res ✗ agent errorCode=UNAVAILABLE
  Thinking level "medium" is not supported for zai/glm-4.7. Use one of: off, on.
```

Dua temuan terpisah di sini.

**a. Gateway menjawab dua kali.** Klien kita menerima `{"status":"accepted"}` — probe pun mencetak "HASIL: accepted" — sementara gateway mencatat `res ✗` untuk `runId` yang sama. Promise sudah diselesaikan oleh frame pertama, jadi frame kedua jatuh ke lantai. Eksekusi lalu duduk `DISPATCHED` tanpa ada yang akan menyelesaikannya. **Itulah asal kebuntuan D20**, dan itu juga sebabnya probe manual saya tampak "berhasil" padahal tidak: saya mempercayai frame pertama.

Adapter kini memunculkan frame kedua sebagai event `gateway.late-error` alih-alih membuangnya. Promise yang sudah selesai tidak bisa dibatalkan, jadi watchdog tetap menjadi jaring pengaman — tetapi kegagalannya tidak lagi tak terlihat.

**b. `thinking` divalidasi terhadap model yang salah.** Errornya menyebut `zai/glm-4.7` — model default — padahal dispatch menyebut `sem-qwen` yang bermodel `groq/qwen/qwen3.6-27b`. Jadi untuk provider groq, gateway tidak dapat menyelesaikan profil thinking model tersebut dan jatuh ke default. Akibatnya **level thinking bertingkat pada groq selalu ditolak**, meskipun `agents.list` mengiklankan `off/minimal/low/medium/high` untuk agen itu.

Konsekuensi yang jujur: **iklan `thinkingLevels` tidak bisa dipercaya untuk provider tanpa plugin.** Katalog karena itu tidak lagi menyebut level untuk qwen. Setelah itu, dispatch berhasil:

```
TASK-5F2F664B  COMPLETE | groq/qwen/qwen3.6-27b | in 10408 out 6 | billable 10414
```

Gemini belum diuji dengan `thinking` eksplisit lewat controller; kalau nanti gagal dengan pesan yang sama, penyebabnya sama dan penanganannya sama.

## D22 — Lease baca/tulis: workspace tidak perlu bergiliran untuk pekerjaan yang hanya membaca

Pertanyaan operator: kalau satu workspace per project, apakah task dokumentasi harus mengantre di belakang task coding?

Jawabannya: hanya kalau ia menulis. Lease itu melindungi **tulisan bersamaan** ke satu pohon, bukan keberadaan task. Sebelumnya setiap dispatch mengambil lease eksklusif tanpa peduli jenisnya, jadi satu project menjadi serial sepenuhnya.

Sekarang:

| Mode | Aturan |
|---|---|
| `write` | eksklusif — ditolak selama ada lease hidup apa pun |
| `read` | berbagi — ditolak hanya selama ada **penulis** hidup |

`workspace_mode` default **`write`**. Berbagi harus diminta, tidak boleh didapat karena kelalaian — dan saya sengaja tidak menebak kategori mana yang aman (dokumentasi sering menulis, analisis sering tidak). Itu keputusan per task, bukan per nama kategori.

Perubahan yang menyertainya, karena keduanya salah begitu satu path bisa dipegang beberapa pemegang:
- Primary key lease menjadi `(workspace_path, execution_id)`, dengan migrasi eksplisit untuk DB yang sudah ada — `CREATE TABLE IF NOT EXISTS` tidak mengubah tabel yang sudah jadi, jadi tanpa migrasi perubahan ini tidak berlaku di satu pun deployment yang benar-benar berjalan.
- `release(path)` dulu menghapus **semua** baris path itu. Dengan pembaca bersama, itu mengusir pekerjaan yang belum selesai. Sekarang ia melepas satu pemegang, dan menolak menebak bila ada beberapa pemegang tanpa `executionId`.

P4-07 tidak berubah: dua penulis tetap tidak pernah RUNNING bersamaan.

## D23 — Empat celah dari tinjauan adversarial

Empat hal yang tidak ditemukan oleh pengujian normal karena semuanya gagal **dengan diam**.

### 1. Lease tidak pernah diperpanjang — **paling berbahaya**

`leases.heartbeat` ada di repository sejak awal dan **tidak pernah dipanggil dari mana pun**. Dengan TTL lease 15 menit dan timeout dispatch 30 menit, setiap run yang lebih lama dari 15 menit — hal biasa untuk model penalaran yang mengerjakan sesuatu yang nyata — kehilangan workspace-nya **saat masih berjalan**. Task berikutnya lalu mereklamasi path itu, menandai eksekusi yang masih hidup sebagai BLOCKED, dan mulai menulis ke pohon yang sama.

Itu persis kerusakan tulis-bersamaan yang menjadi alasan P4-07 ada, dan nilai default membuatnya menjadi kasus normal, bukan kasus tepi.

Sekarang setiap pass scheduler memperpanjang lease milik eksekusi yang benar-benar masih DISPATCHED/RUNNING — dan hanya itu, sehingga eksekusi mati tidak bisa menahan path. `main.mjs` juga memperingatkan bila TTL terlalu rapat terhadap interval pass.

### 2. Path workspace bisa keluar dari pohon

`/opt/semanggi/../../etc` diterima. Kontrak mount adalah host == container, jadi path yang menembus mengarahkan agen sungguhan ke direktori sungguhan di luar root kanonik. Path relatif juga diterima, dan itu menghasilkan agen yang bekerja di tempat yang tidak ada. Keduanya kini ditolak, dengan `SEMANGGI_WORKSPACE_ROOT` opsional untuk memaku prefiks yang diizinkan.

### 3. Instruksi tanpa batas ukuran

Deskripsi 2 MB diterima dan akan dikirim ke provider apa adanya — denial-of-wallet dengan satu permintaan. Batas 64 KB sekarang berlaku, dan **menolak** alih-alih memotong: memotong berarti mengirim setengah instruksi lalu menagihnya.

### 4. Bentuk usage tak dikenal disimpan sebagai nol

`recordUsage` menerima bentuk apa pun dan menulis nol untuk field yang tidak dikenalinya. Itu persis kegagalan yang menyembunyikan D17 selama satu siklus penuh, karena "0 token" terbaca sebagai fakta, bukan sebagai "tidak ada yang memberi tahu kami". Sekarang ia mengerti **kedua** ejaan produsen (batch dan gateway) dan menolak bentuk yang benar-benar asing.

## D24 — Logging terstruktur, dan celah yang langsung ditemukannya

Satu baris JSON per peristiwa, dari `admission`, `scheduler`, `repo`, `gateway`, dan `session-events`. Setiap baris membawa `task` dan `exec`, dan keduanya adalah id yang sama yang muncul di gateway (`runId` = `idempotencyKey` = id eksekusi; `label` = id task) dan di nama kontainer sandbox. Jadi `grep TASK-XXXX` melintasi ketiga lapisan merekonstruksi hidup satu task.

Yang tercatat: model dan effort yang **benar-benar** dipakai, agen yang dipilih dan lewat jalur mana (exact/override), project dan workspace yang dibuat, setiap perubahan status task beserta alasannya, parkir karena kuota beserta waktu resetnya, lease diambil/ditolak/yatim, dan timeout dispatch. Redaksi kredensial sama ketatnya dengan EventLog, ditambah pemotongan string panjang.

**Dan dalam satu menit setelah dinyalakan, log itu menemukan celah kelima:** satu task berada di **eksekusi ke-582**, berputar `QUEUED → WAIT_RESOURCE` setiap 30 detik selamanya, menulis satu baris eksekusi immutable setiap kali dan mengaduk lease setiap kali.

Penyebabnya: `next_retry_at` **ditulis tetapi tidak pernah dibaca** — field itu tampak seperti rencana sementara scheduler mencoba ulang di setiap pass. Sekarang backoff eksponensial berlaku (30 detik → 15 menit), dijadwalkan dari kegagalan terkini, dan scheduler benar-benar mematuhinya. Terukur setelah deploy: dari tiap 30 detik menjadi **satu percobaan per dua menit** dan terus melebar.

Backoff sengaja hanya berlaku untuk percobaan **otomatis**. Keputusan manusia, revisi, atau lease yang dibebaskan langsung menghapusnya — membuat operator menunggu backoff yang bukan urusannya akan terbaca seperti keputusannya diabaikan.

## D25 — Lease dipegang sepanjang eksekusi, bukan hanya saat menulis

Pertanyaan operator, dan jawabannya tegas dari kode: lease diambil di `admission` tepat sebelum dispatch, dan hanya dilepas saat run berakhir (event `end`), saat dispatch gagal, atau saat watchdog mereklamasinya.

Jadi untuk dua task `write` pada satu workspace: **task A berjalan sampai selesai, baru task B mulai.** Bukan "keduanya jalan lalu bergiliran saat menulis".

Alasannya bukan kemalasan desain melainkan batas informasi: controller tidak melihat operasi tulis satu per satu. Agen menulis di dalam sandbox/sesinya sendiri, dan satu-satunya batas yang terlihat controller adalah dispatch dan akhir run. Mengunci di antara keduanya berarti mengunci seluruhnya.

Konsekuensi yang harus diterima dengan mata terbuka: run 10 menit memblokir run 10 detik. Yang meringankan:

- Task yang hanya membaca memakai `workspaceMode: "read"` dan berjalan bersamaan (D22).
- Task yang benar-benar butuh isolasi bisa menetapkan `workspace_path` sendiri dan tidak bersaing sama sekali.

**Apakah penguncian halus mungkin?** Secara teknis ada jalannya, dan jujur saja bukan jalan yang mudah: interposer izin sudah melihat setiap tool call, termasuk `kind: "edit"`. Ia bisa mengambil dan melepas kunci di sekitar setiap tulisan. Tetapi itu memindahkan kunci ke jalur panas per-tool-call, memperkenalkan risiko deadlock antara dua agen yang saling menunggu, dan membuat kegagalan jauh lebih sulit ditelusuri. Saya tidak menyarankannya kecuali serialisasi terbukti menjadi hambatan nyata dalam pemakaian sehari-hari — dan itu baru bisa dinilai setelah sistem dipakai.

## D26 — Menyetop task, mengganti model, lalu menjalankannya lagi

Awalnya saya salah membaca permintaan operator sebagai "menyetok" (menumpuk pekerjaan untuk nanti) dan membangun `hold: true`. Yang dimaksud adalah **menyetop**: menghentikan task yang sedang berjalan, mengganti model dan effort, lalu menjalankannya kembali. Itu hal yang berbeda, dan sebelumnya **tidak ada jalannya sama sekali**:

- `PATCH` menolak task yang sedang `DISPATCHED`/`RUNNING`.
- `cancel` membawa ke `CANCELLED`, dan di state machine `CANCELLED: []` — buntu, sengaja. Itu benar untuk "tinggalkan ini", salah untuk "jeda dulu".

Jalur yang benar ternyata sudah ada di state machine dan belum dipakai: `BLOCKED → RESUMABLE → QUEUED`. Jadi `POST /api/work/tasks/{id}/stop` menghentikan run di gateway lalu memarkir task di `BLOCKED`, dan `createRevision` merutekan lewat `RESUMABLE` supaya jeda itu tetap terlihat di riwayat, bukan seolah tidak pernah berhenti.

**Kontrak abort, diukur:** `sessions.abort` menerima `key` (sessionKey) dan menjawab `{ok, abortedRunId, status}`, dengan `status:"no-active-run"` bila tidak ada yang dihentikan. Perbedaan itu dipertahankan apa adanya di respons API — task yang ditandai berhenti sementara run-nya masih jalan adalah kebohongan yang akan ditindaklanjuti operator.

### Urutan yang salah menghabiskan satu run untuk ditemukan

Percobaan pertama gagal `500`. Sebabnya halus: **abort yang kita minta sendiri kembali sebagai event.** Gateway mengirim lifecycle `end` dengan `aborted: true`, sink membacanya — dengan benar — sebagai pembatalan, memindahkan task ke `CANCELLED` yang buntu, lalu handler stop gagal karena mencoba memarkir task yang sudah mati.

Perbaikannya urutan, memakai jaminan yang sudah ada: **finalisasi eksekusi lebih dulu, baru abort.** Sink melewati eksekusi yang sudah final, jadi event abort mendarat tanpa efek dan niat operator — jeda, bukan buang — yang bertahan.

Terbukti hidup pada run yang benar-benar sedang berjalan:

```
1) dibuat TASK-27768FEB status DISPATCHED
2) sedang berjalan: DISPATCHED | session agent:semanggi-glm-5-1:task-27768feb:r1
3) STOP 200 {"wasLive":true,"abortedAtGateway":true,"gatewayStatus":"aborted"} -> BLOCKED
4) ganti model: 200 {"preferred":["glm-5.2-max"]}
5) jalankan lagi: 200 -> DISPATCHED
6) hasil: COMPLETE | zai/glm-5.2 | billable 10366
riwayat: 1:CANCELLED 2:COMPLETE
```

Riwayat eksekusinya jujur: percobaan pertama tercatat CANCELLED (memang dihentikan), yang kedua COMPLETE pada model baru.

## D26b — Kontrol manual atas model dan effort

Pertanyaan kedua: bisakah operator menentukan sendiri model dan effort, atau menyetok task lalu menggantinya sebelum dijalankan?

Sebagian sudah bisa sejak awal, sebagian tidak — dan yang tidak itu ketahuan saat mencobanya di cluster: PATCH ditolak `400` karena scheduler sudah men-dispatch task itu **sebelum operator sempat mengubah apa pun**. Menyetok pekerjaan memang belum mungkin.

Yang ada sekarang:

| Kebutuhan | Cara |
|---|---|
| Pilih model + effort saat membuat | `modelPolicy: { preferred: ["glm-5.2-max"] }` — mengalahkan tabel kategori |
| Menyetok tanpa menjalankan | `hold: true` → task berhenti di `CREATED` dan scheduler tidak pernah mengambilnya |
| Ubah rencana sebelum jalan | `PATCH /api/work/tasks/{id}` — `modelPolicy`, `priority`, `qualityClass`, `workspaceMode` |
| Lepaskan ke antrean | `POST /api/work/tasks/{id}/start` |
| Jalankan ulang di model lain | `POST /api/work/tasks/{id}/revisions` dengan `modelPolicy` — satu panggilan |
| Lihat pilihan sebelum menjalankan | `POST /api/work/routing/preview` — kandidat terurut beserta ketersediaannya |

`PATCH` **ditolak** saat task sedang `DISPATCHED`/`RUNNING`. Mengubah routing run yang sedang terbang akan membuat catatan tidak sesuai dengan yang benar-benar berjalan, dan baris eksekusi memang immutable justru karena itu.

Terbukti hidup, satu task, dua model berurutan:

```
dibuat TASK-FD79D928 status: CREATED model: {"preferred":["glm-5.1-on"]}
PATCH 200 -> {"preferred":["glm-5.2-max"]}
lepaskan ke antrean: 200
hasil: COMPLETE | zai/glm-5.2 | billable 10344

revisi 200 (modelPolicy: glm-5.1-on)
hasil: COMPLETE | zai/glm-5.1 | billable 10338
```

Dan log routing membuktikan effort ikut terbawa, bukan sekadar model:

```
routedModel=glm-5.2 routedEffort=max  -> agent=semanggi-glm-5-2 efforts=[off,low,high,max] via=exact
routedModel=glm-5.1 routedEffort=low  -> agent=semanggi-glm-5-1 efforts=[off,low]          via=exact
```

## D27 — Aplikasi Slack: tanda tangan wajib, identitas per orang, konfirmasi sebelum menghentikan

Tiga pilihan Anda — **Slack dulu**, **token per operator**, **kontrol penuh** — saling mengikat, dan kombinasinya menentukan hampir seluruh bentuk implementasi ini.

**Kontrol penuh membuat verifikasi tanda tangan menjadi syarat, bukan pelengkap.** Endpoint Slack bisa membuat, menghentikan, dan mengganti model task. Tanpa verifikasi, siapa pun yang bisa melakukan POST ke URL itu bisa menyamar sebagai operator mana pun dan melakukan semuanya — dan model identitas per operator berubah jadi hiasan. Karena itu:

- HMAC-SHA256 atas **byte mentah** badan request (`v0:<ts>:<raw>`). Rute Slack membaca body-nya sendiri; mem-parsing lalu menyusun ulang form akan mengubah byte dan menggagalkan semua tanda tangan.
- Jendela lima menit dengan selisih **absolut** — request dari masa depan sama mencurigakannya dengan yang basi.
- Tanpa rahasia terkonfigurasi, semua request ditolak. Gagal tertutup adalah satu-satunya default yang jujur untuk permukaan yang bisa menghentikan pekerjaan.

**Identitas datang dari Slack user id, dan tidak ada pendaftaran otomatis.** Slack menandatangani `user_id`, jadi itulah yang dipercaya — bukan `decided_by` dari badan request. Operator yang belum terdaftar **ditolak**, bukan diperlakukan sebagai "aplikasi Slack". Kalau pendaftaran otomatis diizinkan, siapa pun di workspace bisa memberi dirinya identitas dengan mengetik satu kata, dan jejak audit berhenti menunjuk orang.

**Verba yang menghentikan pekerjaan selalu bertanya lebih dulu.** Kanal Slack adalah tempat orang mengetik cepat, kadang di jendela yang salah. Pertanyaannya membacakan kembali task yang persis akan dihentikan beserta statusnya, jadi `yes` hanya bisa mengiyakan hal yang barusan disebutkan. Konfirmasi disimpan di memori, milik satu orang, kedaluwarsa dua menit — konfirmasi yang selamat dari restart adalah konfirmasi yang tidak diingat siapa pun.

`ok` sengaja diperlakukan berbeda dari `yes`: ia menjawab pertanyaan yang menggantung bila ada, dan selebihnya kembali menjadi kata yang router baca sebagai `approve`. Jadi satu kata tidak bisa sekaligus mengonfirmasi penghentian dan menyetujui sesuatu yang lain.

**`model` bekerja dengan nama katalog, dan ambiguitas ditolak.** `glm-5.2 high` → `glm-5.2-high`. `glm-5.2` saja **ditolak** karena katalog menyediakan `high` dan `max`; memilihkan salah satunya berarti operator meminta model lalu mendapat level effort yang tidak pernah ia sebut — kelas kejutan yang sama dengan silent downgrade yang dilarang P4-03. Nama yang tidak ada ditolak seketika beserta daftar pilihan, bukan diterima lalu memarkir task di `WAIT_RESOURCE`.

### Celah yang ditemukan justru saat pembuktian hidup

Task pertama yang dibuat dari Slack masuk antrean dengan rapi lalu **duduk selamanya di `WAIT_WORKER`** dengan alasan `no worker assigned`. Ternyata admission hanya **memeriksa** penugasan worker, tidak pernah **membuatnya** — dan setiap permukaan lain mengirim `workerId` di badan request, sementara Slack tidak punya tempat untuk mengetiknya. Dari sisi operator, itu terbaca sebagai sistem yang diam-diam mengabaikannya.

Sekarang Slack memilih worker paling ringan yang punya akses ke project itu, dan bila tidak ada satu pun yang aktif ia **menolak mengantrekan** alih-alih memarkir pekerjaan yang tidak akan pernah bergerak.

### Terbukti hidup di cluster

Image `2026082208`, 16 pemeriksaan dijalankan dari dalam container terhadap HTTP sungguhan, semuanya lulus:

```
PASS  a wrongly signed request is refused                          — status 401
PASS  a stale timestamp is refused                                 — status 401
PASS  a correctly signed request is served                         — status 200
PASS  an unregistered Slack user is refused despite a valid signature
PASS  a task is created from Slack   — Queued `TASK-DAC41B62` … _(Slack Probe)_
PASS  the task got a worker          — DISPATCHED worker=WRK-79E86D0B
PASS  stop asks for confirmation first
PASS  nothing changed while the question was outstanding           — DISPATCHED
PASS  confirming stops it            — the run was aborted at the gateway
PASS  the task is BLOCKED, not CANCELLED
PASS  an unknown model is refused with the real choices
PASS  the model is changed           — zai/glm-5.1 at low (`glm-5.1-on`)
PASS  it runs again
```

Dan lingkaran penuhnya selesai sendiri sesudahnya:

```
DISPATCHED -> BLOCKED   actor="Slack Probe" reason="stopped from Slack"
slack.task-stopped      wasLive=true abortedAtGateway=true
slack.model-changed     catalog=glm-5.1-on
BLOCKED -> RESUMABLE -> QUEUED -> DISPATCHED
run.ended               zai/glm-5.1 stopReason=stop durationMs=8105 -> COMPLETE
```

Perhatikan `actor` di setiap baris: bukan "slack", bukan "controller", melainkan nama orangnya.

### Yang belum

Socket Mode belum diimplementasikan, jadi Slack tetap butuh URL yang bisa dijangkau internet. Controller sengaja tidak mem-publish port, jadi jalur yang disarankan adalah reverse proxy yang hanya meneruskan dua path Slack. Kalau paparan publik jadi masalah, Socket Mode adalah langkah berikutnya yang benar — bukan membuka lebih banyak port.

## D28 — AgentOS memelihara cermin agent sendiri, dan cermin itu sudah basi

Pertanyaannya: kalau UI Semanggi memotong AgentOS dan langsung ke OpenClaw, apakah agent-nya sama?

**Secara desain: ya.** `lib/agentos/control-plane.ts` mendelegasikan CRUD agent ke `lib/openclaw/application/agent-service`, yang menulis lewat RPC gateway (`config.patch`/`apply`/`set`, dengan fallback CLI). AgentOS bukan registry terpisah — ia UI manajemen di atas registry OpenClaw. Keduanya menunjuk gateway yang sama (`openclaw-gateway:18789`).

**Secara nyata: tidak.** Diukur dengan login sebagai admin lalu memanggil API AgentOS dari dalam containernya:

```
login: 200
/api/agents → HTTP 200, 15 agent
agent semanggi terlihat: 0
```

Lima belas agent lama POC-2/POC-3. Nol agent Semanggi — padahal config gateway memuat 24 agent, sembilan di antaranya milik controller (`semanggi-glm-5-1`, `sem-gemini`, `sem-qwen`, `sem-glm-5-3`, dan empat agent per-task).

Penyebabnya: AgentOS memelihara cermin lokal di `agentos/runtime/openclaw/openclaw.json`, dan itulah yang dibaca UI-nya. Controller menulis agent langsung ke gateway — melewati AgentOS — sehingga cermin itu tidak pernah tahu. Cermin itu juga sudah melenceng di tempat lain: lima agent yang ada di kedua file menyimpan model berbeda (`glm-4.7` vs `glm-4.7-flash`), dan cermin punya entri hantu `main`.

**Konsekuensi untuk UI operator.** Halaman Agents AgentOS akan menampilkan daftar yang sepenuhnya berbeda dari yang menjalankan pekerjaan, tanpa tanda apa pun bahwa ia basi. UI Semanggi karena itu **membaca agent dari controller** (live dari `agents.list` gateway), bukan dari snapshot AgentOS, dan melabelinya eksplisit agar perbedaannya terlihat disengaja.

Tiga kata yang jangan tertukar: **Agent** (entitas runtime di gateway), **worker profile** (metadata yang menempel pada agent, milik AgentOS), dan **Worker** (baris `WRK-…` milik controller: akses project dan batas konkurensi, tidak ada di OpenClaw).

## D29 — `available: []` bukan soal model, dan tiga task tersangkut karena rencana, bukan kegagalan

Log `resource.no-agent … model=glm-5.2 available=[]` saya baca keliru. `available` adalah daftar agent yang **terikat pada workspace yang sama**, bukan daftar model. Pesan lengkapnya:

```
TASK-6C8F61E3 | WAIT_RESOURCE
   task ws : …/workspaces/semanggi/executions/T1/executions/TASK-6C8F61E3
   proj ws : …/workspaces/semanggi/executions/T1
   alasan  : no any agent for …/executions/T1/executions/TASK-6C8F61E3
```

Task itu punya workspace per-task bersarang; semua agent terikat satu tingkat di atasnya. Modelnya tidak pernah jadi soal — `no any agent` berarti pencarian bahkan tidak menyaring model.

Ketiga task tersangkut ternyata **kesalahan rencana, bukan kegagalan**, dan tidak satu pun bisa diperbaiki lewat endpoint mana pun:

| Task | Sebab | Perbaikan |
|---|---|---|
| `TASK-6C8F61E3` | workspace per-task tanpa agent | arahkan ke workspace yang punya agent |
| `TASK-18877228` | worker tanpa akses project | pindahkan ke worker yang punya akses |
| `TASK-41ABFDE6` | sisa probe Slack | dibatalkan |

Karena tidak ada jalurnya, satu-satunya cara keluar adalah `UPDATE tasks SET …` dengan tangan — dan itu justru perbaikan yang tidak bisa ditanggung sistem yang jejak auditnya append-only: baris yang disunting tangan membuat log menceritakan sejarah yang tidak pernah terjadi. Jadi `PATCH /api/work/tasks/{id}` diperluas dengan `workspacePath` dan `workerId`, keduanya menerima `null` (workspace kembali ikut project, worker dilepas).

`workerId` **menolak di muka** worker yang tidak punya akses ke project task, alih-alih membiarkan admission memarkirnya di `WAIT_WORKER` dengan alasan yang sama beberapa detik kemudian. Operatornya sedang berdiri di situ; memberitahunya sekarang lebih murah daripada menunggu yang harus ia diagnosis sendiri.

### Celah yang ditemukan saat memperbaiki

Perbaikan pertama tampak tidak berpengaruh. Penyebabnya: **perubahan rencana tidak mengatur ulang backoff**. Terukur di cluster — workspace sudah dibetulkan, tapi task masih menyimpan 658 detik di penghitungnya dan `wait_reason` lama masih terpampang.

Premis backoff (D24) adalah "tidak ada yang berubah, jangan diketuk terus". Manusia yang menyunting rencana adalah persis keadaan itu berubah. Jadi `updatePlan` sekarang menghapus `next_retry_at` dan `wait_reason` — alasan lama menggambarkan keputusan di bawah rencana yang sudah tidak ada, dan membiarkannya di layar adalah kebohongan kecil yang tidak bisa dibedakan operator dari yang sungguhan. Rute `PATCH` juga membangunkan scheduler.

Terbukti hidup, image `2026083002`:

```
sebelum : WAIT_RESOURCE | retry 658s lagi
PATCH 200
seketika: WAIT_RESOURCE | retry (dihapus) | alasan (dihapus)
+5s     : DISPATCHED
run.ended  zai/glm-5.2  stopReason=stop  durationMs=6304  -> COMPLETE
```

Antrean tunggu sekarang kosong.

## D30 — Upgrade ke 2026.7.1: berhasil, tetapi dua janji utamanya tidak terbukti

Upgrade dijalankan 2026-08-30. Gateway `semanggi/openclaw-gateway:2026083001` di atas `ghcr.io/openclaw/openclaw:2026.7.1`.

**Yang selamat tanpa cedera:** pairing device controller (`operator.admin`), `secrets audit: clean`, kesembilan agen Semanggi, plugin `acpx` dan `zai` yang keduanya masih pin 6.11 dan tetap termuat, dan `sessions.subscribe` yang langsung tersambung kembali. Backup 6,8 MB (state kritis tanpa `npm`) diverifikasi `integrity_check: ok` sebelum apa pun disentuh — 3,1 GB dari 3,2 GB itu ternyata plugin npm yang bisa dipasang ulang.

**Yang tidak terbukti — dan ini membantah rekomendasi saya sendiri di `upgrade-openclaw.md`:**

| Janji dokumen upgrade | Kenyataan di 7.1 |
|---|---|
| `workspaceDir` per dispatch | `unexpected property 'workspaceDir'` — **tetap ditolak** |
| `agentRuntime.acp.agent` menegakkan pilihan harness | `unexpected property 'agentRuntime'` — **tetap ditolak** |

Dokumen itu menyimpulkan keduanya tersedia dari **jumlah berkas di `dist` yang menyebut namanya** (369 → 384 dan 56 → 93). Di dokumen yang sama saya menulis bahwa jumlah berkas bukan bukti — dan peringatan itu ternyata berlaku untuk rekomendasi saya sendiri. Satu-satunya bukti adalah mengirim parameternya dan melihat jawabannya. **D14 dan D18 karena itu tetap berlaku utuh:** workspace tetap properti agen, dan `acpAgent` di katalog tetap niat yang dideklarasikan, bukan routing yang ditegakkan.

**Perubahan skema yang senyap:** `deliver` kini wajib **boolean**; 6.11 menerima string. Adapter kita kebetulan sudah mengirim `deliver: false`, jadi jalur dispatch selamat — tetapi klien mana pun yang mengirim `"none"` akan patah tanpa peringatan.

**Yang justru didapat, dan tidak ada di daftar harapan:** 218 metode (dari 191), termasuk `sessions.messages.subscribe`, `sessions.compaction.branch` (kandidat solusi untuk "FORK tidak membawa riwayat"), `agents.update`, dan `agents.workspace.list`. Doctor juga memasang `@openclaw/groq-provider` sendiri.

**Gerbang izin gagal, tetapi bukan karena upgrade.** `permission-bridge-verify.sh` FAIL di kasus 1. Ditelusuri sampai kredensial harness: `api_error_status: 429`, `"You've hit your session limit · resets 12:30pm (UTC)"`. Kuota langganan Claude, bukan regresi 7.1. **Harus diuji ulang setelah kuota pulih** — sampai itu, status jalur ACP di 7.1 belum diketahui.

## D31 — Effort: terbukti berlaku untuk GLM, terbukti hiasan untuk Gemini, berbahaya untuk Qwen

Pertanyaannya bukan "apakah gateway menerima `thinking`" — ia menerima. Pertanyaannya apakah level itu **mengubah perilaku**. Satu-satunya bukti adalah perilaku: prompt sama, model sama, hanya level berbeda.

Sampel tunggal ternyata **menyesatkan**. Percobaan pertama membaca glm-5.2 sebagai `low ≡ high ≡ max` (247/242/241 token). Diulang n=3, gambarannya terbalik:

```
semanggi-glm-5-2   off  rata-rata 137  (106–194)
                   low            217  (179–247)
                   max            284  (247–322)
```

Monoton naik. **Effort GLM-5.2 nyata dan bertingkat.**

```
sem-gemini         off  rata-rata 533  (386–673)
                   high           316  (9–479)
```

Terbalik, sebaran raksasa, satu run nyaris kosong. **Gemini menerima setiap level dan menerapkan tidak satu pun.** Menjawab pertanyaan yang tertunda sejak D21: Gemini **tidak menolak** `thinking` seperti groq dulu — ia menerimanya diam-diam, yang lebih buruk karena tidak meninggalkan jejak.

Qwen lebih tajam lagi: `off` dan `low` selesai normal, sedangkan **`minimal`, `medium`, dan `high` diterima RPC lalu tidak pernah selesai** — run menggantung sampai watchdog memungutnya.

### `effortMode`: jaminan atau preferensi

Katalog kini membedakan keduanya, dan controller memperlakukannya berbeda:

- **`guaranteed`** — level dikirim sebagai parameter `thinking`, dan registry menuntut agen mengiklankannya (P4-03 tetap berlaku).
- **`preference`** — level **tidak pernah dikirim**. Ia niat yang tercatat, bukan jaminan. Registry berhenti menuntut agen mengiklankannya, karena memarkir pekerjaan demi parameter yang tidak dipakai siapa pun adalah kerugian tanpa manfaat.

Default `guaranteed`, karena entri yang belum dikarakterisasi adalah klaim yang harus diuji, bukan alasan menahan parameter. Setiap `effortMode` wajib disertai `effortEvidence` — klaim tanpa alasan tercatat tidak bisa ditinjau ulang saat provider berubah. Jalur ACP semuanya `preference`: effort di sana dipaku lewat perintah wrapper per-model, tidak pernah lewat dispatch.

Terbukti hidup — pratinjau routing kini menyebutkan keduanya:

```
PREFERENSI  google/gemini-3.1-flash-lite @ high  (gemini-flash-high)
            bukti: diterima semua level, TIDAK diterapkan: off 533 vs high 316 (n=3)
jaminan     zai/glm-5.2 @ high  (glm-5.2-high)
```

## D32 — Agen Semanggi kini terlihat di AgentOS, dan dua penulis itu nyata

**Perbaikannya satu env var.** `local-gateway-probe.ts` menunjukkan AgentOS menghormati `OPENCLAW_CONFIG_PATH` dan jatuh ke `<stateDir>/openclaw.json` bila tak disetel — dan kita tidak pernah menyetelnya, jadi ia membaca cermin basi miliknya sendiri (D28). Setelah `OPENCLAW_CONFIG_PATH` diarahkan ke config gateway dan direktorinya di-mount: **24 agen, kesembilan agen Semanggi terlihat.** Desain Semanggi tidak berubah sama sekali.

### Inkompatibilitas yang ditemukan

Mencoba membuat agen lewat API AgentOS mengungkap tiga hal sekaligus:

1. **AgentOS menulis `openclaw.json` LANGSUNG**, bukan lewat RPC gateway. Mount read-only memblokirnya dengan `EROFS ... openclaw.json.lock`. Jadi dua control plane memang menulis satu berkas dengan cara berbeda. Mount dikembalikan read-write: read-only membuat agen Semanggi terlihat tetapi melumpuhkan seluruh manajemen agen di AgentOS — harga yang terlalu mahal.
2. **Model yang diminta diabaikan.** Saya minta `zai/glm-5.2`; yang tertulis `zai/glm-4.7-flash`. AgentOS memakai bentuk field yang berbeda (`workspaceId`, bukan path; dan `modelId`, bukan `model`).
3. **Pembuatannya bisa setengah jadi.** Entri config tertulis lengkap, lalu scaffolding filesystem gagal (`EACCES` saat `mkdir .openclaw/tools`). Hasilnya agen yang ada di berkas selamanya, ditampilkan AgentOS sebagai agen sungguhan, dan **tidak pernah bisa dijalankan**.

### Penandanya diukur, bukan dilabeli

Kuncinya: agen setengah jadi itu **tidak pernah muncul di `agents.list` gateway**. Jadi pembedanya tidak perlu label yang bisa lupa dipasang:

```
ada di openclaw.json  →  AgentOS menampilkannya
ada di agents.list    →  gateway benar-benar akan menjalankannya
```

`GET /api/work/agents` menggabungkan keduanya dan mengklasifikasikan tiap agen: `operable` / `config-only` / `live-only`, plus `origin` (`semanggi` bila agentDir di state dir, `agentos` bila di `.openclaw/agents/` dalam workspace) dan daftar entri katalog yang bisa merutekan ke sana. Terbukti hidup:

```
{"total":25,"operable":5,"configOnly":1,"bySemanggi":9,"byAgentOs":16,"unroutable":19}
CONFIG-ONLY compat-probe-agentos   zai/glm-4.7-flash   asal=agentos
            listed in openclaw.json but not advertised by the gateway — half-created
```

Karena registry Semanggi sudah hanya memakai `agents.list`, ia **sudah kebal** terhadap agen setengah jadi. Yang baru adalah operator bisa melihatnya.

## D33 — Empat tambahan UI operator, dan transkrip yang akhirnya punya dua sisi

`GET /api/work/projects/summary` mengelompokkan hitungan per **fase**, bukan per status: tujuh belas status membuat tabel yang tidak dibaca siapa pun. `needsAttention` (WAIT_HUMAN + BLOCKED + FAILED) dipisahkan karena hanya itu yang bisa diselesaikan manusia; tujuh status `WAIT_*` lain selesai sendiri.

`GET /api/work/events` akhirnya membuat event log bisa dibaca. Ia jadi jejak audit sejak commit pertama dan tidak ada yang bisa membacanya — "apa yang terjadi pada task ini" hanya terjawab lewat log Docker.

`GET /api/work/models` mengembalikan katalog beserta `effortMode`, supaya UI menawarkan pilihan alih-alih teks bebas. Teks bebas adalah input yang salah untuk pilihan model: nama tanpa agen memarkir task di `WAIT_RESOURCE`, dan `glm-5.2` saja ambigu.

**Transkrip.** `executions.result` ternyata hanya menyimpan `stopReason`; balasan model **tidak pernah disimpan**. Halaman percakapan tanpa itu hanya menampilkan sisi operator — dan separuh percakapan lebih menyesatkan daripada tidak ada, karena ia tampak lengkap.

Bentuk payload diukur lebih dulu, tidak ditebak — pelajaran D17:

```
message.role     "user" | "assistant"
message.content  STRING untuk pengguna, ARRAY blok untuk asisten
blok             {type:"thinking"} | {type:"text"} | {type:"toolCall"}
```

Tabel `execution_messages` menyimpan teks yang sudah diratakan plus blok mentah (dibatasi 32 KB — satu giliran bertele-tele tidak boleh membengkakkan DB di NFS). Penalaran disimpan di `blocks` tetapi tidak diinlinekan ke teks: ia sering lebih panjang dari jawabannya. Korelasi lewat `session_ref`, bukan `runId` — `session.message` tidak membawa `runId` sama sekali.

Terbukti hidup:

```
[operator]  Jawab persis dengan kalimat ini dan tidak lebih: SISI MODEL TEREKAM.
[assistant] SISI MODEL TEREKAM.
kedua sisi terekam: YA
```

## D34 — `workspaceDir` dan `agentRuntime.acp.agent` tidak ada di 7.1, dan itu sekarang terbukti habis-habisan

Upgrade dituntaskan: gateway **2026.7.1**, plugin **acpx 2026.7.1** dan **zai 2026.7.1** (dari 6.11), plus `groq-provider 2026.7.1` yang dipasang doctor sendiri.

Sebelum menyimpulkan, kedua parameter dicari di **setiap permukaan** yang ada:

| Permukaan | `workspaceDir` / `workspace` | `agentRuntime` |
|---|---|---|
| `agent` (dispatch) | ditolak | ditolak |
| `sessions.create` | ditolak | ditolak |
| `sessions.patch` | ditolak | ditolak |
| `agents.create` | **diterima** (`workspace`) | ditolak |
| `agents.update` | **diterima** (`workspace`) | ditolak |
| berkas config | (properti agen) | **gateway menolak boot**: `Unrecognized key: "agentRuntime"` |
| `sessions.pluginPatch` | — | `unknown plugin session extension: acpx/acpx` |

Bukti terkuat justru yang terakhir dan yang di berkas config. Menaruh `agentRuntime` di entri agen membuat gateway **gagal start** — jadi field yang muncul di `agents.list` sebagai `{"id":"auto","source":"implicit"}` itu **turunan yang hanya bisa dibaca**, bukan sesuatu yang bisa disetel. Dan `sessions.pluginPatch` memang menyediakan mekanisme konfigurasi plugin per-sesi, tetapi **acpx tidak mendaftarkan namespace apa pun** di sana.

Kesimpulannya bukan "belum ketemu", melainkan **tidak ada**. Naik ke 7.1 di setiap komponen tidak mengubahnya. **D14 dan D18 tetap berlaku**, sekarang dengan bukti menyeluruh alih-alih dugaan.

### Yang bisa dilakukan sebagai gantinya

**Untuk workspace.** `agents.update` menerima `workspace`, jadi agen bisa diarahkan ulang tanpa dibuat baru. Tetapi mengarahkan ulang agen yang mungkin sedang dipakai task lain adalah balapan yang tidak dijaga apa pun — lease kita per-workspace, bukan per-agen. Jadi yang diadopsi adalah sisi lain dari masalah: **`agents.delete` sekarang berfungsi**, dan `scripts/reap-agents.mjs` memungut agen yang workspace-nya sudah lenyap. Sprawl agen adalah ongkos sesungguhnya dari workspace-sebagai-properti-agen; sekarang ongkos itu bisa dibayar berkala alih-alih menumpuk.

Kriterianya sengaja satu saja: workspace-nya tidak ada lagi di disk. Menebak "sudah selesai" dari nama atau umur akan salah pada task yang berjalan lama. Skrip ini juga operator tool, bukan runtime — menghapus agen butuh `operator.admin`, dan controller sengaja hanya memegang `operator.write` supaya bisa menjalankan pekerjaan tetapi tidak membentuk ulang armadanya (D14).

**Untuk pemilihan harness.** Mekanismenya tetap satu-satunya yang ada: satu perintah tipis per (model, effort) di `plugins.entries.acpx.config.agents.*` plus `acp.allowedAgents`. Pilihannya global lewat `acp.defaultAgent`, bukan per task. Katalog sudah jujur soal ini — seluruh entri ACP bertanda `effortMode: "preference"` sejak D31.

### `deliver` wajib boolean

2026.6.11 menerima string `"none"`; 2026.7.1 menolak apa pun yang bukan boolean dengan `at /deliver: must be boolean`, dan dispatch gagal total. Kita kebetulan sudah benar — itu keberuntungan, bukan rancangan — jadi **tipenya kini diuji**, bukan diserahkan pada orang berikutnya yang menyunting objek params.

### Metode 7.1 yang diadopsi dan yang ditolak

Diadopsi: `agents.delete` (pemungutan), `agents.update` (workspace/model/name, terbukti), `agents.list` sebagai sumber kebenaran operabilitas (D32).

**Belum diadopsi, dengan alasan:** `sessions.compaction.branch` menuntut `checkpointId` sedangkan sesi kita punya `checkpoints: []` — ia butuh `sessions.compact` dijalankan lebih dulu. Ini kandidat nyata untuk menutup "FORK tidak membawa riwayat", tetapi mengubah perilaku sesi dan layak jadi pekerjaan tersendiri, bukan tempelan pada upgrade.

**Ditolak:** memakai model `claude-cli/*` langsung alih-alih jalur ACP. Itu akan membuat pemilihan harness jadi pemilihan model dan langsung menyelesaikan D18 — tetapi interposer izin duduk di jalur ACP, jadi menempuhnya berarti **melewati gerbang L3 sepenuhnya**. Kemudahan tidak sebanding dengan mematikan gerbang izin.

### Gerbang izin: masih terhalang, dan sebabnya berubah

Percobaan pertama gagal dengan `429 — You've hit your session limit`. Diulang kemudian: `"Not logged in · Please run /login"`. Jadi token OAuth langganan itu **sudah tidak sah**, bukan sekadar kehabisan kuota. Ini tindakan operator: `claude setup-token` lalu perbarui secret `claude_code_oauth`. Sampai itu dilakukan, **status jalur ACP di 7.1 tidak diketahui**, dan kegagalan gerbang izin bersifat senyap — jadi ini bukan hal yang aman untuk ditunda diam-diam.

## D35 — Semanggi di atas AgentOS: Brain, level, dan preamble

Keputusan operator: AgentOS memiliki **bentuk** pekerjaan (project, tim, skill, tools, template, preset, scaffold memory); Semanggi memiliki **penjadwalan** pekerjaan (task, Brain, quota, lease, prioritas, atribusi). Workspace Semanggi menjadi subdirektori workspace AgentOS.

### Pengukuran yang membentuk rancangannya

Satu uji mengubah bentuk seluruh "Brain Pooler", dan ia juga **mengoreksi D14**:

```text
agents.create { model: ["glm-5.1","glm-5.2"] }   → at /model: must be string
agent { agentId: "…glm-5-1", model: "zai/glm-5.2" }
                                                 → Model override "zai/glm-5.2" is
                                                   not allowed for agent "…glm-5-1"
```

Satu agen membawa **tepat satu model**, dan gateway menolak menjalankan model di luar itu **bahkan dengan `operator.admin`**. D14 dulu menyiratkan override membuat model yang dirutekan pasti berjalan; ternyata hanya di dalam himpunan model agen.

Akibatnya: Brain **tidak bisa** dipasangkan ke agen mana pun saat dispatch. Pooler MUST **memilih** agen yang sudah membawa Brain yang tepat, bukan **mengonfigurasi ulang** agen. Mengubah model agen sebelum dispatch (`agents.update`, terbukti bisa) ditolak sebagai jalur: ia balapan antar-task, menulis config di NFS tiap run, dan menciptakan jendela di mana agen menjalankan model yang bukan miliknya menurut siapa pun.

### Yang dibangun

**Brain** = (provider, model, thinking, effortMode, bukti) yang diberi nama, kini tabel dan bukan lagi daftar di berkas. Katalog `routing.json` menjadi **benih**, disemai sekali; sesudah itu operator memiliki isinya. Kalau berkas tetap menang, setiap penyuntingan operator akan hilang pada restart tanpa jejak.

Dua invarian dijaga di tingkat basis data:

- `effortMode: preference` **wajib** menyertakan `effortEvidence`. Klaim tanpa alasan tercatat tidak bisa ditinjau ulang saat provider berubah.
- `provider` dan `model` **tidak bisa diubah**. Agen di-provision per (project, role, brain); mengubahnya membuat setiap agen yang sudah ada menunjuk model yang salah tanpa ada yang tahu. Buat Brain baru.

**Level** menghubungkan profil project dengan Brain, dan ternyata sudah ada sebagai `routeClass`:

```text
modelProfile  →  level default    balanced→normal · fast→low · quality→critical
template×role →  level override   Learner/Reviewer lazim naik satu tingkat
task          →  level override   tetap tersedia, kebutuhan berubah di tengah jalan
```

Pemetaan per role tidak bisa diturunkan otomatis dari profil: pekerjaan Learner dan Reviewer adalah menilai dan memadatkan, dan itu yang paling rugi bila effort dipangkas. `null` pada tabel bawaan ditulis eksplisit supaya terlihat role itu sudah dipertimbangkan, bukan terlewat.

**Preamble instruksi** membawa hal yang berbahaya kalau basi:

```text
Brain: glm-5.2-low (zai/glm-5.2)
Reasoning effort: low (aktif)          ← atau: DIMINTA TETAPI TIDAK AKTIF
Tulis hasil ke: deliverables/TASK-91/
Mode workspace: WRITE (memegang lease eksklusif)
```

Ia diturunkan dari objek yang sama dengan keputusan routing, jadi tidak bisa berbeda dari kenyataan — alasan bagian ini **tidak** dititipkan ke berkas skill. Kalimat effort untuk Brain preferensi eksplisit: *"jangan mengandalkan penalaran panjang yang tidak akan terjadi"*. Tanpa itu agen menyusun rencana yang bersandar pada penalaran yang tidak pernah ada, lalu menghasilkan pekerjaan dangkal tanpa ada yang tahu sebabnya.

### Terbukti hidup (image `2026083101`)

```text
12 brain tersemai dari katalog, level dan effortMode terbawa
  critical  glm-5-2-max        zai/glm-5.2   @max    jaminan
  critical  gemini-flash-high  google/…      @high   PREFERENSI
  low       glm-5-1-on         zai/glm-5.1   @low    jaminan

software/balanced · builder → normal   (project profile)
software/balanced · learner → critical (template default)
frontend/fast     · learner → normal   (template default)
research/balanced · reviewer→ critical (template default)

[assistant] ## Konteks eksekusi (Semanggi)      ← agen menggemakan preamble
```

### Bug yang ditemukan saat pembuktian

`candidatesFor` memakai `category IS NULL OR category = ?` dengan parameter null. Di SQL `category = NULL` **tidak pernah benar**, sehingga setiap Brain berkategori tersaring habis dan daftar kandidat selalu kosong. Kategori adalah penyempit opsional, bukan syarat — diperbaiki dan diuji.

### Tata letak workspace juga berubah (spec §6.1)

Tiga bagian rancangan lama menyerah pada kenyataan AgentOS:

| Lama | Sekarang | Sebab |
|---|---|---|
| `source/` | repo **di root** | AgentOS meng-klon ke root lalu melapisi dokumen |
| `artifacts/` | `deliverables/<TASK-ID>/` | `AGENTS.md` bawaan **sudah** menyuruh agen ke sana |
| `executions/<task-id>/` sebagai workspace | hilang; root = project | menghapus sebab kegagalan D29 |

Dan §9 (memory) ternyata **bukan** gap: OpenClaw punya bootstrap dua tingkat — tujuh berkas root disuntik tiap run dengan anggaran karakter, `memory/` dan `docs/` dibaca sesuai kebutuhan. Aturannya: **Tingkat 1 memuat penunjuk dan invarian, bukan isi.**

## D36 — UI Semanggi hidup di dalam AgentOS, lewat fork dan dua tambalan nav

Halaman Semanggi (Summary, Control, dan grup settings Brain/Role Map/Brain Map)
kini menjadi bagian dari AgentOS itu sendiri, bukan aplikasi terpisah yang
menumpang di sebelahnya.

**Jalur build: fork, bukan patch di Dockerfile.** AgentOS dulu dibangun dari
commit hulu yang dipin plus satu `sed`. Untuk 2.151 baris halaman baru, `sed`
bukan alat yang jujur. Fork ada di `/root/agentos-fork` (branch `semanggi`,
`origin` tetap menunjuk hulu supaya rebase adalah operasi git biasa), dan
Dockerfile menerimanya sebagai build context `agentos-src`. Konsekuensi yang
dicatat sengaja: prefiks Dockerfile agentos dan browser-worker **tidak lagi
identik**, jadi cache lapisan install tidak bisa dibagi — browser-worker tidak
butuh halaman ini dan tidak ada gunanya menyeret fork ke sana.

**Hanya 51 baris hulu yang disentuh.** Seluruh kode Semanggi adalah berkas baru
(`app/summary`, `app/control`, `app/api/semanggi`, `components/semanggi`,
`lib/semanggi`). Dua berkas AgentOS ditambal hanya untuk mendaftarkan menu, dan
`apply.sh` melakukannya lewat jangkar teks yang **gagal keras** kalau tidak
ditemukan — hulu yang bergeser harus ditinjau, bukan ditambal paksa. Terverifikasi
`tsc --noEmit` bersih sebelum build.

**Section sidebar bernama Operator tidak ada.** Permintaan menyebut "antara
Overview dan Operator"; yang benar-benar ada di AgentOS adalah
`overview / operations / system`. Semanggi diselipkan antara Overview dan
Operations.

**Proxy, bukan panggilan langsung.** `/api/semanggi/[...path]` meneruskan ke
controller dengan token dari secret di sisi server, dan hanya untuk jalur yang
ada di daftar putih. Tiga alasan, yang ketiga menentukan: token tidak pernah
sampai ke peramban; controller tidak perlu dipublikasikan; dan penjaga
`instance-protection` AgentOS memblokir mutasi yang tidak terbukti se-origin,
sehingga panggilan langsung dari peramban ke host lain tidak akan pernah lolos.

**Atribusi: batas yang diketahui, bukan kelalaian.** Satu token bersama berarti
setiap aksi dari halaman ini tercatat atas satu identitas. Header
`x-semanggi-actor` membawa nama pengguna AgentOS agar linimasa tetap menyebut
seseorang, tetapi nama itu berasal dari sesi peramban, bukan dari kredensial —
ia label, bukan bukti. §8.4 belum terpenuhi lewat permukaan ini; Slack tetap
satu-satunya jalur yang atribusinya bisa dipercaya.

**Dekomposisi WORK bersifat struktural, bukan semantik.** Permintaan dipecah
menurut fase yang berlaku untuk pekerjaan jenis itu (analyst → architect →
builder → reviewer/tester → learner), bukan menurut pemahaman atas kalimatnya.
Teks permintaan dibawa **utuh** ke setiap fase. Alasannya: gateway 7.1 tidak
punya metode penyelesaian model tanpa agen (218 metode, semuanya lewat agen),
jadi planner berbasis model akan menjadi dispatch penuh dengan workspace dan
lease sendiri — dan sebuah model yang salah membaca satu kalimat menghasilkan
lima task salah yang sudah memakan worker. Planner semantik tetap terbuka
sebagai pekerjaan berikutnya.

**Dua aturan yang ditegakkan, bukan didokumentasikan.**

1. *Rencana setengah jadi tidak pernah dibuat.* Brain tiap fase diselesaikan
   sebelum satu task pun ditulis; kalau ada fase tanpa Brain, tidak ada yang
   dibuat sama sekali. Terukur hidup: permintaan pertama ditolak dengan
   *"3 fase belum punya Brain: builder (normal), tester (normal), learner
   (critical)"* — dan diagnosisnya benar, katalog benih memang tidak punya satu
   pun Brain berkategori `coding`.
2. *Pemaku Brain tidak bisa menjadi jalan belakang untuk menurunkan level.*
   Terukur hidup: `glm-5-1-on` (low) dipaku pada reviewer yang butuh `normal`;
   pemaku diabaikan, kandidat level dipakai, dan alasannya dilaporkan di
   rencana alih-alih dibuang diam-diam.

**Bug yang ditemukan sambil jalan: `PUT` tidak pernah membaca body.** `handle`
hanya mem-parse body untuk `POST` dan `PATCH`, sehingga
`PUT /api/work/role-levels` — satu-satunya jalan menyetel level per role —
menolak **setiap** panggilan dengan *"template, role and level are required"*.
Route yang tidak bisa berhasil di input apa pun, dan tidak ada tes yang
menyentuhnya dari ujung ke ujung. Diperbaiki beserta tes regresinya.

**Distribusi image adalah celah operasional.** Tidak ada registry di cluster;
image dibangun di kub01-01 dan Swarm sempat menjadwalkan controller di kub01-02
yang tidak memilikinya (`Rejected`). Sementara ini image disalin dengan
`docker save | ssh docker load`. Ini rapuh dan pantas diganti registry internal.

## D37 — Template dan profile adalah setelan project, bukan parameter permintaan

Halaman Control dulu memuat kartu "Context" berisi dropdown template dan
profile, diisi ulang **setiap kali** seseorang mengirim permintaan WORK. Itu
salah pada dua tingkat sekaligus.

*Salah secara faktual:* keduanya bukan sifat permintaan, melainkan sifat
project. Sebuah project tidak berubah dari `software` menjadi `research` karena
permintaan berikutnya diketik orang lain.

*Salah secara operasional:* bila dua orang mengirim permintaan ke project yang
sama dengan setelan berbeda, dekomposisinya berbeda tanpa ada yang berniat
mengubah kebijakan. Setelan per permintaan diam-diam menjadi kebijakan per
pengetik.

Karena itu `template` dan `profile` menjadi kolom pada `projects`, disetel di
Settings → Project, dan kartu Context dihapus dari halaman Control. Yang
tersisa dipilih per permintaan hanyalah **project mana** yang dituju.

**`template` disimpan Semanggi sebagai penampung sementara, dan itu diakui.**
Pemiliknya sebenarnya AgentOS (`project.json`), tetapi discovery belum ada
(tugas #4). Sampai itu dibangun, kolom ini adalah salinan yang bisa basi — jadi
panel Settings menampilkannya **tanpa bisa disunting**: mengedit nilai yang
tidak dimiliki UI ini hanya akan membuat dua sumber kebenaran yang saling
bertentangan tanpa ada yang tahu mana yang menang.

Siapa pun boleh mengubah `profile`. Tidak ada gerbang peran karena tidak ada
peran: satu token bersama berarti seluruh permukaan ini sudah satu identitas
(D36), dan gerbang yang tidak bisa membedakan siapa pun bukan gerbang.

## D38 — Level thinking MUST diukur per model, bukan dibaca dari iklan agen

Dropdown level pada form Brain semula diisi dari `thinkingOptions` yang
diiklankan `agents.list`. Iklan itu **tidak bisa dipercaya**, dan sebabnya sudah
tercatat di D21: gateway memvalidasi `thinking` terhadap model *default*
(`zai/glm-4.7`), bukan model agen. Akibatnya dua arah: level yang diiklankan
bisa ditolak saat dispatch, dan level yang tidak diiklankan bisa diterima.

Yang menggantikannya adalah probe empiris: **satu dispatch nyata per level
kandidat**, dan yang selamat menjadi kosakata model itu. Tiga batas yang
ditegakkan, masing-masing karena kejadian nyata:

1. **Berlingkup satu model, bukan seluruh armada.** Tujuh level × N model adalah
   tagihan yang tidak diminta siapa pun. Operator memilih modelnya di form, dan
   probe hanya menyentuh itu (keputusan operator 2026-09-01).
2. **Asinkron, dengan status yang bisa ditanyakan.** Tujuh dispatch bisa memakan
   menit; satu permintaan HTTP yang menunggu selama itu akan mati di suatu
   tempat di rantai proxy AgentOS dan operator tidak akan tahu apakah probenya
   masih jalan. Server menjawab seketika, pekerjaannya di latar, UI menanyakan
   statusnya dan menampilkan kemajuan per level.
3. **Batas waktu per level ada di server.** Qwen terukur **menggantung** pada
   sebagian level (D31); batas di sisi klien hanya menyembunyikan gantungnya.

Model tanpa agen hidup ditolak dengan alasan itu, bukan dengan galat generik —
probe menuntut agen, dan "tidak ada agen untuk model ini" adalah diagnosis yang
langsung menuntun ke tindakan.

Hasilnya disimpan (`thinking_levels`) beserta buktinya dan dipakai ulang, jadi
biaya pengukuran dibayar sekali. Daftar model gateway juga dipersistensi
(`gateway_models`) dengan alasan yang sama.

## D39 — Halaman yang menumpang shell AgentOS, dan dua jebakan yang menyertainya

Dua kelas kesalahan muncul berulang saat menempelkan halaman Semanggi ke dalam
AgentOS. Keduanya tidak terlihat di `tsc` dan hanya muncul saat halaman dibuka.

**1. Prop fungsi tidak boleh menyeberangi batas server → client.** `app/summary/
page.tsx` adalah Server Component. Melewatkan callback ke komponen di bawahnya
membuat React gagal saat serialisasi RSC, dan halamannya kosong. Perbaikannya
struktural, bukan tambalan: satu shell client per halaman
(`summary-shell.tsx`, `control-shell.tsx`) menjadi satu-satunya tempat callback
dibuat.

**2. Kelas Tailwind milik hulu menang atas kelas kita bila urutannya kalah.**
Panel Semanggi di halaman Settings sempat menyempit karena kelas grid hulu;
`min-w-0` tidak cukup dan `w-full` yang menyelesaikannya. Pelajaran yang lebih
umum: menumpang shell orang lain berarti mewarisi kaskade CSS-nya, dan itu MUST
diuji dengan membuka halamannya, bukan disimpulkan dari markup.

**Komponen Semanggi karena itu meniru bahasa visual AgentOS tanpa mengimpor
komponennya.** Ongkosnya duplikasi kelas Tailwind; yang dibeli adalah rebase
yang tetap murah — hulu bebas mengubah komponennya sendiri tanpa menyeret UI
kita ikut rusak.

## D40 — Transkrip tanpa penalaran dan tool call adalah transkrip yang menyesatkan

D33 menyimpan balasan model sehingga transkrip punya dua sisi. Yang tersimpan
adalah teks yang **sudah diratakan**, dan perataan itu sengaja membuang blok
`thinking` — penalaran kerap lebih panjang dari jawabannya dan membanjiri
tampilan percakapan.

Keputusan itu benar untuk aliran percakapan dan salah untuk pemeriksaan. Ketika
sebuah task menghasilkan sesuatu yang aneh, pertanyaan operator justru
*"kenapa ia memutuskan itu, dan perintah apa yang ia jalankan?"* — dan keduanya
persis yang dibuang.

Karena itu `execution_messages` menyimpan **dua** kolom: `content` yang
diratakan dan `blocks` JSON mentah yang dibatasi ukurannya. Endpoint transkrip
mengekspos keduanya; UI yang memutuskan menampilkan Response, Reasoning, atau
Tool call. Blok bertipe asing ditampilkan apa adanya — blok yang hilang diam-diam
mudah disalahartikan sebagai blok yang tidak pernah ada.

Baris yang `blocks`-nya rusak merosot menjadi `null` dan `content`-nya tetap
lewat, bukan menggagalkan seluruh transkrip. Satu baris hasil suntingan tangan
tidak boleh membuat seluruh riwayat sebuah task tidak bisa dibaca.

**Bug yang ikut ketahuan:** task berstatus `BLOCKED` tidak menawarkan jalan
kembali di UI, padahal state machine mengizinkannya lewat revisi
(`BLOCKED → RESUMABLE → QUEUED`). Gerbangnya salah — ia bertanya "apakah task
sudah selesai", dan `CANCELLED` juga selesai. Sekarang gerbangnya menyebut
status yang memang bisa direvisi, dan `CANCELLED` tetap jalan buntu.

## D41 — Ada dua Dockerfile AgentOS, dan yang tampak benar adalah yang salah

Build image AgentOS untuk Swarm sempat memakai `agentos-fork/Dockerfile.railway`.
Ia **berhasil sepenuhnya**: `pnpm build` lulus, type-check bersih, image
ter-ekspor, terdistribusi ke lima node. Lalu setiap task Swarm mati seketika
dengan:

```
OPENCLAW_GATEWAY_TOKEN is required. Configure it with a generated Railway template secret.
```

Pesannya menunjuk ke secret, dan secret-nya memang ada — sebagai berkas di
`/run/secrets/`, bukan sebagai env. Yang salah bukan konfigurasinya melainkan
**entrypoint-nya**: `Dockerfile.railway` menanam entrypoint Railway, yang
menuntut token sebagai env dan volume di `/data`. Keduanya milik platform lain.

Image yang benar dibangun dari `semanggi-agent-platform/images/agentos/
Dockerfile`, yang memasang `/usr/local/bin/semanggi-agentos-entrypoint` plus
loopback proxy, dan menerima fork sebagai build context bernama `agentos-src`.

Dua hal yang membuat ini mahal untuk didiagnosis, dan karena itu dicatat:

- **Container yang sedang berjalan tidak bisa dipakai sebagai pembanding.**
  `docker exec … env` menampilkan env yang dikonfigurasi, bukan env yang
  di-`export` entrypoint sebelum ia `exec` ke proses berikutnya. Pemeriksaan
  itu membuat image lama tampak sama-sama tidak punya token, dan mengaburkan
  perbedaan yang sesungguhnya. Yang menjawabnya adalah
  `docker inspect --format '{{json .Config.Entrypoint}}'` pada **container**,
  bukan pada image — di situ terlihat entrypoint yang benar-benar dipakai.
- **Swarm rollback otomatis menyembunyikan kegagalan.** `docker service update`
  melaporkan *"converged"* setelah rollback, sehingga sekilas tampak berhasil.
  Yang jujur adalah `docker service ps`, yang memperlihatkan task baru
  `Failed` dan task lama kembali `Running`.

Aturan yang diambil: **verifikasi entrypoint image sebelum deploy**, dan
perlakukan "converged" sebagai klaim yang harus diperiksa, bukan sebagai bukti.

**Disk node build adalah sumber daya habis.** Build pertama pada ronde ini gagal
di tengah `apt-get` dengan `No space left on device`; node berada di 100% karena
tujuh tag image lama menumpuk. Pembersihan MUST menjadi bagian prosedur build —
dan MUST NOT menyentuh tag yang sedang dipakai service, karena itu satu-satunya
jalan mundur.

## D42 — Admission menyelesaikan nama Brain dari tabel brains, bukan dari ejaan katalog routing.json

D35 memutuskan katalog `routing.json` menjadi **benih** tabel Brain: disemai
sekali, sesudah itu operator memiliki isinya lewat halaman konfigurasi. Tapi
keputusan itu hanya bermigrasi setengah jalan, dan proyek SDMK Kader
(PRJ-F9D378E5) membayarnya sebagai "agen tidak routable".

**Pengukuran di cluster.** Dua lapisan membaca katalog dengan ejaan yang
berbeda, dan tidak ada yang menyadarinya sampai sebuah task nyata mencoba
lewat:

- Dekomposisi menulis `model_policy.preferred = [brain.name]`
  (`server.mjs:1360`), dan `brains.create` men-slug nama
  (`brains.mjs:slug`): entri katalog `glm-5.2-max` tersimpan sebagai Brain
  `glm-5-2-max`.
- Admission menatap nama itu di katalog `routing.json` lewat lookup string
  persis `this.#catalog[logical]` (`routing.mjs:134`). Kunci katalog tetap
  `glm-5.2-max`. Hasilnya setiap Brain yang lahir dari nama ber-titik —
  semua Brain glm — kembali sebagai `unmapped model names` dan parkir di
  `WAIT_RESOURCE`. Bahkan Brain yang disemai **dari** katalog itu sendiri
  tidak pernah cocok dengan katalognya.

Akibatnya persis yang D35 ingin hindari, tapi lewat pintu belakang: halaman
Settings → Brain / Brain Map hanya berkuasa sampai *seleksi*; begitu sebuah
Brain terpilih, admission menolaknya kecuali namanya kebetulan juga kunci
katalog. Rekomendasi "update routing.json" adalah workaround yang cocok dengan
kode saat itu, namun mengkhianati D35 — berkas jadi pemilik lagi, dan setiap
penyuntingan operator kembali menuntut deploy.

**Keputusan.** Admission menerima `brains` dan menyelesaikan
`model_policy.preferred` dari tabel brains dulu (`admission.mjs:
resolveModelCandidates`). Sebuah Brain aktif menjadi kandidat langsung dari
barisnya — `provider`, `model`, `thinking`, `effortMode`, `mode`, `acpAgent`
semua sudah ada di tabel. Katalog `routing.json` turun menjadi **fallback**
untuk nama yang bukan Brain (mis. model eksplisit yang diketik di Slack), dan
untuk Brain yang dimatikan tetapi namanya masih punya entri katalog — supaya
mematikan Brain tidak mengubah rute menjadi jalan buntu.

**Batas yang dipertahankan.** Ini tidak mengubah aturan P4-03: ketersediaan
masih hanya memutuskan *dispatch atau tunggu*, tidak pernah memperlebar set
kandidat. Brain yang tidak aktif tidak "digantikan" secara diam-diam; ia jatuh
ke katalog atau parkir dengan alasan yang dinamai.

**Koreksi fakta yang beredar.** Analisis "agen tidak routable" untuk SDMK
Kader memuat tiga data yang sudah basi saat diverifikasi di cluster:
`routing.json` ter-deploy justru punya `glm-5.2-*`/`glm-5.1-on`/`glm-5.3-on`;
`sdmk-kader-builder` membawa `zai/glm-5.2` (bukan 5.1); dan keenam worker
PRJ-F9D378E5 sudah ACTIVE. Blocker sesungguhnya adalah bug slug di atas,
ditambah pin Brain Map yang tidak cocok dengan model agen yang
di-provision.

**Tes.** Empat regresi di `tests/unit/admission.test.mjs` (nama Brain ter-slug
rutin dari tabel; Brain baru tanpa entri katalog tetap rutin; Brain mati jatuh
ke katalog; nama yang bukan keduanya tetap parkir). Keempatnya gagal bila
wiring `brains` ke admission dilepas — bukti mereka menangkap bugnya, bukan
hanya menggambarkan niatnya.

## D43 — Pencocokan worker pindah ke repository (`workers.match`), least-loaded

D29 memberi Slack `pickWorker` sendiri: permukaan yang membuat task harus
memilih worker atau menolak membuat (spec induk §2.4), sementara admission
hanya memvalidasi penugasan dan tidak pernah membuatnya. Begitu permukaan
pembuat task bertambah (UI Control), aturan itu berlipat: setiap permukaan
menulis pencocokannya sendiri, dan dua salinan aturan yang sama pasti
berbeda pada saat yang paling mahal.

**Keputusan.** Pencocokan diangkat ke `workers.match({ projectId, role })`
(`repositories.mjs`) dan Slack memakainya juga. Semantiknya: worker ACTIVE,
boleh mengambil project itu (`project_access`), cocok role bila role
ditanyakan; pemenang adalah yang **paling ringan bebanannya**
(`DISPATCHED`+`RUNNING`), bukan yang pertama ditemukan — first-found membuat
satu worker memikul semua task sementara yang lain menganggur, dan antrean
tampak sibuk untuk alasan yang tidak nyata. Seri diputus dengan urut `id`
supaya pilihan dapat direproduksi di tes maupun di log.

## D44 — Sumbu profile di role_levels DICABUT lalu DIKEMBALIKAN dalam satu hari, dan dua migrasi yang menyertainya

Sumbu profile (fast/balanced/quality) pernah dicabut dari `role_levels`
bersama `project_role_levels`, dengan alasan "jumlah permukaan konfigurasi
bertambah tanpa bukti operator memakai ketiganya". Alasan itu salah pada
premisnya: **project yang dibuat AgentOS membawa pasangan (template,
profile) yang berbeda kebutuhannya** — `(software, fast)` dan `(software,
quality)` memang dua project berbeda, dan Role Map yang tidak bisa
membedakannya menjawab pertanyaan yang tidak diajukan. Operator menolak
pencabutannya pada hari yang sama; keduanya dikembalikan.

Yang dikembalikan, lebih lengkap dari sebelumnya:

- `DEFAULT_ROLE_LEVELS` bersarang **template → profile → role**, seluruh
  kombinasi eksplisit sesuai spec induk §4.0 (empat golongan role:
  penentu arah selalu critical; produksi normal dan naik di quality;
  penilai naik satu tingkat; verifikasi ikut profil). Himpunan role per
  template harus identik di semua profile — diuji, karena role yang hilang
  pada satu profile adalah level yang ditebak saat runtime.
- `project_role_levels` kembali sebagai **snapshot penuh milik project**:
  begitu modal Project Role Level disimpan, resolusinya
  `project override > global (template, profile, role) > default bawaan >
  levelForProfile` — dan dekomposisi WORK project itu mengikuti snapshot
  ini, bukan lagi global (ditegakkan di jalur `control/message`, bukan cuma
  di pratinjau). Daftar role modal = role template ∪ role worker yang
  melayani project ∪ role tersimpan — project nyata boleh punya role di
  luar kosakata templatenya.

**Dua bentuk database pernah hidup, dua-duanya harus konvergen.** Satu
build ter-deploy membawa `role_levels (template, role)`; era sebelumnya
`(template, profile, role)`. `CREATE TABLE IF NOT EXISTS` tidak bisa
mengubah kunci tabel yang ada, jadi `#migrate()` di `db/index.mjs` kini
shape-based dua arah: bentuk dua-kolom **diperluas** ke tiga profile dengan
nilai yang sama (keputusan operator bertahan, grid jadi addressable penuh),
bentuk tiga-profil yang sudah benar dibiarkan apa adanya. Tanpa ini,
`INSERT … ON CONFLICT(template, profile, role)` gagal di prepare terhadap
bentuk lama — kelas D36: route yang tidak bisa berhasil pada input apa pun.

**Tes.** `tests/unit/role-levels-migration.test.mjs` (bentuk dua-kolom
diperluas, pin brain_map lama mewarisi sel legal, idempoten untuk rolling
restart), `tests/unit/project-role-levels.test.mjs` (role aktual modal,
snapshot menang pada dekomposisi WORK, penolakan level yang tidak sah),
`tests/unit/brains.test.mjs` (tabel §4.0 per golongan role, himpunan role
seragam antar profile).

## D45 — Brain Map per (template, role, level), dan penurunan yang terlihat

Brain Map semula satu pemaku per `(template, role)` untuk semua level,
dilindungi aturan "pemaku di bawah level kebutuhan diabaikan" (P4-03).
Halamannya menjadi grid `(template × role × level)` dengan dropdown per sel
— dan grid mengubah premis aturan itu: **memilih Brain untuk sel level
tertentu adalah keputusan eksplisit operator, bukan default yang bocor.**
Menolak pemaku di bawah level akan memalsukan grid (sel yang diisi lalu
diam-diam tidak berjalan — kelas kesalahan `stale` D32), jadi aturannya
berubah bentuk: pemaku **selalu dipakai**, dan Brain yang klasifikasinya di
bawah level sel ditandai `belowLevel` di resolusi maupun halaman.
Penurunan tetap tidak pernah diam-diam — ia menjadi terlihat.

Lapisan resolusi kini tiga: pemaku operator > **default grid**
(`DEFAULT_BRAIN_MAP`, nilai awal 2026-09-04 untuk semua template×role×level)
> kandidat pertama level (katalog routing). Default grid hanya memakai
Brain yang benar-benar hidup di instance — default tidak boleh menghidupkan
kembali Brain yang operator matikan (diuji). Pin lama era tanpa-level
diwariskan migrasi ke sel-sel yang legal baginya (level ≤ klasifikasi
Brain-nya), persis sel yang dulu tidak diabaikan aturan lama.

**Tes.** `tests/unit/brain-map.test.mjs` (pemaku per level tidak bocor ke
sel sebelah; `belowLevel` terlihat; Brain mati ditolak saat disetel; sel
kosong jatuh ke default lalu kandidat), plus lapisan default di
`tests/unit/project-role-levels.test.mjs`.

## D46 — Iterasi default lewat sumber di NFS; rebuild image hanya perintah eksplisit

Loop lama membayar harga penuh Docker untuk setiap perubahan: build image di
`Kubus01-01`, `docker save` ke tar, `scp` ke tiap node, `docker load`, lalu
`service update --image`. Untuk control plane nol-dependensi dan halaman UI,
harga itu tidak membeli apa-apa — tidak ada isolasi yang didapat dari image
yang tidak sudah diberikan oleh NFS yang memang dipakai untuk state.

Keputusan: service menjalankan kode dari dua direktori sumber di NFS —
`agentos-src/` (standalone build AgentOS) dan `controller-src/` (sumber
controller apa adanya) — dan iterasi menjadi **sunting → tes → sync →
restart**. Rebuild image hanya terjadi atas perintah eksplisit, atau bila
perubahan menyentuh entrypoint, Dockerfile, base image, atau dependensi
sistem; hasilnya di-push ke registry.

Konsekuensi yang dicatat sengaja:

- **Controller langsung jalan dari sumber** karena nol dependensi runtime;
  stack menimpa `command` ke `controller-src/src/main.mjs` dan env konfigurasi
  menunjuk `controller-src/config/`. Skema dan thinking-levels aman karena
  keduanya resolve relatif `import.meta.url`, bukan cwd.
- **AgentOS tetap butuh build** — Next.js tidak dijalankan dari sumber mentah
  di produksi. Yang pindah hanyalah *tempat* build: `pnpm build` di node build
  (tanpa Docker), hasilnya dirakit persis seperti `images/agentos/Dockerfile`
  (standalone + `.next/static` + `public` + `loopback-proxy.mjs`) lalu
  di-swap atomik lewat rename di filesystem yang sama. Bentuk artefak kedua
  jalur identik, jadi jalur cepat dan jalur image menjalankan bentuk yang sama.
- **Gagal keras, bukan fallback.** Entrypoint yang menemukan
  `SEMANGGI_AGENTOS_SRC_DIR` tanpa `server.js` berhenti dengan galat. Jatuh
  ke salinan basi dalam image akan terlihat seperti kode baru yang hidup —
  kelas kesalahan yang sama dengan D41.
- **Swap atomik.** Skrip sync menyalin ke staging lalu `mv`; container yang
  restart di tengah sync melihat pohon lama lengkap atau pohon baru lengkap,
  tidak pernah campuran.
- **Satu rebuild terakhir tetap diperlukan**: dukungan sumber NFS hidup di
  entrypoint image AgentOS. Migrasi = isi kedua direktori → rebuild image
  sekali → deploy stack baru. Setelah itu image menjadi baseline yang jarang
  berubah.
- **Placement disederhanakan menjadi satu label untuk semua service**:
  `node.labels.type == app`, dan klaster secara kontrak hanya melibatkan dua
  node — `kub01-01` dan `kub01-02`; node lain MUST NOT diberi label ini.
  Label khusus (`semanggi_nfs`, `semanggi_docker_engine`) dihapus dari stack,
  spec, dan tes kontrak: kelayakan NFS tetap diverifikasi terpisah lewat
  kontrak path (AT-01, `nfs-path-contract.sh`), bukan lewat label placement.

Alat: `scripts/sync-controller-src.sh`, `scripts/sync-agentos-src.sh`;
kontrak volume baru dijaga `tests/stack-schema.sh`.

### D46 addendum — migrasi selesai, dan satu jebakan tag basi

**Status 2026-09-06: migrasi satu kali selesai.** Image
`semanggi/agentos:2026090601` dibangun dengan entrypoint berdukungan
`SEMANGGI_AGENTOS_SRC_DIR` (entripoint diverifikasi SEBELUM deploy:
`["/usr/local/bin/semanggi-agentos-entrypoint"]`), `agentos-src` diisi lewat
skrip sync, dan kedua service terbukti menjalankan kode dari NFS — controller
sejak deploy stack, AgentOS sejak image baru. Uji asap terautentikasi lulus
(`/control` dan `/summary` 200, bundle memuat teks UI terbaru). Mulai sini
iterasi UI/controller tidak lagi menyentuh image.

**Jebakan yang ditemukan saat migrasi: `.env` stack adalah sumber tag, dan ia
basi.** `docker stack deploy` mengambil tag dari `SEMANGGI_*_IMAGE` di
`semanggi-agent-platform/.env`. Deploy image selama ini dilakukan manual lewat
`docker service update --image`, yang **tidak pernah menulis balik ke
`.env`** — sehingga satu stack deploy diam-diam menurunkan agentos dari
`2026090408` ke `2026090205` (image tiga hari lebih tua, UI pun ikut basi).
Aturan yang mengikat sejak sini: setiap deploy image manual MUST diikuti
pembaruan tag di `.env`, dan `deploy.sh` adalah jalur yang membaca `.env`
sehingga keduanya tidak bisa berpisah lagi.

## D47 — Penolakan lambat gateway dipetakan ke eksekusi; `reasoning` config adalah kontrak level thinking

Insiden TASK-E28D15F3 / TASK-BFA56024 (2026-09-05): kedua task DISPATCHED,
lalu 30 menit hening dengan token 0, lalu BLOCKED dengan pesan watchdog
generik `no runtime event for 1806s after dispatch`. Resume mengulang siklus
yang sama persis. Empat kali dispatch, empat kali pola yang sama.

**Mekanisme yang sebenarnya.** Gateway menjawab dispatch **dua kali**: `res ✓`
(diterima, ~120ms) lalu `res ✗` kedua dengan
`UNAVAILABLE: Thinking level "max" is not supported for zai/glm-5.2. Use one
of: off.` begitu run gagal start. Klien menyelesaikan promise pada frame
pertama — benar, karena frame kedua memang tidak bisa membatalkan promise
yang sudah settled (D20). Frame kedua menjadi event `gateway.late-error`…
yang **tidak punya konsumen di mana pun**: komentar di `gateway-ws.mjs`
mengklaim "the sink treats it like any other failure", tetapi tidak ada satu
pun kode yang menangani event itu. Klaim tanpa implementasi — dan watchdog
30 menit menjadi satu-satunya backstop, dengan pesan yang tidak menyebut
penyebabnya.

**Akar config.** `openclaw.json` mendeklarasikan `zai/glm-5.2` dengan
`"reasoning": false`, sehingga gateway hanya menawarkan `off`. Brain
`glm-5-2-max` justru membawa evidence probe `off 137 → low 217 → max 284
token (n=3), monoton` — pengukuran nyata yang hanya mungkin bila config
pernah `reasoning: true`. Mtime config adalah 2026-09-04 16:51 (hari migrasi
state + repair gateway); penulisan ulang config hari itu mengembalikan
`reasoning: false` dan diam-diam membatalkan hasil ukur semua Brain zai.
Pelajaran yang mengikat: **kontrak level thinking adalah `reasoning` di
config gateway**, bukan hasil probe yang tersimpan — probe mengukur apa yang
diizinkan config pada saat itu, dan config bisa berubah tanpa memberi tahu
siapa pun. Koreksi: `reasoning: true` untuk glm-5.2/glm-5.1, dan glm-5.3
ditambahkan ke daftar model (Brain sudah memakainya tapi config tidak
mengenalnya).

**Perbaikan.** Dua lapis, keduanya dengan tes regresi:

- `gateway-ws.mjs` mencatat `requestId → executionId` saat dispatch dikirim
  (TTL 10 menit, bounded 200 entri), karena frame penolakan kedua tidak
  membawa pengenal yang bisa dicocokkan sendiri. Event `gateway.late-error`
  kini membawa `runId` eksekusi.
- `session-events.mjs` menambah `applyLateError`: eksekusi yang masih
  DISPATCHED divonis BLOCKED dengan alasan sebenarnya (`dispatch refused
  after accept: …`), task BLOCKED, lease dilepas, scheduler dibangunkan —
  bentuk verdict yang sama dengan watchdog, tetapi dalam milidetik. Eksekusi
  yang sudah final atau RUNNING tidak boleh divonis oleh frame ini.

**Batas yang tetap benar:** perbaikan config membuat dispatch mengalir lagi,
tetapi bukti bahwa effort `max` benar-benar mengubah perilaku glm-5.2 adalah
probe lama yang kondisi config-nya tidak bisa direkonstruksi penuh. Bila
kualitas hasil mengecewakan, probe ulang terhadap config yang sekarang —
jangan percaya evidence lama (aturan §4.1 poin 9).

### D47 addendum — probe ulang: `max` tidak ada, dan classifier probe ikut berbohong

Probe ulang terhadap config yang sudah dikoreksi (2026-09-06) menjawab batas
di atas dengan pengukuran, bukan rekonstruksi:

```text
zai/glm-5.2   off 7 → minimal 15 → low 36 → medium 44 → high 32 token   SELESAI, status ok
              max, adaptive                                              DITOLAK saat run mulai (status: error)
```

Jadi gateway menawarkan **lima** level — `off/minimal/low/medium/high` — dan
`max` tidak pernah ada di antaranya. Brain `glm-5-2-max` diturunkan ke
`high` lewat API (nama dipertahankan supaya Brain Map tidak putus; evidence
diperbarui menyebut penurunan ini).

**Probe ulang itu juga membuka kebohongan kedua, di classifier probe sendiri.**
Putaran pertama masih mencantumkan `max`/`adaptive` sebagai `included` —
`classifySample` meloloskan run berstatus `error` lewat cabang "completed but
reported no usable usage", karena ia hanya memeriksa ok/timeout/unsupported.
Run yang ditolak saat mulai memang menjawab `ok` pada request probe, lalu
`agent.wait` berstatus `error` dalam ~5 detik tanpa usage — dan itu terbaca
sebagai "terukur, tanpa usage". Perbaikan: hanya status selesai yang terukur
(`ok`/`completed`) yang dihitung selesai; yang lain excluded dengan alasannya.
Konsekuensi yang diterima sadar: gateway versi depan yang memakai kata status
baru untuk "selesai" akan membuat probe tampak kosong — kekosongan yang
langsung terlihat, bukan level rusak yang ikut terkatalog.

**Satu temuan ikhlas dari run probe:** stall ~13 menit pada eksekusi task
(15:55→16:08 UTC) pulih sendiri dan menuntaskan pekerjaan — provider stream
yang menggantung tanpa `timeoutMs` adalah kelas kegagalan nyata, dan watchdog
tetap satu-satunya jaring untuknya.

## D48 — Uji koneksi Brain jujur sampai run selesai; transkrip dikaitkan lewat kunci sesi yang dikirim

Dua lubang dengan akar yang sama — *frame balasan pertama gateway diperlakukan
sebagai kebenaran terakhir* — ditemukan pada hari yang sama (2026-09-05).

**Lubang pertama: tombol Test berbohong.** Test koneksi Brain (`testAgent`)
melaporkan `ok: true` begitu dispatch diterima, padahal gateway menjawab
dispatch **dua kali**: `res ✓` lalu `res ✗` bila run gagal start (diukur:
thinking level yang tidak didukung model). Akibatnya Settings → Brain
menampilkan "OK · xxx ms" untuk `glm-5-2-max` yang setiap dispatch-nya
ditolak — persis insiden D47, tetapi kali ini UI-nya ikut menjamin hal yang
salah. Perbaikan: `ok` hanya untuk status selesai yang terukur (himpunan
yang sama dengan probe, `COMPLETED_STATUSES`); timeout dilaporkan sebagai
kemungkinan hang, `agent.wait` yang tak tersedia dilaporkan sebagai "tidak
bisa dikonfirmasi", dan penolakan dilaporkan dengan pesan gateway apa
adanya. Tes regresi di `gateway-ws.test.mjs`.

**Lubang kedua: transkrip kosong untuk run yang benar-benar bekerja.**
TASK-E28D15F3/TASK-BFA56024 selesai dengan token tercatat, tetapi transkrip
keduanya hanya berisi instruksi operator. Pemisahan yang menjelaskan: usage
dikunci di memori memakai **kunci sesi yang dibawa event** (jadi selamat),
sedangkan korelasi pesan mencocokkan `executions.session_ref` — dan revisi
CONTINUE mengirim kunci komposit `…:s<ref warisan>` yang **tidak pernah**
disimpan sebagai session_ref. Setiap pesan di tengah run gagal dikaitkan dan
dibuang. Perbaikan tiga lapis: kolom baru `executions.session_key` (migrasi
idempoten; baris lama NULL dan jatuh ke jalur lama), handoff dispatch
mengembalikan kunci yang dikirim, dan sink mengaitkan pesan lewat kunci itu
dahulu — eksekusi yang belum final menang, karena revisi CONTINUE berbagi
satu kunci percakapan. Tes regresi di `session-events.test.mjs` dan
`session-key-migration.test.mjs`. UI mendapat dua tambahan kecil: blok
`toolResult` dirender sebagai kartu output tool (merah bila gagal), dan
gema instruksi berbalut preamble disaring dari transkrip.

**Batas yang disengaja:** transkrip merekam apa yang lewat event
`session.message` (reasoning, jawaban, toolCall) dan stream `agent`
(hasil tool), dibatasi `SEMANGGI_MAX_MESSAGE_BYTES` per giliran. Ia tidak
merekam isi file yang diubah agen — itu jejak workspace, bukan percakapan —
dan blok tak dikenal ditampilkan apa adanya, bukan disembunyikan.

**Bentuk output tool diukur, bukan ditebak (aturan §4.1 poin 4).** Dokumen
protokol menyebut keluarga event `session.tool` tetapi tidak memberi bentuk
payload; gateway 2026.7.1 yang terpasang ternyata mengirim lifecycle tool
lewat event `agent` dengan `stream:"tool"` (fase start/update/result, diukur
2026-09-05 lewat jendela pengukuran sementara). Hanya fase `result` yang
disimpan sebagai giliran `toolResult` (nama, meta, isError, exitCode,
durationMs, teks output) — fase `start` menduplikasi blok toolCall yang sudah
dibawa giliran assistant, dan delta `command_output` adalah noise setelah
hasil teragregasi ada. Koneksi juga mengiklankan cap `tool-events`; ia tak
berpengaruh pada versi ini tetapi murah untuk versi berikutnya.

## D49 — Transkrip UI: satu region per aksi; pasangan call↔result tanpa call id; markdown mini tanpa dependensi

**Keputusan (2026-09-06).** UI transkrip task (`task-dialog.tsx`, fork) menggabungkan
giliran `toolResult` ke blok `toolCall` yang memintanya: satu region collapsible
(default tertutup) berjudul kata kerja — Exec/Read/Write, bukan "Tool Call" — dengan
command/isi file di atas dan hasil di bawah garis delimiter. `exit` tampil sebagai
badge warning dan `durationMs` rata kanan di header region; `isError` merender region
merah transparan berborder merah. Jawaban `<final>` dibuka bungkusnya dan dirender
markdown; konten `write` tampil multiline penuh tanpa prefiks key (dulu ter-truncate
satu baris).

**Pasangan tanpa call id.** Frame result gateway 2026.7.1 (D48) tidak membawa id
pemanggilan, jadi UI memasangkan FIFO per nama tool dalam satu eksekusi; antrean
di-reset saat `executionId` berubah agar revisi berikutnya tidak menelan result
revisi sebelumnya. Result tanpa pasangan tetap dirender sendiri, tidak disembunyikan
(§8.7).

**Markdown tanpa dependensi.** Fork tidak memaketkan renderer markdown; menambah
paket = rebase tax (aturan §4.1 poin 2). Renderer mini (heading, list, fence, inline
code/bold/italic/link) cukup untuk yang ditulis brain; yang tak dikenal jatuh
menjadi paragraf polos.

**Reasoning belum pernah terekam.** Diukur 2026-09-06: 0 dari 71 pesan di
`execution_messages` memuat blok `thinking`. UI sudah merendernya collapsed sejak
D48, jadi region reasoning tidak pernah muncul karena datanya memang tidak ada,
bukan karena UI menyembunyikannya. Pertanyaan terbuka: apakah gateway 2026.7.1
memancarkan reasoning lewat stream yang belum didengar controller.


## D50 — `PREPARE:` sebagai intent deklaratif: satu task analyst untuk dokumen rencana, bukan rantai dekomposisi

**Keputusan (2026-09-05).** Tombol "Create plans" / "Create tasks" di Command
Center mengirim prefiks `PREPARE:` dan router intent memperlakukannya sebagai
intent deklaratif: **satu task analyst** (level dari (template, profile) +
snapshot project, Brain dari grid yang sama, kategori analysis) — bukan rantai
dekomposisi lima fase. Membuat rencana selesai secara alami dalam satu run:
baca dokumen, tulis rencana. Pipeline penuh membayar lima fase — termasuk fase
builder yang untuk "tuliskan rencana" tidak punya apa pun untuk dibangun — dan
menunda dokumen rencana di belakang dependensi yang tidak diperlukan. Task
PREPARE meniru persis fase analyst dekomposisi; bedanya hanya tidak ada rantai.

**Deklarasi menang atas verba CREATE.** Di `classify()`, payload di balik
prefiks tetap diklasifikasi, tetapi verba CREATE di dalamnya tidak lagi membalik
intent: "PREPARE: Buat rencana…" adalah bahasa natural yang menjelaskan
pekerjaan, bukan perintah re-klasifikasi — menghormati verbanya akan membalik
setiap permintaan prepare berbahasa Indonesia kembali ke WORK dan menggugurkan
deklarasi. Hanya perintah lingkup-task (status/stop/…) yang tetap lebih tinggi.
Prefiks dengan payload kosong tetap jatuh ke CONFIRM.

**Kegagalan admission = alasan yang bisa ditindaklanjuti**, bukan WAIT yang
misterius: tanpa worker analyst aktif untuk project → pesan menyebut cara
mendaftarkannya; tanpa Brain untuk level analyst → pesan menyebut halaman Brain
Map (D42).

**Tombol UI bersyarat pada dokumen.** "Create plans" hanya muncul selama
docs/plans.md belum ada; "Create tasks" hanya setelah plans ada dan tasks belum
ada — tombol yang menggantung setelah filenya ada mengundang penimpaan tanpa
sengaja, dan daftar task sebelum rencana adalah tebakan (prompt tasks-nya sendiri
menolak berjalan tanpa docs/plans.md).

**Terukur di cluster (2026-09-05, PRJ-A86973EC via
`POST /api/work/control/message`).** "Create plans" → `TASK-230B1780`: tepat
satu task (tidak ada task lain dalam 5 menit), analyst `WRK-034BFD58`
(critical, glm-5-2-max), DISPATCHED → COMPLETE dalam ~9½ menit,
docs/plans.md 19.596 byte. "Create tasks" → `TASK-293CD0A0`: tepat satu task,
COMPLETE, docs/tasks.md 23.817 byte. Kedua dokumen menyebut sumbernya dan
otoritas konfliknya.

**Catatan terbuka.** Run kedua memangkas docs/plans.md sedikit (19.596 →
19.122 byte) — prompt "Create tasks" tidak melarang menyentuh plans.md, dan
analyst merapikannya. Prompt berikutnya sebaiknya membatasi run tasks pada
menulis docs/tasks.md saja bila pengetatan ini diinginkan.


## D51 — jadwal reset kuota milik Brain; jendela per-menit dicoba ulang sampai 10× sebelum diblokir

**Keputusan (2026-09-05, permintaan operator).** Setiap Brain menyimpan dua
kolom `quota_reset_short_ms` / `quota_reset_long_ms` dengan default per
keluarga provider: google (Gemini) **per-menit + harian**; zai (GLM),
claude-code, groq (QWEN) **5 jam + mingguan**. Kegagalan kuota pada model
yang jendela pendeknya ≤ 60 detik (`RETRYABLE_SHORT_WINDOW_MS`) TIDAK langsung
memblokir task: task diparkir `WAIT_QUOTA` selama tepat satu jendela pendek
(resetsAt provider menang bila ada), lalu di-dispatch ulang, sampai
**`QUOTA_RETRY_LIMIT` = 10 kali**; baru setelah itu `BLOCKED` dengan alasan
yang menyebut hitungannya. Jendela 5 jam tetap parkir-ETA seperti sebelumnya —
menunggu 60 detik itu murah, menunggu 5 jam sambil berpura-pura "retry" tidak.

**Mengapa milik Brain, bukan resources.** Tabel resources merekam keadaan
SEKARANG (QUOTA_EXHAUSTED sampai kapan), bukan karakter jendelanya, dan sinyal
provider tidak selalu tiba sebelum tabrakan pertama. Jadwal reset adalah
properti model di sisi provider; menyimpannya di Brain membuat kebijakan retry
bisa memutuskan sebelum sinyal pertama, dan operator melihatnya di halaman yang
sama dengan modelnya (kolom "Quota" + dua select di form Brain, label
Inggris sesuai §4.2).

**Dua lubang yang kebetulan ditemukan saat menggali.** (1) Jalur late-error
(`gateway.late-error` → `applyLateError`) memblokir task kuota TANPA memanggil
`applyQuotaSignal` — task mati untuk alasan yang tidak pernah dipelajari
scheduler, lalu task berikutnya menabrak tembok yang sama. Sekarang sinyal
selalu direkam di kedua jalur. (2) Detektor lama
(`/rate limit|too many requests|session limit|usage limit/i`) tidak mengenali
kosakata Gemini ("quota", "RESOURCE_EXHAUSTED") — deteksi kini satu fungsi
bersama `isQuotaErrorMessage` (quota-windows.mjs) yang dipakai repos dan
runtime.

**Menyamakan jam.** `resetsAt` dari pesan bisa epoch-detik ATAU milidetik; ia
dinormalisasi sebelum dibandingkan dengan jam (1,7e9 detik selalu tampak
"masa lalu" bagi `now()` milidetik — bug yang tertangkap tes, bukan review).
Bila sinyal tidak membawa ETA dan jendela retry-able, **jendela itu sendiri
menjadi jam** — untuk task DAN untuk resources, karena `releaseExpiredQuota`
hanya melepas baris QUOTA_EXHAUSTED yang punya `next_available_at`; sinyal
tanpa ETA akan mengunci model itu untuk semua task selamanya.

**Transisi baru: `DISPATCHED → WAIT_QUOTA`.** Late-refusal adalah event yang
sama dengan yang admission tangani sebelum accept; parkir adalah pencatatan
yang jujur. Hanya kuota yang mendapat pintu keluar ini — task yang tidak pernah
jalan tidak bisa menunggu hal lain.

**Hitungan di-nol-kan** saat COMPLETE (applyEnd) dan saat revisi
(createRevision): hitungan mengukur satu rentetan kalah, bukan umur task —
task yang sudah terbukti lewat sekali tidak memikul dosa percobaan lamanya,
dan operator yang me-revision blocked task sudah mengambil keputusan.

**Batas yang diketahui.** Retry in place hanya melihat jendela PENDEK; kuota
harian Gemini yang terkuras tampak sebagai 10 kegagalan per-menit beruntun
lalu BLOCKED — itulah perilaku yang diminta, bukan bug. Otak kebijakan ada di
`src/domain/quota-windows.mjs`; API menurunkannya sebagai `quotaReset` di
`GET /api/work/brains` supaya UI tidak pernah menurunkan kebijakan sendiri.


## D52 — ambang retry jadi 10 menit (dinamis, bukan milik Gemini); late-error transient → WAIT_RESOURCE + backoff + batas 5

**Keputusan (2026-09-05, penyempurnaan D51 atas permintaan operator).** Dua
perubahan:

**(1) Ambang "retry in place" naik dari 60 dtk ke `< 10 menit` dan bersifat
dinamis.** Perilaku itu bukan milik Gemini: SETIAP model yang jendela reset
terpendeknya di bawah sepuluh menit mendapat perlakuan yang sama — parkir
`WAIT_QUOTA` tepat satu jendela lalu redispatch, sampai
`QUOTA_RETRY_LIMIT` = 10. Aturan menempel pada jendela (properti Brain),
bukan pada nama provider; provider baru atau jendela kustom operator langsung
tercakup tanpa perubahan kode.

**(2) Late-error transient tidak lagi langsung BLOCKED.** Pesan late-error
ber-sinyal *rate limit / UNAVAILABLE / overloaded / 5xx* menggambarkan runtime
yang tidak sanggup SAAT INI, bukan pekerjaan yang mustahil — memblokir pada
frame pertama membunuh task untuk gangguan yang reda sebelum operator
melihat. Jalur baru: parkir `WAIT_RESOURCE` dengan backoff eksponensial
(30 dtk → 15 menit, `resourceRetryBackoffMs`) dan **batas retry terpisah**
`RESOURCE_RETRY_LIMIT` = 5 (penghitung kolom `tasks.resource_retries`,
di-nol-kan bersama `quota_retries` saat COMPLETE dan revisi). Habis batas →
`BLOCKED` dengan alasan menyebut hitungan. Sisanya (penolakan definitif —
model salah, request salah) tetap `BLOCKED` seketika.

**Urutan klasifikasi di `applyLateError` jadi tiga tingkat:** kuota +
jendela < 10 menit → `WAIT_QUOTA` satu jendela (D51); kuota jendela panjang
ATAU transient non-kuota → `WAIT_RESOURCE` backoff (baru); lainnya →
`BLOCKED`. Rate limit jendela panjang (tembok 5 jam Claude) jatuh ke tingkat
dua: sinyal kuotanya tetap direkam (D51), task menunggu dengan backoff, dan
gerbang pra-dispatch yang mengambil alih dengan ETA jendela begitu resource
tertandai `QUOTA_EXHAUSTED`.

**Transisi baru: `DISPATCHED → WAIT_RESOURCE`** — saudara dari
`DISPATCHED → WAIT_QUOTA` (D51) dengan alasan yang sama: penolakan
pasca-accept adalah event yang admission tangani pra-accept. Ekor BLOCKED
ketiga jalur dipusatkan di `blockLateError()` supaya mekanikanya tidak
bercerai — celah sinyal D51 lahir persis dari salinan yang berdrift.


## D53 — PREPARE "daftarkan…" mendaftarkan task dari docs/tasks.md; id task boleh disebut sebagai kode

**Keputusan (2026-09-06).** PREPARE punya dua wujud: penyusunan dokumen
rencana (D50) dan pendaftaran task dari `docs/tasks.md` — dideteksi dari
verba "daftarkan" + rujukan `tasks.md` pada payload. Parser
(`interface/tasks-md.mjs`) membaca format checklist yang diminta prompt
"Create tasks" sendiri (`- [ ] **T-XX — Judul**` + baris metadata
`**Role:** … · **Dep:** … · **Deskripsi:** …`, satu baris dipisah "·" —
parser memeriksa ketiganya pada baris yang sama, bukan if/continue). Item
`[x]` dilewati; dependensi antar temporary ID dipetakan ke id task nyata
dengan acuan maju dibuang (checklist ditulis top-down).

**Status default CREATED, bukan QUEUED.** Mendaftarkan 40+ task sekaligus
langsung ke antrian berarti satu kesalahan baca dokumen langsung memakan
worker seluruh project — alasan yang sama dekomposisi menahan fase
lanjutannya. Frasa "langsung jalankan" (dilonggarkan ejaannya: pola
`lan[a-z]*\s+(di)?jalan`) memindahkan semuanya ke QUEUED; admission tetap
yang memutuskan — dependensi parkir di WAIT_DEP persis seperti hasil
dekomposisi, jadi "langsung" tidak pernah berarti buta.

**Id task boleh disebut `#4F59F63A` atau kode polos `4F59F63A`.**
`normalizeTaskIds` di intent router menambah prefiks TASK- sebelum
ekstraksi, sehingga semua handler menerima satu bentuk kanonik. Sengaja
ketat — tepat 8 digit hex (bentuk `shortId("TASK")`), kode polos harus
UPPERCASE ("deadbeef" lowercase tak terbedakan dari prosa) — karena pola
yang lebih longgar akan memanen commit hash menjadi task id.


## D54 — penghapusan task: hard delete tanpa riwayat eksekusi, soft delete bila ada; hanya CREATED dan CANCELLED

**Keputusan (2026-09-06).** Papan penuh dengan pekerjaan yang tidak akan
pernah jalan: 95 task `CREATED` (stok PREPARE "daftarkan", D53 — status
default yang memang menahan mereka di luar antrian) dan 20 task `CANCELLED`
yang ditinggalkan operator. Tidak ada jalur API untuk menghapus mereka, dan
aturan 6 CLAUDE.md melarang `DELETE` tangan ke basis data — jadi satu-satunya
"pembersihan" yang tersedia adalah membiarkan papan tenggelam.

**Hanya `CREATED` dan `CANCELLED` yang boleh dihapus**
(`DELETABLE_STATUSES`). Keduanya terbukti menganggur: CREATED belum pernah
masuk antrian, dan CANCELLED adalah jalan buntu tanpa exit di state machine —
menghapusnya tidak mungkin menghentikan pekerjaan yang sedang terjadi. Status
lain (QUEUED, WAIT_*, BLOCKED, RESUMABLE, bahkan COMPLETE/FAILED) adalah
pekerjaan yang masih atau bisa menjadi hidup — revisi menghidupkan COMPLETE
dan FAILED kembali — dan menghapus mereka berarti menghentikan pekerjaan
diam-diam, pelanggaran §8.7.

**Hard delete bila tidak ada eksekusi; soft delete (`deleted_at`) bila ada.**
Ini bukan preferensi estetika tapi paksaan skema: trigger
`executions_no_delete` membuat riwayat eksekusi immutable, dan FK
`executions.task_id → tasks.id` menolak penghapusan baris task yang masih
ditunjuk. Diukur di cluster sebelum keputusan: 3 dari 20 CANCELLED punya
eksekusi. Transkrip menggantung di eksekusi, jadi baris task harus tinggal —
tetapi disembunyikan dari SEMUA listing (`list()` menyaring `deleted_at IS
NULL`; scheduler ikut lewat `list()` yang sama, jadi tidak ada cabang kedua
yang bisa membocorkan). `includeDeleted` hanya untuk audit. Task tanpa
eksekusi dihapus total bersama tepi dependensi kedua arah dan approval-nya;
`event_log` tidak pernah ikut terhapus — ia jejak audit, bukan milik task.

**Setiap penghapusan menulis `task.deleted` di transaksi yang sama** dengan
penghapusan barisnya (payload: status, title, projectId, method hard/soft,
note, actor). Task yang menghilang tanpa entri penghapusan akan membuat
basis data tampak kehilangan sejarah — penyakit yang sama dengan `UPDATE`
tangan yang aturan 6 larang.

**API: `DELETE /api/work/tasks/{id}` dan `POST /api/work/tasks/purge`.**
Purge menerima daftar status eksplisit dan menolak status di luar
DELETABLE_STATUSES satu per satu; jawaban menyebut SETIAP task yang dihapus
(id + judul + method) dan yang ditolak (alasan) — pembersihan 115 task harus
bisa diaudit dari responsnya saja. Keduanya admin-only, mengikuti preseden
penghapusan project. Dispatcher kini mem-parse body DELETE juga — `note`
dibaca dari body, dan pelajaran D36 (route yang body-nya tidak pernah
di-parse tidak bisa berhasil) berlaku untuk setiap method, bukan hanya
POST/PATCH/PUT.


## D55 — `[-]` sebagai tanda "sudah didaftarkan"; `/task cancel` dan `/task run` multi-id; controller menulis docs/ untuk suntingan operator

**Keputusan (2026-09-06).** Tiga permukaan Command Center yang sebelumnya
memaksa operator mengulang pekerjaan:

**`[-]` di docs/tasks.md = task sudah hidup di basis data.** Register
menulis balik checkbox `[ ]` → `[-]` SETELAH seluruh loop sukses (bukan per
task di tengah loop — kegagalan task ke-N tidak boleh menandai task yang
belum dibuat). Register berikutnya hanya mendaftarkan `[ ]`; `[-]` dan `[x]`
dilewati, sehingga pendaftaran ulang tidak pernah menduplikasi. Bila tidak
ada `[ ]` tersisa, jawabannya "Semua tasks sudah didaftarkan sebelumnya" —
bukan pesan galat, karena tidak ada yang salah. Kegagalan menulis balik
bukan kegagalan mendaftarkan (task sudah ada), jadi ia jadi peringatan di
jawaban, bukan rollback.

**`cancel` adalah verba sendiri, dan `run`/`cancel` menerima multi-id.**
CANCEL ≠ PAUSE: CANCELLED jalan buntu, BLOCKED bisa dijalankan ulang.
Classifier mengekstrak semua id (`taskIds`; duplikat dilipat), handler
menilai setiap id mandiri — satu id yang sudah bergerak/mati dilaporkan,
tidak menggagalkan batch. Konfirmasi destruktif multi-id mendeskripsikan
SEMUA target sebelum minta "yes" (§8.7: cara paling halus membunuh B adalah
konfirmasi yang hanya menyebut A).

**Controller menulis docs/, tidak pernah memory/.** PUT
`/api/work/projects/{id}/docs/{name}` untuk tombol Edit/Save modal —
mount workspaces controller berubah dari read-only menjadi RW (stack),
PEMBERIAN IZIN INI SEKECIL MUNGKIN: whitelist hanya nama di `docs/`
(brief, architecture, migration-plan, plans, tasks); `memory/`
(blueprint, decisions) tetap ditolak PUT karena itu wilayah agen dua-tingkat
(spec §9) — controller yang menulis memori agen adalah penulis kedua atas
berkas yang bukan miliknya. Setiap penyimpanan tercatat di event_log
(`project.doc-updated`). Pelajaran berbayar dari hari pertama: smoke test
PUT JANGAN memakai dokumen project hidup — brief.md production tertimpa
"# smoke edit" dan harus dipulihkan byte-demi-byte dari transkrip
(`execution_messages` menyimpan hasil Read agen); gunakan project buangan
atau dokumen dummy.

*(Paragraf di atas dibatalkan D58 atas keputusan operator — memory/ kini
ikut bisa disunting dari Command Center.)*

*(Dinomori ulang dari D54 duplikat; semua rujukan "D54" di kode —
repositories.mjs, schema.sql, db/index.mjs, task-delete.test.mjs — menunjuk
keputusan penghapusan task di atas, jadi entri ini yang mengalah.)*


## D56 — whitelist proxy adalah bagian dari kontrak route; Edit/Save modal pindah ke header dan scroll kedua panel disinkronkan

**Keputusan (2026-09-06).** Tombol Edit/Save modal dokumen sudah ada di
controller sejak D55 (PUT `/api/work/projects/{id}/docs/{name}`), tetapi
SETIAP simpan dari Command Center gagal 404 *"Semanggi proxy does not
expose PUT /work/projects/…/docs/…"* — route-nya tidak pernah didaftarkan
di daftar ALLOWED `app/api/semanggi/[...path]/route.ts`. Ini kegagalan
kedua dari jenis yang persis sama; yang pertama `GET/PUT
/work/projects/{id}/role-levels` (readiness.md, image `2026090403`).

**Route controller belum nyata bagi halaman sampai ia terdaftar di proxy.**
Daftar ALLOWED sengaja whitelist — proxy yang meneruskan apa saja akan
memberi setiap pengunjung AgentOS seluruh permukaan admin controller — jadi
konsekuensinya: setiap route baru yang dipakai UI MUST mendapat entri
ALLOWED, dan verifikasinya MUST end-to-end dari halaman (jalur terautentikasi
§5.3 CLAUDE.md), bukan curl langsung ke controller: controller yang menjawab
200 tidak mengatakan apa pun tentang jalur proxy.

Dua perbaikan modal ikut keputusan ini:

**Edit/Save dipindah dari body ke header, di sebelah judul.** `Modal`
mendapat slot `actions` yang dirender sebaris dengan judul: aksi yang
milik dokumen yang dinamai judul harus duduk di sebelahnya, dan tombol
yang melayang di body sebelumnya berpindah posisi setiap kali mode
baca/sunting berganti.

**Scroll textarea dan pratinjau markdown disinkronkan proporsional.**
scrollTop tiap panel sebagai fraksi dari rentang scroll-nya sendiri —
bukan pemetaan baris, karena markdown terender tak pernah setinggi
sumbernya (tabel, heading, spasi) dan pemetaan baris akan langsung
melenceng pada konstruk pertama. Guard anti-echo memakai ref, bukan state:
menulis `scrollTop` panel lain memicu event scroll panel itu, dan tanpa
guard kedua handler akan saling menjawab selamanya; echo tiba pada event
berikutnya, ketika update state masih in flight. Guard dilepas 150 ms
setelah scroll berhenti, sehingga panel yang lain bebas menjadi driver.


## D57 — hasil akhir eksekusi yang datang terlambat mengalahkan parkir watchdog: BLOCKED → COMPLETE; sink tidak lagi menelan galat; endpoint settle

**Keputusan (2026-09-06).** TASK-7A3CC32A terukur hidup dengan keadaan
mustahil: eksekusi `#1` COMPLETE, task-nya BLOCKED. Urutannya terbaca di
event_log: dispatch 21:20 → watchdog memarkir keduanya BLOCKED 21:50
("no runtime event for 1821s") → `end` lifecycle yang asli baru tiba 22:05
(stopReason "stop"). Sink mengeksekusi vonisnya dua langkah: eksekusi
COMPLETE berhasil, lalu `tasks.setStatus(BLOCKED → COMPLETE)` melempar
`illegal task transition` — dan lemparan itu DITELAN oleh catch-all
`handle()`, sehingga rilis lease, entri audit, dan notify scheduler ikut
terlewat bersama dia. Komentar watchdog sendiri sudah meramalkan kasus ini
("the run may even have completed on the gateway while we lost the event"),
tetapi state machine tidak punya tepi untuk mencatat kebenarannya.

**BLOCKED → COMPLETE ditambahkan.** BLOCKED sudah bisa selesai ke FAILED
dan CANCELLED; COMPLETE satu-satunya terminal yang hilang. Parkir watchdog
adalah dugaan dari ABSENSI bukti, bukan bukti kegagalan; `end` yang datang
belakangan adalah bukti, dan bukti menang atas dugaan. Bentuk saudaranya
terukur di log pada hari yang sama ("illegal task transition CANCELLED ->
COMPLETE"): cancel tidak menghentikan run di gateway, jadi run yang
ditinggalkan bisa selesai sendiri. Untuk bentuk ini keputusan operator
MENANG — CANCELLED tetap jalan buntu, task tidak dibangkitkan — tetapi
eksekusi tetap mencatat apa yang sungguh terjadi.

**`applyEnd` kini memeriksa `canTransition` alih-alih melempar ke
catch-all.** Task yang sudah terminal dipertahankan, dengan log
`run.ended-task-unmoved` yang menyebut status dan vonis; rilis lease, entri
audit, dan notify scheduler selalu jalan. Catch-all `handle()` tetap ada —
tetapi sebagai jaring pengaman kejadian tak terduga, bukan sebagai tempat
tinggal permanen bagi galat yang sudah dikenal.

**Endpoint `POST /api/work/tasks/{id}/settle` (admin-only)** memperbaiki
baris yang sudah telanjur divergen: baca eksekusi terakhir yang final,
pakai pemetaan yang SAMA dengan reconciler (`TASK_FOR_EXECUTION`, kini
diekspor supaya dua pemakai tidak berdrift), tolak dengan menyebut
transisinya bila state machine menolak. Aturan 6 melarang memperbaiki
baris dengan tangan, maka perbaikan punya jalur API. TASK-7A3CC32A
diselesaikan lewat endpoint ini setelah deploy.

**Penghapusan task diperluas ke status terminal (melengkapi D54).**
`DELETABLE_STATUSES` kini `CREATED, CANCELLED, COMPLETE, FAILED`: dua yang
baru sama-sama terbukti menganggur, dan revisi yang secara teori bisa
menghidupkan COMPLETE/FAILED kembali adalah persis hal yang sebuah
penghapusan tutup dengan sengaja. QUEUED, WAIT_*, DISPATCHED, RUNNING,
BLOCKED, RESUMABLE tetap tertolak — BLOCKED termasuk yang tertolak karena
ia pekerjaan yang DIPARKIR untuk dilihat manusia, bukan pekerjaan yang
selesai.


## D58 — dokumen memory/ bisa disunting dari Command Center (membatalkan pembatasan D55)

**Keputusan (2026-09-06, operator).** Paragraf ketiga D55 mengunci
`memory/` (blueprint, decisions) dari PUT dengan alasan ia wilayah
bootstrap dua-tingkat agen — controller yang menulis memori agen adalah
penulis kedua atas berkas yang bukan miliknya. Operator memutuskan
sebaliknya: agen hanya MEMBACA berkas-berkas itu (spec §9), jadi
keputusan operator tentang isinya lebih berwenang daripada keengganan
controller menulisnya. Sejak D58, PUT
`/api/work/projects/{id}/docs/{name}` menerima SEMUA nama whitelist —
`WRITABLE_DOCS` dihapus; whitelist-nya kini `DOC_DIRS` itu sendiri,
sama persis dengan GET.

**Yang tetap dijaga:** whitelist nama (tidak ada segmen path dari request
yang sampai ke filesystem), controller hanya menulis atas PUT eksplisit
operator — tak pernah atas inisiatif sendiri — dan setiap penyimpanan
tercatat di event_log sebagai `project.doc-updated`. Tes yang dulu
mengasertikan penolakan memory/ diganti tes penyimpanan + audit
`memory/blueprint.md`. UI tidak lagi menghakimi lebih dulu: Edit muncul
untuk setiap dokumen yang termuat, dan bila controller suatu hari menolak
sebuah nama lagi, kegagalannya tampil apa adanya lewat `saveError`.


## D59 — groq dan cerebras pindah keluarga reset: per-menit + harian

**Keputusan (2026-09-06, operator).** D51 menaruh groq di keluarga
langganan (5 jam + mingguan) bersama zai/claude-code — saat itu groq
hanya membawa QWEN dan belum pernah menabrak dindingnya. Operator
meluruskan: kuota Groq **dan** Cerebras me-reset **per menit + per hari**,
sama seperti Gemini. `QUOTA_WINDOWS_BY_PROVIDER` kini punya tiga anggota
di keluarga per-menit+harian (`google`, `groq`, `cerebras`) dan dua di
keluarga 5-jam+mingguan (`zai`, `claude-code`); backfill migrasi D51
diperluas supaya DB yang migrasinya terlambat tidak berbeda pendapat
dengan `create()`.

**Konsekuensi perilaku yang disengaja:** kegagalan kuota groq/cerebras
kini masuk kelas retry-in-place D52 (jendela terpendek < 10 menit →
`WAIT_QUOTA` satu jendela, maksimum 10×), bukan lagi backoff `WAIT_RESOURCE`
30 dtk→15 menit — dinding 60 detik memang tidak layak ditunggu dengan
backoff 15 menit. Konsekuensi data: Brain groq/cerebras yang **sudah
tersimpan** sebelum D59 masih memegang 5 jam + mingguan di
`quota_reset_short_ms`/`quota_reset_long_ms`-nya (backfill lama sudah
dijalankan cluster dan tidak ditulis ulang) — baris itu DIREKOMENDASI
dipatch operator lewat `PATCH /api/work/brains/{id}` ke 60000/86400000;
tabel default hanya mengikat Brain yang dibuat setelah D59. Cerebras
tetap tertahan billing 402 (lihat readiness) — jendela ini menunggu
kreditnya terisi, bukan sebaliknya.


## D61 — Test Brain harus mengatakan MENGAPA run gagal: error agent.wait bentuk string ikut dibaca

**Temuan (2026-09-06, halaman /settings Brain).** Tiga Brain gagal test
dengan dua penyakit berbeda yang tampak sama di UI:

- `qwen-high`/`qwen-medium` — armada TIDAK punya agen bermodel
  `groq/qwen/qwen3.6-27b` (agents.list: hanya `main`, `sdmk-kader-*`,
  probe cerebras). Pesan "Connection test needs an existing agent
  bound…" itu JUJUR; tidak ada yang bisa diuji tanpa agen. Agen probe
  `sem-workspaces-probe-groq-groq-qwen-qwen3-6-27b` lalu diprovision di
  `workspaces/probe/groq` memakai `scripts/provision-agents.mjs`
  (identitas controller membawa operator.admin sejak 2026-08-21).
- `cerebras-qwen-3-8-27b` — dispatch DITERIMA lalu run ditolak:
  `Thinking level "high" is not supported for cerebras/qwen-3.8-27b.
  Use one of: off.` Agen probe cerebras kini hanya mengiklankan
  `["off"]` — kosakata off…high yang tercatat di readiness adalah hasil
  probe sebelum agen itu berubah. Test-nya benar gagal; yang salah adalah
  pesannya.

**Bug yang diperbaiki:** `agent.wait` menyampaikan penolakan run dalam
dua bentuk — string polos (terukur: kasus cerebras di atas) atau objek
`{message}`. `testAgent` hanya membaca bentuk objek, sehingga setiap
penolakan bentuk string terdegradasi jadi "run did not complete
normally" dan operator kehilangan satu-satunya kalimat yang menjelaskan
penyebabnya: penolakan level thinking terbaca seperti outage. Kini kedua
bentuk dibaca.

**Bug kedua yang diperbaiki (terukur pada kasus qwen):** `agent.wait`
berhenti mematui di ~30 dtk dan menjawab `status:"timeout"` selama run
masih diantrikan; vonis sebenarnya — `FailoverError: API rate limit
reached` dari groq free tier — baru muncul pada wait KETIGA (~90 dtk).
`testAgent` berhenti di wait pertama, sehingga antrian provider
terbaca "possible hang" dan laporan rate limit yang jujur hilang. Kini
ia menunggu ulang selama gateway masih menjawab timeout, dibatasi
jendela pemanggil — default test naik 45 dtk → 120 dtk agar muat 3-4
wait. Pesan timeout juga jujur soal siapa yang menyerah: durasi nyata
menunggu, bukan jendela yang diminta.

**Batas yang tetap:** Test mengirim level thinking hanya untuk Brain
`guaranteed` — itulah jalur yang dipakai dispatch nyata (D31); untuk
`preference` level tidak pernah dikirim, jadi mengujinya berarti
mengukur jalur yang tidak pernah dipakai. Karakterisasi level lintas
kandidat tetap pekerjaan tombol Probe terpisah. Cerebras juga tetap
tertahan billing 402 — perbaikan pesan tidak mengubah dindingnya.


## D62 — deep-dive groq & cerebras: dinding yang tidak hilang oleh reset

**Groq — bukan rate limit yang bisa ditunggu, tapi ITPM vs ukuran prompt.**
Probe langsung ke `api.groq.com` dari dalam container gateway (kunci
tidak pernah dicetak): permintaan mungil **200 OK** dengan headroom
besar (999/1000 request), tapi `x-ratelimit-limit-tokens: 8000`. Kirim
prompt ~20rb token → **413** dengan pesan telak: `input tokens per
minute (ITPM): Limit 7000, Requested 20011` untuk `qwen/qwen3.6-27b`,
plus `x-should-retry: false`. Run gateway historis membawa prompt
**10.408 token** — selalu di atas ITPM free/on-demand tier. Semua model
groq di kunci ini terukur sama: 7000 (qwen3.6-27b, qwen3.8-27b) dan
8000 (gpt-oss-20b/120b, safeguard); `qwen/qwen3-32b` tersedia tapi
dindingnya sama. Jadi FailoverError "API rate limit reached" yang
muncul di Test bukan jendela yang akan reset — D59 benar soal keluarga
jendela groq (per-menit+harian ADA di API), tapi untuk dispatch agen
dinding efektifnya adalah **ITPM < ukuran prompt, yang tidak pernah
hilang**. Satu-satunya jalan: upgrade ke Dev Tier berbayar. Efek samping
yang diterima: task yang dispatch ke Brain groq memakai kosakata
"rate limit" dari FailoverError → parkir `WAIT_QUOTA` 10× lalu BLOCKED —
jujur, walau boros.

**Cerebras — level menyusut karena `reasoning:false`, bukan perubahan
model.** `models.list` gateway melaporkan `reasoning: false` untuk
`cerebras/qwen-3.8-27b` → agen mengiklankan `["off"]` saja. Probe awal
yang mencatat kosakata off…high ternyata divalidasi terhadap model
DEFAULT (zai/glm-4.7) — pelajaran D21 terulang di tingkat kosakata.
Probe langsung tanpa level: **402 payment_required**
(`x-should-retry: false`) — akun tanpa kredit. Brain
`cerebras-qwen-3-8-27b` ditambal `thinking: null` (evidence diperbarui)
supaya satu-satunya dinding adalah billing; Test kini melaporkan 402
apa adanya, dan begitu kredit terisi brain langsung dispatchable tanpa
level — level karakterisasi ulang lewat tombol Probe setelahnya.

**Kunci yang bocor di config:** kunci cerebras ternyata tersimpan
menulis di `openclaw.json` (groq sudah benar memakai file-secret).
Tidak diubah hari ini — mencatatnya supaya rotasi kunci berikutnya
memindahkannya ke secret file seperti yang lain.


## D63 — POC-6 fase 1: kuota per-provider jadi driver, bukan dua kolom ms

**Masalah.** D51 memberi Brain dua durasi (`quota_reset_short_ms/long_ms`),
dan itu menjawab "berapa lama jendelanya" — bukan "kapan ia buka lagi".
Google mereset RPD **tengah malam Pasifik** (momen jam-tetap, sadar DST);
groq menggelinding dari konsumsi pertama; cerebras mengisi bucket. Dua
angka ms tidak bisa membedakan ketiganya, dan dinding yang BUKAN jendela
(groq 413 struktural D62, cerebras 402) diparkir 10× WAIT_QUOTA /
5× WAIT_RESOURCE padanya tidak akan pernah berubah jawabannya.

**Keputusan.** Satu registry driver per provider
(`src/domain/quota-drivers/`): `defaults({model})` (tier, dua jendela
dengan TIPE, deskriptor jam-tetap, laju), `nextReset(window, ctx)` (aturan
ETA tunggal: sinyal provider menang (D51, epoch detik dinormalisasi);
fixed-time → kejadian jam-dinding berikutnya via `Intl`, sadar DST;
token-bucket → pace maks satu jendela pendek; rolling/credits → anchor +
ms, fallback konservatif), dan `classifyError({status,text})` (kosakata
kuota generik D52 TIDAK boleh dipersempit driver — hanya boleh MENAMBAH
pola fatal; 402/401 otomatis fatal). `genericDriver` = perilaku hari ini
via `makeClassifier`, fallback provider tak dikenal.

**Fakta yang dipegang tiap driver** (sumber di spec POC-6 §3):
google free tier — RPM/RPD **per model** dari halaman rate limit AI Studio
(2026-09-06: 2.5-FL 10/20, 3.1-FL & 3.5-FL 15/500, 3.7-Flash 5/20; TPM
250rb seragam), harian = fixed-time tengah malam `America/Los_Angeles`.
groq free — rolling 60 dtk/24 jam, **tpm 7000 = angka terukur, bukan 8000
iklanan**; 413 "Limit N, Requested M" → fatal `structural:true`. cerebras
free-trial — short **token-bucket** (pace cap 60 dtk). zai lite — credits
5 jam rolling + 10rb/minggu **anniversary** (cycleAnchor tak diketahui
controller → fallback konservatif). claude-code pro — fixed-time 5 jam +
mingguan tapi jam anchor belum terukur → `fixedReset:null` (fallback
rolling, tidak mengklaim jam yang tidak diketahui). mistral free — RPS+TPM
per model, angka hanya ada di Admin Panel → laju null jujur; model pool
magistral/codestral/mistral-small (sudah teregistrasi via AgentOS).

**Skema.** `brains` bertambah 9 kolom (quota_tier, quota_short_type,
quota_long_type dengan CHECK taksonomi, quota_fixed_reset JSON, rpm, rpd,
tpm, tpd, context_window_tokens). Migrasi D63 menambah kolom dan
**backfill dari registry** — satu sumber kebenaran dengan jalur create;
patch operator eksplisit (kolom ms lama) TIDAK ditimpa. Resource
`(provider, model)` dikunci `(provider, quota_tier)` secara konseptual:
kuota milik paket, bukan Brain.

**Perilaku baru yang terukur di jalur runtime** (regresi 2 test baru +
16 test driver): late-error groq 413 → **BLOCKED langsung** dengan alasan
yang menyebut perbaikan sebenarnya (bayar/prompt lebih kecil), budget
retry tak tersentuh, resource TIDAK diwedge (task yang blocked adalah
bukti yang dilihat operator — QUOTA_EXHAUSTED tanpa jam lepas tak pernah
dilepas scheduler). Dispatch refusal tanpa jam di jendela panjang → parkir
WAIT_QUOTA pada ETA jendela PANJANG driver (zai: 7 hari) — sebelumnya
`nextRetryAt:null` lalu park() menggantinya backoff 30 dtk, jendela
mingguan dilepas seperti cegukan. Gateway catch kini konsultasi driver
saat gate generik meleset ("RESOURCE_EXHAUSTED" google tidak memuat
"rate limit"/"429").

**Test:** 436 → 454 (`quota-drivers.test.mjs` 16: registry, defaults
per-model google, ETA rolling/fixed-time DST dua arah (fall-back
2026-11-01 & spring-forward 2026-03-08)/token-bucket cap/anniversary,
klasifikasi fatal 402/401/413, migrasi DB pra-D63 dengan backfill;
`quota-retry.test.mjs` +2: 413 groq late-error BLOCKED, ETA panjang
clockless).

**Yang BELUM (fase 2+, spec POC-6 §8.2+):** `promptBudget(brain)` dan
pipeline kompaksi/fragmentasi §6 — itu yang benar-benar menaikkan
dinding groq; kolom UI baru (quotaReset di GET /api/work/brains sudah
membawa tier/tipe/fixedReset/rates, tampilan menyusul); karakterisasi
ulang angka mistral saat Admin Panel bisa dibaca; anchor jam claude-code
5 jam belum terukur.


## D64 — resolusi driver lewat alias label, dan `brains.category` dihapus

**Nama provider bukan kontrak.** `brains.provider` adalah LABEL yang
dipilih operator saat mendaftarkan models-config di gateway — bukan nama
kanonik. Bukti hidupnya: pool mistral terdaftar di AgentOS sebagai
`mistral-custom`. Resolusi D63 membandingkan `provider === id driver`,
jadi label itu jatuh senyap ke `genericDriver` — jendela null, tanpa
parkir anggaran bulanan, TANPA peringatan apa pun. Keputusan: setiap
driver mendeklarasikan `providerKeys` (label gateway yang dijawabnya);
`quotaDriverFor` mencocokkan case-insensitive terhadap id + kumpulan
kunci itu. Sinyal struktural yang sesungguhnya adalah host baseUrl
provider (`api.mistral.ai` tidak bisa berbohong tentang dirinya), tapi
`models.list` tidak membawa baseUrl (diverifikasi di cache hidup:
provider, model, name, reasoning, available saja) — jadi whitelist host
menyusul bila gateway mengeksposnya; sampai itu, tabel alias adalah
mekanismenya dan hanya boleh berisi label yang benar-benar terlihat di
`models.list`. Permukaan baru: `GET /api/work/quota-drivers` (katalog
label→driver) dan anotasi `quotaDriver` per brain di `GET /api/work/brains`.

**`brains.category` dihapus (DROP COLUMN, migrasi D64).** Alasannya
fakta, bukan selera: sejak Brain Map per (template, role, level) (D45),
jalur dispatch tidak pernah mengoper kategori ke `brainMap.resolve` —
kedua pemanggil resolve (server role-levels & brain-map preview) hanya
mengirim template/role/level. Penyaringan `category` di lapisan fallback
kandidat adalah kode mati, dan field form-nya menampilkan sesuatu yang
tampak berarti padahal tidak pernah dibaca. `candidatesFor` kini pool
murni per level; penyemaian dari katalog routing berhenti menurunkan
kategori. Task/plan-step `category` (untuk RoutingPolicy) tidak tersentuh
— itu semantik berbeda yang masih hidup.

**Form Brain bersumber dari registry hidup.** Opsi provider/model kini
dari cache `gateway_models` + provider/model brain yang sudah ada
(claude-code adalah harness ACP dan tidak pernah muncul di models.list —
tanpa brain yang ada, brain claude jadi tak bisa disunting). Katalog
routing statis keluar dari union opsi (sumber kesan "fix"); ia tetap
hanya sebagai pintasan "Copy from catalog" yang berlabel eksplisit.
Field provider menunjuk driver yang memiliki label itu — peringatan
jelas saat sebuah label akan jatuh ke generic.

**Rev.3 (masih hari yang sama, koreksi aturan operator):** union tiga
sumber masih terlalu longgar — provider yang modelnya DIHAPUS dari
AgentOS tetap muncul (phantom), dan cache yang harus di-refresh manual
adalah sumber kekakuannya. Aturan final: dropdown provider = **(provider
brain yang ada ∪ semua `providerKeys` driver) ∩ `models.list` LIVE**.
Panel bertanya ke gateway sungguhan setiap dibuka (cache hanya cat
pertama sebelum jawaban live tiba — D38 "jangan bertanya tiap kali
dibuka" dilonggarkan atas instruksi operator, dengan efek samping cache
menyembuhkan diri); hapus model dari AgentOS → providernya hilang dari
form meski drivernya ada. Satu carve-out: label harness ACP
(`claude-code`) — dispatchable tapi memang tidak pernah muncul di
models.list; selain itu field tetap bebas diketik.

**Test:** 454 → 456 (alias + katalog; migrasi D64 dengan baris selamat).
Batas diketahui: tidak ada peringatan runtime saat brain provider
menangkap generic driver oleh label tak dikenal — anotasi ada di API/UI,
deteksi otomatis menyusul bila dibutuhkan.


## Open questions for phase 4+

1. ~~**Approval bridge for ACP tasks.**~~ **Resolved.** The interposer ships in gateway image `2026081905` and the controller exposes the endpoints it calls (`POST /api/work/approvals`, `GET /api/work/approvals/{id}`). Remaining gap, inherited from POC-3: Claude Code does not raise a permission request for `Bash`, so shell commands are not yet gated. The lever is a `settings.json` in the harness `$HOME`; until that lands, L2/L3 shell classification is dead code.
2. **Status reconciliation.** POC-2 E3/E7 found AgentOS dispatch records that stay `running` or report `timeout` after the work succeeded. The controller must not trust a single poll; reconciliation strategy is a phase-4 decision.
3. **Fairness window length.** Currently 24 hours. Whether that matches how the team actually experiences fairness is an empirical question for the §12.4 evaluation.
4. **`claude-code` concurrency.** Modelled as an ordinary resource, but a Pro subscription's real limit is a rolling usage window rather than a concurrency count. Needs POC-3 E8 numbers.

## D65 — Test Brain otomatis melakukan auto-provisioning probe agent

**Masalah.** Test Brain baru terjebak "lingkaran setan": tidak bisa di-test
sebelum ada agen, dan agen hanya dibuat oleh skrip operator (provision-agents.mjs).
UI mengeluh "No agent is currently provisioned", mengharuskan operator membuka
terminal, menjalankan skrip, baru kembali ke UI untuk menekan Test — pengalaman
pengguna yang buruk untuk verifikasi provider baru.

**Keputusan.** Tombol "Test" kini secara otomatis melakukan ensureProbeAgent
(menggunakan RPC agents.create) jika agen untuk (provider, model) tidak
ditemukan (kecuali claude-code yang ACP-path). Ia membuat agen dengan nama
konvensional sem-workspaces-probe-<provider>-<slug> di workspace workspaces/probe/<provider>
(mengikuti pola probe agent yang sudah ada).

**Batas.** Ini HANYA untuk aksi Test eksplisit, BUKAN reshaping fleet otonom saat
scheduling. Aksi operator (tombol Test) = pengecualian yang sah dari aturan
"provisioning stays a script". Jika agents.create gagal (scope/izin),
error-nya disurfasikan ke UI sebagai hasil Test — jujur, bisa ditindaklanjuti.
Agen probe yang tercipta tetap ada (mengikuti konvensi probe agent),
sehingga tes berikutnya untuk model yang sama langsung lolos resolve.
(Sinkron dengan D64 rev.3: provider dropdown kini ter-reduksi ke live,
dan auto-provision ini menutup celah pengalamannya).

**Rev.2 (2026-09-06, setelah tombol Tetap gagal di cluster).** Implementasi
pertama D65 menelan setiap kegagalan `ensureProbeAgent` dan menjawab pesan
lama "No agent is currently provisioned … pin one via Brain Map" — sehingga
kegagalan nyata tidak pernah sampai ke operator. Pengukuran langsung di
cluster (mistral-custom/codestral-latest):

1. **Akar EACCES:** `agents.create` menjalankan `ensureAgentWorkspace` →
   `fs.mkdir(workspace, {recursive})` **sebagai uid gateway (1000)**
   (entrypoint image menurunkan privilese; `docker exec` tanpa `-u`
   berjalan sebagai root dan MENIPU — mkdir "berhasil" di exec while
   PID 1 gagal). `workspaces/probe/` di NFS dimiliki root:root 755, jadi
   uid 1000 tidak bisa membuat direktori provider baru. Probe groq/
   cerebras selama ini hidup karena direktorinya sudah dibuat operator
   dengan ownership yang benar. Perbaikan ops (sekali, di node):
   `chown 1000:1000` direktori `workspaces/probe/` — gateway dan
   controller sama-sama uid 1000, sesuai konvensi mount.
2. **Bentuk respons `agents.create`:** payload membawa `agentId`
   (hasil `createAgent` di gateway: `{status, agentId, name, workspace,
   …}`), bukan `id` — pembacaan `payload?.id` selalu jatuh ke fallback
   nama. `createProbeAgent` kini membaca `agentId ?? id ?? name`.
3. **Kontrak baru `runBrainTest`:** kegagalan provisioning →
   `reason:"provision-failed"` dengan error gateway apa adanya (plus
   petunjuk chown bila EACCES); sukses provisioning tapi belum
   ter-advertise di `agents.list` → tetap diuji pakai id yang dipegang
   (agen yang benar-benar rusak menolak dengan kata-kata gatewaynya
   sendiri — lebih jujur daripada menyangkal agen yang baru dibuat);
   respons membawa `provisioned:true` agar log/UI bisa membedakan.
4. **Workspace fallback mutlak:** fallback lama
   `workspaces/probe/<provider>` RELATIF — melanggar kontrak mount
   (path host = path container); kini workspace selalu absolut, diturunkan
   dari probe agent hidup (…/workspaces/probe/<provider>) atau root
   konvensional (env `SEMANGGI_PROBE_WORKSPACE_ROOT`).

**Test:** 456 → 460 (auto-provision sukses + uji by-id saat re-list kosong +
surfas kegagalan EACCES + runtime tanpa createProbeAgent).

## D66 — Model Map: resources + thinking-levels jadi milik operator, berkas turun jadi seed

**Masalah.** Dua dari tiga berkas konfigurasi model (`resources.json`,
`thinking-levels.json`) hanya bisa diubah lewat sunting berkas + sync + restart,
padahal keduanya TIDAK dipakai jalur dispatch sebagai berkas: admission membaca
tabel `resources` (D42-class), dan tabel `thinking_levels` hanya dibaca endpoint
API/probe — pemeriksaan thinking saat dispatch memakai iklan agen live
(agent-registry), bukan tabel ini. Yang menghalangkan kepemilikan DB selama ini
justru arah seeding: thinking-levels di-refresh PENUH dari berkas di SETIAP boot
(app.mjs lama) — artinya file > DB, dan setiap suntingan operator atau hasil
probe di DB hilang diam-diam pada restart berikutnya. Celah tambahan:
`POST /api/work/resources` tanpa guard admin dan tanpa event_log.

**Keputusan.** Halaman Settings → Model Map (panel UI baru) menjadi pemilik
kedua tabel itu:

1. `GET /api/work/model-map` — join kedua tabel per (provider, model)
   (domain/model-map.mjs). Baris satu sisi TETAP tampil: resource tanpa
   pengukuran, dan pengukuran tanpa baris resource (yang memarkir task di
   WAIT_RESOURCE) — persis masalah yang dicari operator di halaman ini.
   Tidak ada brains di join ini: Brain adalah endpoint routing
   (model+thinking+mode), grain-nya berbeda; halaman Brains/Brain Map tetap
   pemiliknya.
2. `PATCH /api/work/resources?provider=&model=` — hanya bidang kebijakan
   (creditClass, concurrencyLimit, quotaPolicy, windowKind). Provider/model
   jadi query param, bukan path segment, karena model id groq mengandung "/"
   ("qwen/qwen3.6-27b") yang tak akan selamat dari proxy catch-all AgentOS.
   Field tak dikenal DITOLAK (bukan diabaikan — kelas bug D36).
   `availability`, `next_available_at`, `last_quota_signal` terbawa apa adanya:
   operator menyunting kebijakan tidak boleh bisa me-reset sinyal 429 live.
3. `PUT /api/work/thinking-levels` — tulis operator untuk fakta terukur;
   `effortMode=preference` tanpa evidence ditolak (aturan yang sama dengan
   brains.create). Jalur yang diutamakan tetap probe (D38) — edit manual untuk
   model yang tidak bisa di-probe.
4. Semua tulis admin-only + event_log (`resource.policy`,
   `thinking-levels.updated`) + membangunkan scheduler.
5. app.mjs: seed thinking-levels HANYA saat tabel kosong (pola D35 brains).
   Berkas tetap seed instalasi baru; import eksplisit tetap ada lewat
   `POST /api/work/gateway/thinking-levels/refresh`.

**Yang tidak berubah.** `routing.json` (katalog+routes) tidak disentuh — itu
ranah Fase 3 (kelompok peer per sel brain-map, bukan per baris model): grain
routing adalah endpoint, bukan model, dan urutan preferensi lintas model tidak
bisa dinyatakan dari keanggotaan per-model. Lihat analisis 2026-09-06 sebelum
D66.

**Test:** 460 → 467 (merge dua sisi + satu sisi, GET agregat, PATCH menjaga
sinyal live + event + validasi, PUT thinking-levels + evidence wajib untuk
preference, restart tidak menimpa suntingan operator).

## D67 — Penghapusan baris Model Map + Brain, dan urutan menu Model Map

**Masalah.** Model Map (D66) bisa menambah dan menyunting tapi tidak menghapus;
Brains punya `DELETE /api/work/brains/{id}` di controller (dipakai membersihkan
pemaku brain_map yang menggantung) tapi tidak pernah diekspos proxy AgentOS,
jadi form Edit Brain tidak punya jalan keluar yang jujur untuk Brain yang
provider-nya pergi. Menu: entri Model Map disisipkan setelah Brain Map, padahal
urutan baca operator adalah Project → Model Map → Role Level Map — model
mendahului role yang mengonsumsinya.

**Keputusan.**

1. `DELETE /api/work/model-map?provider=&model=` — admin-only, menghapus SATU
   baris KEDUA sisinya (resources + thinking_levels). Menyisakan satu sisi
   berarti baris yang baru dihapus muncul kembali sebagai baris "no resource
   entry" — penghapusan setengah bukan penghapusan. Query param seperti PATCH
   (model id groq mengandung "/"). Event `resource.policy` /
   `thinking-levels.updated` dengan `change:"delete"` + bangunkan scheduler.
2. Penolakan penghapusan adalah FAKTA SERVER, bukan tebakan klien:
   `GET /api/work/model-map` membawa `deleteBlockers` per baris
   (modelDeleteBlockers di domain/model-map.mjs), dan DELETE menolak dengan
   alasan yang sama. Empat rujukan memblokir:
   - katalog models.list (aturan operator: model yang masih dikatalogkan
     tidak boleh dihapus dari halaman — task yang dirutekan ke sana akan
     parkir WAIT_RESOURCE),
   - seed `resources.json` (baris yang dihapus tapi masih di-seed akan HIDUP
     KEMBALI pada restart berikutnya — boot seeding bersifat per-baris dan
     idempoten; itu sebabnya app.mjs kini mengembalikan `seedResources`),
   - brains yang menunjuk (provider, model) ini (turun kelas diam-diam),
   - eksekusi DISPATCHED/RUNNING pada model ini (baris dihapus dari bawah
     task yang berjalan).
   UI cukup membaca `deleteBlockers` untuk men-disable tombol Delete —
   aturan yang dihitung ulang di klien adalah tempat klien dan server
   diam-diam berbeda pendapat.
3. Form Edit Brain: tombol Delete (footer, varian danger) yang hanya aktif
   bila brain TIDAK sedang dipakai — dipaku brain_map (per id) dan/atau
   menjadi default grid DEFAULT_BRAIN_MAP (per nama slug; konstanta kode —
   menghapus brain yang jadi default membuat sel tak terpaku jatuh ke
   kandidat level tanpa jejak). Gate ini di UI; endpoint DELETE server tetap
   menerima (membersihkan pemaku menggantung) sebagai jaring pengaman.
   Proxy whitelist +`DELETE work/brains/{id}` (baru diekspos sekarang;
   route controller sudah ada).
4. Kedua form (Add/Edit Model, Add/Edit Brain) menaruh aksi di kanan bawah
   (Delete | Cancel | Save) — aksi milik baris yang diedit form itu, bukan
   judulnya. apply.sh: `patch_settings_model_map_position` memindahkan entri
   menu Model Map ke antara Project dan Role Level Map; jangkar berbasis id
   section (label di fork cluster sudah dua kali di-rename).

**Yang tidak berubah.** Semantik `DELETE /api/work/brains/{id}` (clear-mappings)
dan routing.json (Fase 3). Thinking-levels yang dihapus bersama resource-nya
bisa ditulis ulang kapan saja lewat PUT/probe — pengukuran bukan alasan
memblokir penghapusan.

**Test:** 467 → 469 (modelDeleteBlockers murni; DELETE ujung-ke-ujung:
menghapus kedua sisi + event, menolak katalog/brain dengan alasan, 404,
identity wajib).

## D68 — Brain Map memegang daftar failover terurut; selection diturunkan per percobaan dispatch

**Masalah.** Satu sel brain_map memaku SATU Brain — satu titik kegagalan:
Brain itu habis kuota/UNAVAILABLE → task parkir padahal ada peer setara. Rencana
operator (fase 2 mereka; dokumen lama menyebut fase 3) adalah daftar peer per
sel dengan usul asli: penunjuk tersimpan per task ("sedang di anggota ke-i",
i++ saat gagal, reset saat task baru/restart). Penunjuk yang bertahan membuat
task lama menolak Brain yang sudah sembuh — fail-back tidak pernah terjadi
tanpa aturan reset tambahan, dan tiap aturan reset adalah keadaan baru yang
bisa basi.

**Keputusan.**

1. Skema: baris brain_map kini (template, role, level, **position**, brain_id),
   PK + position. Migrasi membentuk ulang tabel; pemaku tunggal lama menjadi
   list satu-anggota posisi 0 — semantik lama bertahan persis. Posisi boleh
   berlobang setelah brains.delete (urutan dibaca ORDER BY position; penulisan
   sel selalu menomori dari 0).
2. `set()` menerima `brainIds[]` terurut (`brainId` skalar = list satu-anggota,
   jalur lama). Ditolak saat disetel: anggota tak dikenal, anggota kembar,
   dan daftar yang SELURUHNYA dimatikan (sel yang tidak pernah jalan — kelas
   `config-only` D32; list satu-anggota yang mati kena aturan yang sama).
   Anggota dimatikan DI TENGAH daftar diperbolehkan: itu keadaan hidup, bukan
   konfigurasi — diskip saat resolve dengan alasan, tetap di `names`, dan
   menang kembali begitu dihidupkan.
3. Selection TIDAK disimpan sama sekali. `resolve()` mengembalikan
   `candidates` (anggota hidup terurut) + `skipped` (alasan per anggota) +
   `names` (urutan untuk preferred, termasuk yang dimatikan). Task membawa
   `names` di `model_policy.preferred`; admission SUDAH berjalan melewati
   preferred secara berurutan (D42) dan memilih penyintas pertama — evaluasi
   ulang per percobaan dispatch memberi failover DAN fail-back gratis, dan
   "reset saat task baru" menjadi korolari, bukan aturan tersendiri. Parkir
   kuota memakai ETA terkecil lintas anggota (perilaku admission yang sudah
   ada, kini menjangkau seluruh rantai sel). Dispatch log membawa
   `preferredIndex` — "menang di posisi 2 dari 4" adalah cerita jujur saat
   pilihan pertama tumbang.
4. Lapisan resolusi tidak berubah urutannya: pemaku → default grid
   (list satu-anggota) → pool level. Yang berubah: pool level kini menjadi
   DAFTAR penuh (urut nama) — sel yang tak pernah disentuh operator pun punya
   rantai failover, bukan satu nama. `routing.json` routes tetap hidup hanya
   untuk task ber-kategori-tanpa-preferred (buatan API tangan); setelah
   registerTasksFromDoc ikut membawa preferred (bawah), tidak ada lagi
   permukaan Semanggi yang membuat task begitu.
5. GET brain-map mengelompokkan baris jadi sel (`mappings[].brains[]` dengan
   position/belowLevel/stale per anggota). PUT menerima `brainIds[]`;
   `[]`/null melepas sel. UI: sel menampilkan daftar bernomor (chip per
   anggota) dan modal editor dengan baris bernomor ↑/↓/× — bukan chip inline
   dan bukan drag-and-drop: URUTAN adalah seluruh makna sel ini, jadi
   kontrolnya harus membuat posisi terlihat dan disengaja. Project Role Level
   modal menampilkan rantai sebagai "+N" (tooltip urutan penuh); langkah
   rencana Control page juga.
6. registerTasksFromDoc (pendaftaran dari docs/tasks.md) kini meresolusi
   level + daftar Brain per role dengan aturan yang sama dengan dekomposisi —
   task dokumen membawa rantai failover, bukan kategori routing yang menebak
   lewat config.

**Yang tidak berubah.** Aturan belowLevel (peringatan, bukan penolakan);
default grid tidak menghidupkan Brain yang dimatikan; brains.delete tetap
membersihkan keanggotaan; D67 delete gate kini membaca KEANGGOTAAN sel (query
brain_id tak berubah, hanya kardinalitasnya).

**Test:** 469 → 476 (daftar terurut tersimpan + names membawa seluruhnya;
anggota dimatikan diskip dengan alasan + fail-back otomatis; seluruh daftar
mati/kembar/tak dikenal ditolak; pool level jadi daftar penuh; PUT end-to-end
terurut sampai ke preferred task; PUT kembar ditolak tanpa menyentuh sel).

## D69 — Memarkir ulang task yang sudah menunggu bukan transisi

**Ditemukan di cluster, bukan di review.** Controller crash loop, restart sekali per tick scheduler:

```
Error: illegal task transition WAIT_WORKSPACE -> WAIT_WORKSPACE
  at assertTransition (state-machine.mjs:136)
  at park (admission.mjs:307) → tick (admission.mjs:607) → pass → drain
```

TASK-05C65CF2 menunggu lease workspace `sdmk-kader` yang dipegang TASK-2C56D3A8#1. Admission mengevaluasi ulang task yang menunggu pada **setiap** pass dan memarkirnya ulang dengan detail baru — dan detail WAIT_WORKSPACE memuat `expires_at` lease pemblokir (`admission.mjs:145`), yang bergerak tiap kali pemegangnya memperpanjang. `setStatus` hanya short-circuit kalau status **dan** detailnya identik byte-per-byte, jadi ETA yang menyegar jatuh ke `assertTransition(WAIT_WORKSPACE, WAIT_WORKSPACE)` dan melempar. Pass mati, proses ikut mati, Swarm merestart, tick berikutnya mengulanginya. Terukur: satu crash tiap ~30 detik.

**Keputusan: sempitkan KAPAN asersi berjalan, bukan APA yang ditolak.** Diam di tempat bukan perpindahan, jadi bukan urusan `assertTransition`. Hanya perpindahan antar-state yang diperiksa:

```js
if (task.status !== next) assertTransition(task.status, next, { reason });
```

**Alternatif yang ditolak:** menambah tepi `WAIT_x → WAIT_x` ke tabel TRANSITIONS. Itu akan menyatakan bahwa memarkir ulang adalah perpindahan yang sah, padahal ia bukan perpindahan sama sekali — dan melemahkan tabel untuk kasus yang tidak ada.

Detail yang menyegar tetap **ditulis**: ETA baru adalah satu-satunya hal yang berubah bagi operator yang menunggu, dan membuangnya akan memperbaiki crash dengan cara membekukan informasi.

**Test:** 476 → 481. Dibuktikan menangkap bug — dengan fix dikembalikan, 2 dari 5 gagal. Yang dipaku: re-park detail segar tidak melempar dan ETA barunya sampai; re-park identik tetap no-op (event log tidak berisik); keempat state WAIT_* diperlakukan sama; dan dua guard lama TIDAK ikut longgar (`CANCELLED → QUEUED` masih ditolak, `COMPLETE → QUEUED` masih menuntut revision).

**Terverifikasi hidup:** nol crash sejak sync, sesudahnya antrean bersih dari WAIT_WORKSPACE.

## D70 — AgentOS 0.7.7 di atas gateway 2026.7.1, dan migrasi auth yang satu arah

**Fork disusulkan ke `agentos-v0.7.7`** (`741bbff9`). Titik cabang `ad841691` ternyata leluhur tag itu, jadi ini penyusulan 36 commit hulu, bukan pelurusan sejarah. Hulu menyentuh 210 berkas, Semanggi 35; **hanya 8 beririsan, 3 berkonflik** — arsitektur overlay `apply.sh` terbayar persis seperti alasannya ditulis. Nol dependensi baru (`pnpm-lock.yaml` tidak berubah). Delapan dari delapan jangkar `apply.sh` juga masih menempel pada 0.7.7 pristine, jadi jalur pemulihan alternatif tetap hidup.

**Baseline versi hanya diagnostik.** `OPENCLAW_SUPPORTED_BASELINE_VERSION` naik ke `2026.8.1` (bukan 2026.8.2 seperti yang dikira), tetapi dipakai hanya untuk teks pesan, flag readiness, dan alur *update* OpenClaw — tidak ada di jalur chat/mission/agent. Gerbang sesungguhnya **tidak berubah**: protokol baseline tetap 4, dan 18 id operasi wajib identik dengan sebelumnya. Konsekuensi yang MUST diterima, bukan dilaporkan sebagai bug: diagnostik akan terus menyatakan gateway di bawah baseline selama gateway 2026.7.1.

**Gerbang identitas baru lolos, dan alasannya bisa diukur.** 0.7.7 menambah `requireAgentOsOpenClawPreflight` di 11 route: `grantedScopesKnown = Array.isArray(hello.auth?.scopes)`; `false` → 503, scope kurang → 403. Diukur langsung ke gateway 2026.7.1 — token bersama saja memberi `{"role":"operator","scopes":[]}` (D13 lagi), tetapi identitas device AgentOS yang sudah dipasangkan memberi `["operator.admin","operator.read","operator.write"]` dengan `grantedScopesKnown=true`. Konfigurasi cluster memenuhi jalur kedua: URL loopback (`isLocalGatewayUrl` benar), tidak ada `gateway` block di `openclaw.json` AgentOS, dan tidak ada `OPENCLAW_GATEWAY_TOKEN` di env PID 1 — sehingga `activeDeviceAuth = deviceAuth && !token && !password` aktif.

**Celah yang tersisa, sempit dan nyata:** gateway memberi scope **milik device**, bukan yang diminta — permintaan 8 scope tetap dijawab 3. Metode yang menuntut `operator.approvals` atau `operator.questions` akan 403 di preflight. Bersinggungan dengan §6.2 butir 1 CLAUDE.md; perbaikannya pairing ulang, yang butuh keputusan manusia.

**Migrasi satu arah — dan rollback yang tidak cukup.** 0.7.7 memigrasi `instance-protection.json` v1 → v2 (menambah `actorId`) dan melahirkan `agentos-users.json` pada boot pertama. 0.7.6 menolak v2 dengan **500 `Instance protection request failed`** pada setiap login. Jadi rollback AgentOS BUKAN hanya `git reset` + sync: berkas v1 MUST dipulihkan dari backup. Salt, hash, dan `sessionSecret` identik di kedua versi, jadi pemulihan tidak menghilangkan apa pun. Ditemukan dengan cara mahal — rollback yang terpicu salah baca (lihat catatan berikut) mengunci login sampai berkas v1 dikembalikan.

**Catatan metodologis yang layak diingat:** `authStatus.native.ok` di `/api/settings/gateway` **bukan** status link gateway — ia probe `connect` tersendiri yang bisa timeout sementara koneksi native yang sesungguhnya berjalan normal. Membacanya sebagai bukti kegagalan memicu rollback yang tidak perlu. Sinyal yang benar adalah log gateway sendiri: permintaan `id=agentos:…` yang dijawab `res ✓`.

## D71 — Watchdog berbasis aktivitas + abort-sebelum-parkir: invarian "BLOCKED ⇒ run berhenti di gateway"

**Insiden yang melahirkannya, terukur dari DB cluster dan log gateway.** TASK-E2854DB9 (dispatch 20:17, watchdog parkir 20:47 — `no runtime event for 1802s after dispatch`) ternyata masih hidup: 36 pesan masuk SEBELUM parkir dan **103 pesan SETELAHNYA**, sampai gateway mencatat `run TASK-E2854DB9#1 ended with stopReason=stop` di 21:25 — total 64 menit. TASK-2C56D3A8 sama (dispatch 21:18, parkir 21:48, **440 pesan setelahnya**, run terakhir berakhir `killed` oleh context overflow ±00:08 — total 2j48m). Dua lapis kesalahan:

1. **`executions.stalled()` memakai `created_at` sebagai jam.** Usia sejak dispatch tidak mengatakan apa-apa tentang hidup-matinya run; 30 menit bukan batas run agent yang sehat (64 menit dan 2j48m adalah data, bukan anomali). Pesan `"no runtime event"` itu sendiri bohong — transkrip membuktikan event terus datang.
2. **Slot concurrency, slot worker, dan lease workspace dilepas saat parkir tanpa bukti run-nya berhenti.** Inilah bahaya over-commit yang dilaporkan operator: task diparkir BLOCKED saat agennya masih jalan → `resources.activeCount` (executions DISPATCHED/RUNNING) turun → admission mengira ada slot model yang bebas → dispatch berikutnya menabrak batas provider yang sebenarnya sudah penuh — bahkan melampauinya. Begitu pula lease: setelah parkir E2854DB9 di 20:47, task 2C56D3A8 di-dispatch ke workspace `sdmk-kader` yang sama di 21:18 **saat run E2854DB9 masih streaming sampai 21:21** — dua agen hidup satu pohon selama ±4 menit, persis korupsi yang lease cegah (P4-07).

**Keputusan, tiga lapis yang saling menutup:**

1. **Jam watchdog = aktivitas terakhir yang TERAMATI, bukan usia dispatch.** Kolom baru `executions.last_event_at` (migrasi D71; backfill `created_at` hanya baris belum-final — trigger imutabilitas meng-abort UPDATE pada baris final, dan NULL pada baris final tidak pernah dibaca karena `stalled()` memfilter `finalized_at IS NULL`). Di-bump oleh setiap `session.message`/`session.tool`/toolResult yang terekam, lifecycle `start`, dan oleh describe "running" (D72). `stalled()` membaca `COALESCE(last_event_at, created_at)`.
2. **Kebenaran dari gateway sebelum menebak.** Saat hendak parkir, watchdog bertanya `sessions.describe`: `running` → **bukan stall** — diam-diam subscription kita yang mati, bukan run-nya; refresh jam aktivitas dan lewati. `done` → **jangan parkir** — BLOCKED akan melepas workspace untuk task lain padahal reconciler (D72) sedang akan membuktikan COMPLETE.
3. **Abort-sebelum-parkir.** Parkir hanya sah setelah `sessions.abort` mengonfirmasi run berhenti: `abortedRunId` (saya hentikan) atau `status:"no-active-run"` (memang tidak ada). Abort gagal/tak dapat diverifikasi → **parkir ditunda**, baris tetap DISPATCHED, lease tetap di-heartbeat, slot concurrency tetap terhitung — konservatif adalah satu-satunya arah yang aman, dan tick berikutnya mencoba lagi.

**Invarian yang dibeli:** `BLOCKED (watchdog) ⇒ run sudah tidak berjalan di gateway`. Inilah yang membuat pelepasan slot/lease saat parkir jujur. Reconciler (D72) menegakkan invarian yang sama untuk baris warisan: BLOCKED + describe `running` = straggler → di-abort.

**Alternatif yang ditolak:** menaikkan `dispatchTimeoutMs` saja. Itu memperpanjang jendela false-negative tanpa menyentuh akarnya — run 2j48m sudah melewati batas berapapun yang masuk akal, dan over-commit tetap terjadi pada parkir pertama yang salah.

**Test:** 476 → 493. Regresi yang dipaku: run yang streaming 4× dalam 40 menit tidak pernah stall; run yang gateway katakan `running` tidak diparkir walau diam berjam-jam JAM-nya di-refresh; `done` tidak diparkir dan diselamatkan reconciler dalam satu pass; abort tak terverifikasi = parkir ditunda + slot model tetap terhitung + lease tetap terpegang; abort konfirmasi tercatat di alasan parkir; dan **skenario over-commit ujung-ke-ujung**: satu-satunya slot provider tetap terhitung terisi oleh run hidup-tapi-diam, task kedua parkir `WAIT_CONCURRENCY` — bukan dispatch ganda ke provider yang penuh.

## D72 — Reconciler nyata di atas `sessions.describe`: menyelamatkan, bukan menghukum

**Reconciler lama adalah jaring pengaman yang bukan jaring.** Dua cacat struktural, keduanya terukur: (1) `main.mjs` memanggil `reconcileOnce()` **tanpa** `readStatus` — default-nya `async () => null`, semua lookup "unknown", tidak pernah ada yang di-settle; (2) gerbangnya `revisionChanged()` dari snapshot AgentOS — dan `/api/snapshot` tidak pernah membawa run gateway-direct (D15), jadi revisi tidak bergerak untuk persis kasus yang reconciler harus tangani. Sementara jalur cepat (lifecycle `end` via `sessions.subscribe`) kehilangan event di setiap gap reconnect — controller re-subscribe tiap 60 detik — dan itulah bagaimana eksekusi selesai bersih di gateway sambil task-nya menginap BLOCKED (E2854DB9: gateway mencatat `stopReason=stop`; controller tidak pernah melihat satu byte pun).

**Kontrak baru, diverifikasi dengan mengirim permintaan (aturan 4), bukan membaca dist:** `sessions.describe {key}` → `{ session: { status, startedAt, endedAt, abortedLastRun, inputTokens, outputTokens, totalTokens, sessionId } }`, `status` = klasifikasi terminal durable milik gateway (`running | done | timeout | killed | failed`; sumber `session-lifecycle-state.ts`, diamati live di 2026.7.1 protokol 4: E2854DB9 → `done` + token 106343/77561; 2C56D3A8 → `killed` + `abortedLastRun:true`). Ini satu-satunya sumber outcome setelah-fakta: `agent.wait` menjawab `{"status":"timeout","timeoutPhase":"queue"}` untuk run yang sudah selesai bersih (D15), `sessions.preview` salah bentuk param. Scope `operator.read` — terpenuhi oleh device identity controller.

**Aturan main baru, dari apa yang describe bisa dan tidak bisa buktikan:**

- `done` = bukti positif sukses → settle COMPLETE lewat `sink.applyDescribe` — pemetaan describe→verdict punya SATU pemilik di sink (dipakai bersama tail `finalizeRun` applyEnd, supaya dua jalur tidak berbeda pendapat, pelajaran settle D57 diterapkan ke kode). Token describe ditulis hanya bila belum ada catatan per-pesan (agregat sesi tidak boleh menimpa pembacaan hidup — kebohongan D17 dari arah lain). Tepi BLOCKED → COMPLETE (D57) dan DISPATCHED/RUNNING → COMPLETE sama-sama legal.
- `running` = bukti aktivitas → refresh `last_event_at` (obat kedua untuk false-parkir D71: run yang hilang dari pandangan subscription tidak bisa diparkir di menit ke-30). Task **BLOCKED** + `running` = straggler warisan kode lama → **di-abort**, menegakkan invarian D71 untuk baris lama; task tetap BLOCKED, manusia yang memutuskan.
- `killed`/`failed`/`timeout` = bukti, bukan vonis → tidak ada aksi otomatis. **Reconciler menyelamatkan, manusia menghukum.** Task DISPATCHED dengannya akan diparkir watchdog dengan alasan yang jujur (describe non-running + abort konfirmasi); task BLOCKED sudah di tempat keputusan manusia. Alasannya presisi: describe yang proyeksinya sendiri bisa janggal (2C56D3A8: `killed` PADAHAL pesan terakhir asistennya melaporkan pekerjaan selesai — overflow-retry internal gateway membingungkan proyeksi run terakhir); men-finalisasi eksekusi atas bukti ambigu menutup jalan revisi CONTINUE dan memblokir end-event sah yang datang terlambat.

**Pass self-gating, tidak perlu gerbang revisi:** hanya task dengan eksekusi terbaru belum-final DAN bercabang `session_key` yang di-describe — satu RPC per pekerjaan yang mungkin hidup, bukan per task di DB. Scan BLOCKED dibatasi jendela `SEMANGGI_BLOCKED_SCAN_MS` (default 6 jam) dari aktivitas terakhir — untuk straggler kode lama; baris parkir baru sudah membawa invarian D71. Timer `SEMANGGI_RECONCILE_MS` (default 20 dtk) berjalan tanpa syarat; `revisionChanged` dihapus bersama readStatus-injection-nya.

**Test:** dalam 493 total. Dipaku: `done` → COMPLETE + token terekam + session_ref naik grade ke sessionId + lease lepas + tidak menimpa usage yang sudah ada; `running` → jam aktivitas menyegar dan `stalled()` tidak melihatnya; sesi tak terbaca = tak tersentuh; `killed` tidak menghukum otomatis; straggler BLOCKED-hidup di-abort; baris BLOCKED tua jatuh dari jendela; eksekusi final tidak pernah di-describe.

## D73 — Command Center: `/doc`, `:level`, pencarian `@`/`TASK-`, dan panel viewer di luar `<main>`

Lima permintaan operator yang, dikerjakan bersamaan, ternyata satu tema: **Command Center masih menuntut operator mengetik hal yang sistem sudah tahu** — id task yang ada di basis datanya sendiri, path berkas yang ada di workspace-nya sendiri, dan level yang selama ini hanya bisa diubah lewat Role Map.

**1. `/doc` adalah PREPARE untuk dokumen yang sudah ada, bukan WORK.** Alasannya sama persis dengan D47: membaca sebuah dokumen dan menuliskan penilaian atau perbaikannya selesai dalam SATU run. Menjalankannya lewat pipeline penuh membayar fase builder yang tidak punya sesuatu untuk dibangun, dan menahan hasilnya di belakang dependensi yang tidak ada. Yang membedakannya dari PREPARE hanyalah role-nya tidak tetap.

**Role dipilih dari VERBA, bukan dari dropdown.** Tiga pekerjaan berbeda bisa dilakukan terhadap satu dokumen — menilai (reviewer), merancang ulang (architect), menguraikan (analyst) — dan operator sudah menyebutkan yang mana lewat kata kerjanya. Meminta ia memilih lagi adalah pertanyaan yang jawabannya sudah ada di kalimatnya. Aturannya rule-based, bisa diuji, dan urutannya penting: pola reviewer diuji lebih dulu karena *"periksa desainnya"* adalah review, bukan desain. Tebakan yang salah TIDAK senyap — balasan menyebut role dan level yang dipilih, karena tebakan yang tidak pernah diucapkan tidak pernah bisa dikoreksi.

**Jebakan yang ditemukan saat merancangnya, dan sudah dipaku tesnya:** verba `review`/`periksa`/`cek` adalah perintah *task-scoped* di router (Action.REVIEW), yang menuntut task id. Tanpa pengecualian eksplisit, `/doc @docs/plans.md review keamanannya` — bentuk paling alami dari perintah ini — jatuh ke CONFIRM menuntut id yang memang tidak pernah ada: **sebuah command yang gagal pada setiap input**, bentuk kegagalan yang sama dengan D36. Karena itu `forced === "DOC"` melewati seluruh cabang verb-as-command.

**2. `:level low|normal|critical` menimpa `resolveLevel(template, role, profile)` untuk satu permintaan.** Sebuah dokumen yang sedang jadi taruhan pantas dapat Brain terbaik tanpa operator harus mengubah Role Map project — dan mengembalikannya sesudahnya, yang adalah langkah yang pasti terlupa. Token dilucuti dari teks SEBELUM klasifikasi: kalau ia lolos, ia ikut menjadi judul kartu kanban dan dibaca agen sebagai bagian dari instruksi. Kosakatanya persis `Level` di brains.mjs, bukan sinonim bebas — `:level tinggi` tidak cocok dan tinggal sebagai prosa yang terlihat di judul: kegagalan yang kelihatan, bukan yang senyap memilih Brain yang salah.

**3. `@` menunjuk berkas, dan itu bertabrakan dengan Slack.** Router dibagi dengan Slack, tempat `@` selalu orang — `classify` membuang token `@…` pertama sebagai mention. Pembuangan itu kini bersyarat: hanya token tanpa `/` dan tanpa titik. Tanpa syarat ini `@docs/plans.md review` kehilangan berkas yang justru menjadi objek permintaannya. Rujukan diekstrak dari teks MENTAH lebih dulu, sehingga urutan kedua aturan tidak lagi menentukan.

**4. Whitelist berubah dari NAMA ke DIREKTORI, dan itu keputusan keamanan yang perlu disebut.** Endpoint dokumen lama (`/docs/{name}`) aman karena tidak ada segmen path dari request yang pernah menyentuh filesystem — tujuh nama tetap. Itu terlalu sempit untuk pencarian `@`: sebuah project punya `deliverables/` dan catatan yang lahir saat dikerjakan dan tidak bisa didaftarkan lebih dulu. Gantinya tiga akar tetap (`docs/`, `memory/`, `deliverables/`) dengan resolusi yang **menolak, bukan membersihkan diam-diam** — path yang menunjuk keluar adalah permintaan yang salah, dan "diperbaiki" menjadi path lain berarti operator menyunting berkas yang bukan yang ia tulis. Pemeriksaan dilakukan pada hasil `resolve()`, bukan pada string mentah: `docs/../../etc/passwd` secara tekstual memang diawali `docs/`. Perbandingan prefix memakai `${base}${sep}` — tanpa pemisah, `/ws-lain` lolos sebagai prefix dari `/ws`. Menulis hanya untuk `.md`; membaca lebih longgar karena balasan agen menyebut berkas apa pun yang ia sentuh, dan nama berkas yang tidak bisa diklik memaksa operator mencarinya di tempat lain.

Seluruh keputusan itu tinggal di SATU fungsi (`resolveWorkspaceFile`) yang punya tes sendiri — route HTTP tidak bisa diuji tanpa server, dan justru bagian inilah yang wajib punya tes: `../` yang lolos berarti seluruh disk container bisa dibaca dan ditulis lewat sebuah kotak chat.

**5. Panel viewer di luar `<main>` menuntut satu tambalan hulu, dan itu sengaja dibuat bodoh.** Panel membagi halaman menjadi dua kolom; ia bukan sesuatu yang menempel di dalam salah satunya. `OperationsShell` (berkas hulu) memiliki `<main>`, jadi satu-satunya cara memasang sibling di sebelahnya adalah lewat shell itu. Tambalannya dua prop opsional (`aside`, `asideWidth`) dan satu `<div>` bersyarat — tanpa keadaan, tanpa logika layout, tanpa satu pun baris yang tahu apa itu Semanggi. Halaman AgentOS lain tidak mengirim `aside` dan merender persis seperti sebelumnya, yang juga berarti tambalan ini murah diselesaikan saat rebase berikutnya (aturan 3 §4.1: berjangkar teks, gagal keras).

`<main>` menyusut lewat `width: calc(100% - N%)`, bukan `padding-right`: padding menyisakan latar `<main>` di bawah panel, dan pada tema terang perbedaannya terlihat sebagai garis yang tidak pernah rapat.

**Keadaan panel hidup di `control-shell.tsx`, dibagi lewat context.** Yang MEMBUKA berkas adalah `ControlPage`, yang dirender di dalam `<main>` sebagai anak render-prop; yang MENAMPILKAN ada di luarnya. Dua cabang pohon berbeda — tidak ada prop yang bisa menyeberang tanpa melewati induk bersama mereka. Lebar disimpan sebagai PERSEN, bukan piksel: operator yang menyeret panel ke 40% pada layar lebar mengharapkan proporsi yang sama saat jendela mengecil, bukan panel yang tiba-tiba memakan seluruh layar. Seret dipasang di `window`, bukan di batang splitter: sekali pointer bergerak lebih cepat dari render ia keluar dari batang 9px dan setiap event berikutnya hilang.

**Composer ikut membaca lebar itu.** Ia `position: fixed` terhadap JENDELA (dan memang harus, agar tidak hilang saat shell AgentOS bergeser), jadi ia tidak ikut menyusut sendiri — tanpa `right: N%` separuh kotak ketik tertutup panel. Angkanya datang dari context yang sama, bukan dari salinan kedua yang akan menyimpang.

**Satu mesin untuk tiga token, bukan tiga.** `/`, `TASK-`/`#`, dan `@` memakai daftar, tombol, dan tombol panah yang sama. Tiga implementasi terpisah akan menyimpang pada perilaku kecil (Escape, Tab, urutan) dan hanya satu di antaranya yang akan diperbaiki saat ada yang salah. Token ditentukan oleh teks SEBELUM KURSOR, bukan seluruh isi — operator yang kembali ke tengah kalimat untuk menyisipkan sebuah id tidak sedang mengetik di ujung. `/` tetap dibatasi ke awal pesan karena di situlah `INTENT_PREFIX` membacanya; menawarkannya di tengah kalimat berarti menawarkan sesuatu yang tidak akan berlaku. Escape ditandai per-token, bukan sebagai satu bendera: menutup daftar untuk `@doc` tidak boleh membungkam daftar `TASK-` berikutnya. Daftar task dan berkas diambil saat tokennya pertama kali muncul dan dibuang saat project berganti — menawarkan id dari project lain menghasilkan perintah yang ditolak dengan alasan yang tidak akan terbaca sebagai "itu project yang salah".

**Nama berkas yang bisa diklik dibatasi pada tiga akar.** Sebuah balasan penuh potongan kode juga memuat `useState` dan `node:fs` di dalam backtick; menjadikan semuanya tombol berarti kebanyakan tombol tidak membuka apa pun. Tiga akar itu persis yang bisa dibuka panel — jadi setiap yang terlihat bisa diklik memang benar-benar bisa dibuka.

**Test:** 506 (dari 494). Yang dipaku: `/doc` + verba review tidak jatuh ke CONFIRM; role per verba; `@satria` tetap mention sementara `@docs/a.md` adalah berkas; token `:level` dibaca DAN hilang dari judul; setiap bentuk jalan keluar dari workspace ditolak (`../`, path absolut, prefix yang menyerupai akar, akar di luar tiga, NUL); listing tidak menyentuh `src/`; berkas biner mengaku biner alih-alih dikirim sebagai teks rusak; penyimpanan tercatat di event_log; `/doc` dengan rujukan yang ditolak tidak meninggalkan task setengah jadi; `:level low` pada `/task` benar-benar menurunkan kelas kualitas.

## D74 — Deliverable /doc menyebut path yang benar; vonis gateway dalam alasan parkir

**Dua kegagalan kecil dengan bentuk yang sama: sistem mengatakan sesuatu yang tidak sesuai kenyataan.**

1. **Instruksi /doc dan preamble dispatch bertentangan.** Preamble (instruction.mjs) menyuruh semua agen menulis ke `deliverables/<task-id>/` — dan agen mematuhinya (hasil memang betul di `deliverables/<task-id>/review.md`). Tetapi DOC_DELIVERABLE masih menuju path lama `docs/review.md`, jadi balasan chat dan tombol berkasnya membawa operator ke `<workspace-root>/docs/review.md` — berkas yang tidak pernah ditulis. Perbaikan: id task dibangkitkan di `createDocTask` (shortId — generator yang sama dengan default create) supaya instruksi DAN balasan menyebut path penuh `deliverables/<task-id>/<role>.md`; path lama dihapus karena kontradiksinya adalah bug, bukan pilihan.
2. **Alasan parkir menyembunyikan vonis.** TASK-4CA0D674 diparkir dengan `no runtime event for 1810s (no active run at gateway)` padahal proyeksi sesi gateway berkata `failed` (transkrip berakhir dengan pesan gateway sendiri "The agent run failed before producing a reply"). Diamnya hanya MENANGGAL kejadian; vonisnya yang menjelaskan. describe terminal (failed/killed/timeout) kini disertakan: `… (gateway session: failed; no active run at gateway)`.

**Mengapa 4CA0D674 BLOCKED, bukan menunggu** (pertanyaan operator, dijawab di sini supaya tidak ditanya dua kali): `no active run at gateway` berarti `sessions.abort` menjawab `status:"no-active-run"` — gateway SENDIRI mengonfirmasi tidak ada run hidup pada sesi itu. Menunggu berarti menahan lease workspace dan slot concurrency untuk run yang tidak ada dan tidak akan pernah mengirim `end`. WAIT_* adalah untuk penghalang yang berlalu sendiri (jendela kuota, lease, dependensi); run yang sudah mati tidak punya apa pun untuk ditunggu. BLOCKED = resumable via revisi CONTINUE — dan slotnya hanya dilepas SETELAH gateway mengonfirmasi kematiannya (invarian D71).

**UI Command Center yang menyertai** (di semanggi-agentos-ui, bukan keputusan arsitektur controller): bubble operator `bg-primary/15` (tint, bukan fill — bubble penuh `bg-primary` terbaca sebagai tombol); balasan /doc yang membuat task kini membawa seksi live — status + tiga aktivitas transkrip terakhir, refresh 10 detik, berhenti total (spinner dan polling) saat status tidak lagi in-flight.

**Test:** 494 → 508 (deliverable path di balasan+files+instruksi, larangan `docs/review.md`, vonis gateway dalam alasan parkir).

## D75 — Auto-recovery run yang mati abnormal: requeue beranggaran, BLOCKED hanya saat anggaran habis

**Permintaan operator, dan diagnosis yang mendukungnya:** run yang mati di gateway (TASK-4CA0D674: proyeksi sesi `failed`, "The agent run failed before producing a reply") adalah kondisi transien — bug internal, crash, kill dari luar — yang menurutnya layak ditangani controller sendiri, bukan diparkir BLOCKED menunggu manusia menekan "continue". Dua tahun kebiasaan lama: setiap kematian run (watchdog D20, end event dengan stopReason buruk, bahkan kematian yang dikonfirmasi describe) berakhir di BLOCKED; mesin backoff-antrian hanya hidup untuk kegagalan ADMISSION (D51/D52), tidak pernah untuk kegagalan RUNTIME.

**Keputusan:** satu vonis bersama di `domain/retry.mjs` (`applyRuntimeFailure`), dipakai tiga permukaan penemu kematian supaya tidak bisa berselisih pendapat:

- **watchdog** (diam 30 menit + describe/abort mengonfirmasi mati),
- **sink** (end event live dengan stopReason selain stop/end_turn),
- **reconciler** (describe `failed`/`killed`/`timeout` di bawah task yang masih mengaku DISPATCHED/RUNNING — **jalur cepat**: pemulihan terjadi dalam pass 20 detik, bukan menunggu diam 30 menit; TASK-4CA0D674 duduk mati 30 menit karena jalur ini belum ada).

Vonis: eksekusi FAILED (kebenaran tentang PERCOBAAN itu), task → **QUEUED** lewat tepi baru `DISPATCHED/RUNNING → QUEUED` yang mensyaratkan `reason:"auto-retry"` (marker audit; assertTransition menolak tanpa itu) + backoff jadwal yang sama dengan admission (30 dtk → 15 mnt). Re-dispatch berikutnya otomatis memilih anggota rantai failover yang hidup (D68) — "realokasi gateway" yang diminta. Tepi state machine, bukan revisi: revisi adalah keputusan manusia dengan konteks; ini pemundtahan mekanis atas percobaan yang sama.

**Anggaran (anti-loop):** `SEMANGGI_RUNTIME_RETRY_LIMIT` (default 2) requeue per task dalam jendela `SEMANGGI_RUNTIME_RETRY_WINDOW_MS` — dihitung dari `recentFailures`, penghitung windowed yang sama dengan backoff admission. Habis anggaran → BLOCKED dengan alasan menyebut rentetan kematian; di situlah manusia memang dibutuhkan. **Jendela default 6 jam, bukan 1** — tes anggaran menemukannya: satu siklus kematian = 30 menit diam + backoff, tiga kematian sudah >90 menit; jendela 1 jam melupakan kegagalan pertama sebelum ketiga terjadi dan anggaran tak pernah terpicu (cacat desain yang lolos review, ditangkap tes).

**Yang TETAP di luar auto-retry, sadar:** abort operator (CANCELLED — vonis, bukan kegagalan), penolakan definitif provider 401/402/413-struktural (deterministik; D51/D52), dan task yang sudah BLOCKED (baris terkutuk milik manusia, D72; BLOCKED → QUEUED tanpa revisi tetap ilegal). `killed` DI-retry dengan anggaran yang sama — permintaan eksplisit operator ("service dipaksa mati dari luar"); risiko restart-vs-inten-operator dimitigasi oleh fakta bahwa jalur stop controller sendiri memparkir task saat itu juga (watchdog tidak pernah melihatnya).

**Tes:** 508 → 515 (requeue + backoff + lease lepas; anggaran habis → BLOCKED; abort tetap CANCELLED; end buruk → requeue; jalur cepat reconciler; jendela 6 jam).

## D76 — Lampiran operator: tmp/uploads/, dihapus setelah dimuat, dijamin jam

**Alur:** tombol paperclip di composer → unggah multi-berkas (berurutan, laporan per berkas) → `POST /work/projects/{id}/uploads?name=` dengan **bytes mentah** (octet-stream) → disimpan ke `<workspace>/tmp/uploads/<basename-tersuci>` (batas 8 MB, nama dilucuti path) → rujukan `@tmp/uploads/<nama>` disisipkan ke composer → agen membacanya di sandbox-nya.

**Penghapusan "segera setelah dibaca" dua lapis:** (1) preamble dispatch (buildPreamble) menginstruksikan agen menghapus berkas yang dirujuk instruksinya segera setelah selesai dibaca/dimuat — satu-satunya tempat agen bisa tahu bahwa berkas ini beda kontrak dengan docs/; (2) penyapu TTL di main.mjs (tiap jam, `SEMANGGI_UPLOAD_TTL_MS` default 24 jam) menghapus sisa apa pun — instruksi bukan jaminan, jam yang deterministik.

**Batas yang disengaja:** tmp/uploads adalah akar BACA tambahan (viewer + rujukan /doc bisa membukanya) tetapi TIDAK masuk listing "@" — listing itu untuk dokumen proyek yang permanen; lampiran hidupnya menit. Dispatcher controller menyimpan body unggahan sebagai `__raw` Buffer sebelum utf8-decode bisa merusaknya; proxy AgentOS meneruskan arrayBuffer + content-type octet-stream apa adanya ( jalur JSON tidak berubah). Nama sama menimpa — lampiran bersifat sekali-pakai, versioning bukan kontraknya. Rujukan upload di /doc kini lolos resolusi (akar baca), mengalir ke instruksi seperti berkas lain.

**Tes:** dalam 515 (bytes biner utuh end-to-end melalui HTTP; sanitasi nama traversal→basename; tolak kosong/oversize; baca oke + tidak muncul di listing; janitor hanya yang lewat TTL; preamble memerintahkan penghapusan hanya bila ada rujukan).

## D77 — Lampiran per-task (adopsi), teks saja, chip di composer dengan "×"

**Permintaan operator, tiga bagian:** (1) `tmp/uploads` harus tinggal di `deliverables/<task-id>/tmp/uploads`, hapus-setelah-muat tetap berlaku; (2) lampiran terlihat di composer sebagai chip — klik membukanya di panel viewer, "×" menghapusnya; (3) hanya ekstensi teks (md, txt, json, csv, yml, …). Permintaan (1) menampakkan bug nyata pada D76: dekomposisi WORK menghasilkan N task yang berbagi SATU jalur staging global — task pertama yang taat "hapus setelah dimuat" mematikan fase 2..N yang merujuk berkas yang sama.

**Staging → adopsi.** Saat menempel, id task memang belum ada — jadi unggahan tetap staging di `tmp/uploads/` (D76 tak berubah). Begitu pesan menciptakan task, setiap task **mengadopsi** rujukan yang tersebut di teksnya (`adoptUploadsForTask`): berkas disalin ke `deliverables/<task-id>/tmp/uploads/<nama>`, rujukan di deskripsi ditulis ulang lewat peta lama→baru. Setiap task kini punya salinan dan masa-hidupnya sendiri — hapus-setelah-muat menjadi aman per task, bug berbagi-WORK tertutup. Adopsi dipasang di SEMUA permukaan pencipta task: cabang CREATE `/task`, registerTasksFromDoc (`/doc`), loop dekomposisi WORK, dan prepare.mjs. Sumber staging hilang → rujukan dibiarkan apa adanya (staging), task tetap lahir, `missing` tercatat di log — menolak task karena lampirannya menguap lebih buruk daripada task dengan rujukan yang akan disapu TTL. **Sumber divalidasi seperti destinasi (temuan review):** ref datang dari teks operator — termasuk `/prepare` Slack yang identitasnya non-admin — dan pola ekstraksi mengizinkan `..`; cek kontainment leksikal + `realpath` (symlink di staging bisa menunjuk keluar, dan copyFile berjalan di host, di luar sandbox agen) menjadikan ref traversal/symlink diperlakukan seperti sumber hilang — `GET /file` dan DELETE sudah lama menolak jalan keluar, jalur salin ini yang tertinggal.

**Teks saja, dua lapis:** whitelist `UPLOAD_TEXT_EXTS` di server DITAMBAH endusan NUL pada 8 KB pertama — ekstensi bisa berbohong, isi tidak. UI menolak lebih awal dengan daftar yang mengacu kosakata server (bukan menyalin bebas — selisih hanya menurunkan UX, kebenaran tetap di server). Nama berkas → basename TANPA spasi (spasi→"-"): rujukan lampiran adalah token `@…` dan setiap pola token berhenti di spasi — nama berspasi melahirkan rujukan yang tak bisa dibaca kembali.

**`extractUploadRefs` pindah rumah dan melebar:** kini di `domain/workspace-files.mjs` (instruction.mjs me-re-export), polanya mencocokkan prefiks opsional `deliverables/<task-id>/` — pola lama memotong jalur per-task menjadi `tmp/uploads/…`, membuat preamble memerintahkan penghapusan jalur yang tidak ada. `DELETE /work/projects/{id}/uploads?path=` hanya berlaku untuk staging — salinan per-task milik task yang mengadoptinya (kontrak penghapusannya: preamble task + TTL). Penyapu TTL (D76) kini menyapu staging DAN `deliverables/*/tmp/uploads` (pola satu tingkat persis, berkas saja). Jalur Slack tidak diubah — tidak ada alur unggahan di sana.

**Chip (UI):** klik → `viewer.open(path)`; "×" → DELETE staging + buang token rujukan dari teks (chip yang disembunyikan tanpa menghapus berkasnya meninggalkan berkas yatim hidup sampai TTL); chip bersih saat kirim/ganti proyek. Teks operator bahasa Inggris.

**Tes:** 515 → 520 (endpoint hanya teks: PNG ditolak, .txt bohong ber-NUL ditolak, utf-8 utuh; DELETE staging oke/berulang 400/luar staging 400; adopsi /task + /doc + WORK per fase; sumber staging hilang dibiarkan; penyapu per-task; extractUploadRefs + preamble jalur per-task).

## D78 — Process Manager Brain: sandbox = agen gateway, kill dengan aturan di server, aksi baris diringkas jadi "3 dots"

**Permintaan operator, dua bagian:** (1) halaman Brain butuh Process Manager — daftar sandbox (nama, project-id, task-id, status), kill, dan create sandbox kosong; (2) aksi baris tabel dirapikan: Edit jadi ikon pensil, sisanya (Disable, Test, Process Manager) masuk menu "3 dots" dengan ikon kiri.

**"Sandbox" = agen gateway + workspace-nya, bukan direktori.** Kebenaran operabilitas di gateway adalah `agents.list` (D32), dan Test auto-provision probe agent (D65) yang lalu MUNCUL di daftar itu — daftar yang berbasis direktori workspace akan melewatkan probe yang baru lahir justru di momen operator menatapnya. Baris: `{agentId, name, workspace, status RUNNING|IDLE, projectId, taskId, probe}` — status dari task aktif yang terparkir di worker agen itu, atribusi fallback `tasks.latestByWorker()`; `probe` = nama cocok `/^sem-workspaces-probe-/`.

**Kill = `agents.delete`, divalidasi live.** Kontrak upstream harus diverifikasi dengan mengirim permintaan (aturan 4): `scripts/reap-agents.mjs` membuktikan gateway 2026.7.1 menjawab `{removedBindings}` — dan `operator.admin` yang diminta op ini sudah dipegang identitas device (preflight 0.7.7 hanya menolak scope yang memang bukan miliknya, D70). **Aturan kill tinggal di server (pola D67), UI hanya menyembunyikan tombolnya:** task DISPATCHED/RUNNING yang terparkir di worker agen → 409 menyebut task-nya (sandbox yang sedang bekerja dihentikan lewat task-nya, bukan lewat sini — persis mengapa tombol kill untuk baris RUNNING tidak dirender, tombol disabled tetap berbisik "suatu saat"); agen tidak hidup / bukan milik Brain ini → 404; mutasi admin-only; event `brain.sandbox-created` / `brain.sandbox-killed`.

**Create: nama berprefiks, workspace absolut, model terkunci.** Nama di-slug dan HARUS cocok `/^(semanggi|sem)-/` ≤63 char — prefiks inilah pembeda origin yang terukur (D32); tanpa itu sandbox buatan operator lolos dari higiene armada (temuan review: default `reap-agents.mjs` dulu hanya mencocokkan `sem-`, sehingga `semanggi-` yang rute ini izinkan justru lolos dari pembersungan — default-nya kini `^(sem|semanggi)-`, override `--prefix` tetap bekerja). Workspace absolut tanpa `..` (pelajaran D65), default `${probeWorkspaceFor(live, provider)}-<name>`; model DITARIK dari Brain, bukan input — sandbox yang modelnya diketik ulang tidak akan match daftar Brain-nya sendiri. Brain claude-code ditolak (agen ACP harness dipin oleh routing).

**Test Connection DARI Process Manager adalah fitur, bukan pengulangan:** provisioning probe adalah efek samping test (D65), jadi daftar di-reload tepat setelah test menjawab — sandbox baru terlihat di tempat operator mencari penyebabnya. Create adalah modal kecil yang DITUMPUK di atas Process Manager; perbaikan menyertainya di ui.tsx: stack modal tingkat-modul (`modalStack`) — Escape mengupas satu lapis (dulu: satu Escape menutup SEMUA), klik overlay tetap aman karena portal berikutnya melukis di atas.

**Tes:** 521 → 524 (daftar sandbox IDLE/RUNNING + atribusi; kill 404/409-menyebut-task/200 dan deleteAgent terpanggil — transisi status HARUS lewat QUEUED→DISPATCHED→RUNNING karena 409 membidik task hidup, bukan bekas; create: tolak prefiks/workspace relatif/claude-code, nama di-slug, model terkunci).

## D79 — Kartu status armada di halaman Brain + Process Manager armada + baris yang bisa diklik

**Permintaan operator, tiga bagian:** (1) kartu status di atas daftar Brain — Total/Running/Idle; (2) angka Running dan Idle bisa diklik → popup Process Manager berisi SEMUA sandbox yang Running/Idle lintas brain; (3) di Process Manager, Nama dan Task ID menjadi klikabel — Nama → detail Agent, Task ID → Task Detail.

**Satu endpoint armada, dedupe per agent.** `GET /api/work/sandboxes` (bearer, non-admin — konsisten dengan `GET /api/work/agents`) mengembalikan `{counts:{total,running,idle}, sandboxes}`; `?status=RUNNING|IDLE` memotong DAFTAR saja, counts selalu bicara tentang armada penuh (kartu dan daftar dipotong kebutuhannya dari satu bentuk jawaban). **Dedupe per agentId first-wins urutan brains.list():** satu agent bisa memuaskan DUA brain (provider+model sama) dan kartu yang menghitung dua kali berbohong; daftar PER-BRAIN (D78) tetap tidak didedupe — keanggotaan per brain adalah kebenaran tersendiri di PM brain itu. Row-builder diekstrak (`sandboxRowFor` + `sandboxAttribution`) supaya kedua rute tidak bisa berdrift bentuk barisnya — UI merender keduanya dengan satu komponen.

**PM dual-mode, satu renderer.** Mode brain (D78, tanpa perubahan perilaku: footer Test/Create, kill lewat brain.id) dan mode fleet (kolom Brain tambahan, kill lewat `row.brainId`, TANPA footer Test/Create — test koneksi adalah fakta satu brain, create juga). Baris dinormalisasi ke `FleetSandbox` (baris brain di-stamp brainId/brainName) supaya kill dan renderer satu bentuk.

**Nama → AgentDetailModal, Task ID → TaskDialog.** Detail agent TANPA fetch: baris sudah membawa semua faktnya (agentId+copy, status, brain, workspace, probe/created, project, task) — popup yang mengambil ulang apa yang baru saja dipegangnya hanya menambah spinner antara klik dan jawaban. Task ID membuka `TaskDialog` yang sudah ada (summary/control) — lengkap dengan timeline, transkrip, dan kontrol Stop/Resume; `onChanged` me-reload daftar PM karena Stop dari dialog itu mengubah status baris RUNNING→IDLE.

**TaskDialog masuk stack modal (useModalLayer).** TaskDialog merender overlay-nya sendiri (bukan Modal ui.tsx) — begitu bisa dibuka DI ATAS PM, dua hal rusak sekaligus: overlay inline tertahan stacking context shell (PM yang di-portal z-[70] melukis DI ATASNYA), dan listener Escape-nya menjawab bersama lapisan di bawahnya. Perbaikan: hook `useModalLayer` diekstrak dari Modal (dipakai keduanya; callback menentukan arti "menjawab Escape" — TaskDialog menutup side panel dulu), overlay di-portal ke document.body dengan z-[70].

**Tes:** 524 → 525 (overview: counts {total,running,idle}; dedupe lintas brain — doc-worker milik brain PERTAMA dalam urutan list(), yang di harness adalah brain seed glm-5-2-high, bukan brain buatan tes; filter IDLE memotong daftar tapi counts tetap penuh; status tak dikenal → 400).

## D80 — Provisioning sandbox otomatis: lantai `min_sandboxes` per Brain + on-demand dari parkir admission

**Permintaan operator, eksplisit membalik keputusan lama:** "setiap brain bisa punya config minimal sandbox yang harus hidup (boleh 0)" dan "di titik manapun controller mengecek resource — pass scheduler/admission, task run request — kalau resource-nya tidak ada, SEGERA buat, selama jumlah live-agent untuk model itu masih di bawah `concurrency_limit` resource-nya". Ini membalik "PROVISIONING STAYS A SCRIPT" (agent-registry, era D32–D78). Kekhawatiran aslinya tetap benar — control plane yang membentuk armadanya sendiri lebih sulit diaudit setelah insiden — maka pembalikannya memakai PAGAR, bukan kepercayaan: nama selalu `sem-auto-*` (asal-usul terbaca di inventaris, cocok hygiene `^(sem|semanggi)-`), claude-code TIDAK PERNAH di-provision otomatis (agen ACP dipaku routing, D78 menolak hal sama di jalur operator), batas atas = `resources.concurrency_limit` untuk (provider, model) — batas yang sama yang admission pakai untuk konkurensi run — dan TANPA baris resource TIDAK ada provisioning (operator belum menyatakan model ini boleh punya armada; task parkir WAIT_RESOURCE seperti biasa). Semua aturan hidup di SATU modul `src/domain/sandbox-provision.mjs`, dipakai bersama oleh admission dan keeper supaya pagarnya tidak bisa berbeda pendapat antar pemanggil.

**Kolom `brains.min_sandboxes` (INTEGER NOT NULL DEFAULT 0, CHECK 0..99).** Baris lama mendapat 0 lewat DEFAULT dan itu BUKAN backfill: armada yang tidak pernah meminta provisioning otomatis tidak boleh mulai menumbuhkan agen hanya karena kolomnya muncul. Plafon 99 bukan batas gateway, melainkan penolakan angka ketik-salah. API: field `minSandboxes` di POST/PATCH `/api/work/brains` (validasi domain, 400 di luar rentang); UI: field "Minimum sandboxes" di BrainFormModal (konvensi "" = 0 saat create / biarkan tersimpan saat edit).

**Dua jalur, dua bentuk nama.** (1) **Keeper** (`main.mjs`, timer `SEMANGGI_SANDBOX_KEEPER_MS` default 60 dtk, kill-switch `SEMANGGI_SANDBOX_KEEPER=0`): untuk setiap brain aktif dengan lantai > 0, isi sampai lantai dengan slot deterministik `sem-auto-<brain>-<n>` — deterministik supaya pass berikutnya konvergen (kegagalan setengah jalan tidak menumpuk), dan `agents.create` memang idempoten per nama deterministik. Agen operator/probe yang sudah hidup untuk model itu DIHITUNG ke arah lantai — lantai adalah jumlah agen model, bukan jumlah agen buatan keeper. Timer polos, bukan event-driven: lantai adalah keadaan yang diinginkan, dan keadaan yang diinginkan dicek ulang berkala (sama seperti reconciler D72). (2) **On-demand** (admission, catch `AgentUnavailableError`): buat SATU agen (nama unik `sem-auto-<brain>-sbx-<id>` — dua task yang parkir bersamaan adalah dua kebutuhan) lalu TETAP parkir WAIT_RESOURCE dengan `nextRetryAt` 3 dtk — provisioning tidak pernah men-rewrite hasil admission dan tidak mensubstitusi model lain (bagian D14 yang tak berubah); backoff 30 dtk biasa hanya akan menunda dispatch pertama yang akan berhasil. Kegagalan provisioning KEDUA jalur kembali sebagai `{created:false, why}`, tidak pernah throw — provisioning adalah upaya tambahan di atas parkir yang sudah benar. On-demand memilih brain PERTAMA dalam urutan `brains.list()` yang cocok (provider, model) — first-wins, konvensi yang sama dengan dedupe overview D79, karena armada adalah milik model.

**Event `brain.sandbox-auto-created`** (subjectType brain, payload agentId/name/workspace/model/reason, actor `system`|`keeper`) — jejak audit setara `brain.sandbox-created` D78; `probeWorkspaceFor` (D65) pindah ke `sandbox-provision.mjs` supaya jalur operator D78 dan jalur otomatis D80 mengambil keputusan workspace dari satu salinan.

**Tes:** 525 → 538 (keeper: lantai 2 → dua slot deterministik; agen operator dihitung; slot terisi tidak dibuat ulang; cap memotong lantai dengan `cap-full`; tanpa baris resource → `no-resource-entry`; claude-code dan brain nonaktif dilompati; on-demand: buat SATU agen bukan seluruh lantai, why untuk no-brain/cap-full/no-resource/claude-code, kegagalan create tidak throw; end-to-end admission: parkir menumbuhkan sandbox → clock melewati retry 3 dtk → dispatch; runtime tanpa `createProbeAgent` = perilaku pra-D80; API minSandboxes: default 0, create/patch, 400 untuk 999 dan -1).

## D81 — Lantai dua arah: ubah `min_sandboxes` menyesuaikan armada LANGSUNG, termasuk memangkas idle yang berlebih

**Permintaan operator:** "saat ubah minSandboxes jumlah sandbox berjalan langsung disesuaikan sesuai jumlah minimal yang disebutkan dengan memangkas idle yang berlebih". Lantai D80 hanya tumbuh; sekarang ia juga menyusut — dan penyusutannya tidak menunggu pass keeper 60 detik.

**Rekonsiliasi per MODEL, bukan per brain.** Dua brain berbagi pool agen untuk (provider, model) yang sama (fakta dedupe D79), jadi "lantai efektif" sebuah model = MAX `min_sandboxes` brain AKTIF yang memakai model itu — memangkas demi lantai brain B yang lebih rendah akan membocorkan lantai brain A. `reconcileModel(provider, model)` menggantikan loop per-brain `enforceMinimums`: di bawah lantai → tumbuh (slot deterministik brain governor, tetap dibatasi `concurrency_limit`, tetap menolak tanpa baris resource); di atas lantai → pangkas.

**Aturan pemangkasan adalah cermin pagar D80.** (1) HANYA agen `sem-auto-*` — agen operator dan probe (`sem-workspaces-probe-*`, pelayan test connection D65) tidak pernah disentuh; bila setelah pemangkasan total masih di atas lantai karena sisa armada milik manusia, itu dibiarkan (armada non-otomatis tetap keputusan operator). (2) HANYA yang IDLE — atribusi "sibuk" = task DISPATCHED/RUNNING parkir di worker agen, ATURAN YANG SAMA dengan kill operator D78 (`busyAgentsByRef` pindah ke sandbox-provision.mjs supaya tak ada dua salinan aturan sibuk); agen sibuk dicatat `skippedBusy` dan dipangkas pass berikutnya begitu idle — konvergensi, bukan kegagalan. (3) Yang ephemeral mati duluan: `sbx-` (lahir on-demand) sebelum slot keeper, slot nomor besar sebelum kecil — inti stabil slot 1..N bertahan sehingga pass berikutnya tidak menumbuhkan apa pun. (4) Model tanpa brain aktif (disable/hapus) berlantai 0: sisa `sem-auto-*` idle-nya menyusut; pass keeper (`reconcileAll`) mengambil lingkup dari brains ∪ agen `sem-auto-*` yang masih hidup, jadi armada yatang tetap tergaruk.

**"Langsung" = di dalam perminta yang mengubah lantai.** POST/PATCH/DELETE `/api/work/brains` memanggil `reconcileModel` SETELAH mutasi sukses dan SEBELUM menjawab — saat operator melihat jawaban, armada sudah sesuai (UI ikut me-refresh kartu armada setelah simpan). Best-effort: gateway yang sedang tidak bisa dihubungi tidak menolak perubahan konfigurasi (log `sandbox-floor.reconcile-failed`, keeper menutup sisanya). Keeper tetap hidup sebagai penutup celah (agen sibuk saat trim, kegagalan setengah jalan, disable lewat jalur lain).

**Event `brain.sandbox-auto-killed`** (actor penyebab: nama operator untuk perubahan API, `keeper` untuk pass berkala; model tanpa brain aktif menyebut `provider/model` sebagai subjek — armada memang milik model). Log `sandbox-keeper.reconciled` menyebut created+killed.

**Tes:** 538 → 545 (trim: sbx-duluan-lalu-slot-besar, sibuk dilewati + dicatat, semua-sibuk = `busy-above-floor`, operator+probe selamat, lantai efektif = max lintas brain, disable → 0 → menyusut, model tanpa brain tetap dipangkas; grow tetap: slot deterministik, agen operator dihitung, cap, tanpa resource, claude-code; API end-to-end: PATCH 0→2 tumbuh sebelum jawaban, 2→1 pangkas slot besar, 1→0 habis).

**Addendum (terukur di cluster, gateway `kubuslab/semanggi-openclaw:latest` 2026.8, 2026-09-08): dua kunci keadaan gateway menahan nama/path deterministik, keduanya dipulihkan di dalam `createOne` dengan SATU percobaan ulang.** (a) *Legacy workspace setup state* — `agents.delete` melepas binding tapi meninggalkan direktorum workspace di NFS, dan gateway 2026.8 menolak `agents.create` ke direktorum warisan itu (`UNAVAILABLE … run openclaw doctor --fix`); pemulihan: pindah workspace satu tingkat (`<ws>-r<short>`), nama slot tetap. (b) *Deletion cleanup is still pending* — nama yang baru di-delete terkunci sampai pembersihan asinkron gateway selesai, dan jendelanya menit-jam (terukur >10 menit, termasuk untuk workspace segal buatan 2026.8 sendiri); pemulihan: variasi nama `-r<short>` — sah karena konvergensi D81 dihitung dari JUMLAH agen hidup, bukan nama, dan pemangkasan membaca prefiks `sem-auto-` + nomor slot (akhiran variasi diabaikan oleh regex rank). Nama deterministik kembali terpakai begitu gateway melepaskannya (terverifikasi: siklus 12:17 memakai nama polos lagi). Tanpa dua pemulihan ini, satu pangkas-tumbuh dalam jendela itu akan menggagalkan lantai selamanya — penyebab `create-failed` pertama yang tampak seperti kegagalan model padahal kegagalan kebersihan nama. `agents.list` gateway sendiri tertinggal beberapa detik di belakang mutasi; pembacaan seketika (kartu armada) bisa menyebut agen yang baru mati/hidup — keeper 60 dtk adalah penutup kebenaran akhirnya. Memulihkan direktorum warisan tetap pekerjaan `openclaw doctor --fix` di gateway (runbook upgrade 2026.8 milik operator).

**Tes:** 545 → 547 (workspace legacy → relokasi satu kali, nama tetap; nama terkunci deletion-cleanup → variasi `-r`, lantai tetap tercapai, variasi dipangkas sebagaimana slot biasa).

## D82 — End-frame non-bersaham menunggu jeda grace: koreksi stop dari 2026.8.2 tidak boleh kalah oleh length prematur

**Terukur live setelah upgrade OpenClaw 2026.8.2 (2026-09-08).** Gateway baru bisa mengirim lifecycle `end {stopReason:"length"}` PREMATUR — dipicu settled-turn yang gagal finalization — lalu mengganti turn itu dengan *terminal fallback reply* dan mengirim end yang sesungguhnya (`stop`) ~400ms kemudian. Bukti urutan: TASK-4CA0D674#3, controller memfinalisasi FAILED pukul 11:50:04.816Z mengikuti frame pertama; `stop` yang jujur tiba 11:50:05.197Z dan lenyap ke dalam guard "already final" yang dulu BISU. Satu turn rapuh terbayar sebagai kegagalan runtime D75 (retry #4 lahir dari sesi yang sedang kacau → `gateway session: failed` → anggaran habis → BLOCKED dengan alasan yang menyesatkan).

**Perbaikan: last-writer-wins di dalam jendela grace.** Frame end dengan vonis non-bersaham (apa pun selain COMPLETE/CANCELLED — `length`, `error`, `max_tokens`, …) menunggu `config.endGraceMs` (env `SEMANGGI_END_GRACE_MS`, default 1500ms; 0 = perilaku lama) sebelum boleh memfinalisasi. End frame TERBARU untuk runId yang sama selalu menang: koreksi `stop` yang datang di dalam jendela membatalkan timer dan memfinalisasi seketika; tanpa koreksi, kegagalan runtime D75 tetap berjalan setelah grace (length terminal itu nyata — TASK-90D214DF#1 berhenti tepat di 8192 token output, default `model.maxTokens ?? 8192` di metadata model gateway). End bersih (`stop`/`end_turn`) dan abort operator tetap immediat — tidak ada yang mengoreksi mereka. Dua kegagalan pengamatan ikut diperbaiki: end yang tiba setelah final kini DICATAT (`run.ended-ignored` dengan stopReason + keterlambatannya; dulu bisu itulah yang menyembunyikan race ini sepanjang sesi debug), dan supersede dicatat `run.end-superseded`.

**Length yang terminal adalah metadata model, bukan keputusan dispatch.** 8192 untuk claude-code datang dari fallback `maxTokens ?? 8192` di metadata model gateway (sumber `models-add`/provider) — menaikkannya adalah konfigurasi operator di gateway, bukan parameter `agent` RPC (field maxTokens tidak terverifikasi diterima dispatch; mengiratanya melanggar aturan verifikasi kontrak D34). Di sisi controller, D75 sudah menangani length terminal dengan requeue; catatan kualitas: retry FRESH bisa "complete" dangkal (TASK-90D214DF#2: 385 in/581 out, agen tidak membaca dokumen rujukan) — kejujuran state machine terhadap perilaku agen, bukan kedalaman pekerjaannya; operator menilai hasil.

**Tes:** 547 → 550 (end(length) superseded end(stop) di dalam grace → COMPLETE, timer basi tidak menembak belakangan; end(length) tanpa koreksi → FAILED + requeue D75 lewat jalur grace; end setelah final tercatat `run.ended-ignored`, vonis tak berubah).

## D83 — Jalur baca 2026.8.2 diperbaiki: scope+owner `models.list`, harness ACP = config + orchestrator, dan dialog mengaku saat jawaban akhir tak pernah sampai

**Tiga gejala operator pasca-upgrade, satu akar: kontrak baca gateway berubah.** (1) Refresh Model Map membalas 0 model. (2) Test Connection brain `claude-opus-high` menolak dengan "No live agent named \"claude-opus\"". (3) TASK-4CA0D674 COMPLETE tapi tak ada Response di dialog. Probe live (berkas probe sementara di dalam container controller, token dari env) memisahkan tiga penyebab berbeda:

**(a) `models.list` kini dua syarat.** Scope: `view:"configured"` adalah set onboarded; panggilan tanpa params yang dulu dijawab gateway lama kini membalas 0 (terukur). Owner: gateway multi-agen menolak permintaan tanpa pemilik — `INVALID_REQUEST "Multiple agents are configured … Set agentId"` — dan log peringatan baru (`gateway.models-list-failed`) yang D83 tambahkan memunculkan kalimat itu dalam satu menis. Adapter meminta `{view:"configured"}`; saat ditolak karena owner, ia membaca entri pertama `agents.entries` via `config.get` (id `main` — arbitrer tapi deterministik; semua agen melihat katalog yang sama) dan mencoba ulang dengan `agentId`; kegagalan non-owner jatuh ke panggilan legacy `{}` (gateway lama yang menolak param `view`), dan kegagalan tetap dicatat, tidak ditelan. Terverifikasi live: refresh → 17 model termasuk glm-5.2.

**(b) Harness ACP bukan agen gateway.** Terukur: `agent.run {agentId:"claude-opus"}` ditolak `unknown agent id`; `agents.entries` di config hanya memantulkan 9 orchestrator hidup; registry harness yang sebenarnya adalah `config.acp.allowedAgents` (`["claude","claude-opus","claude-sonnet"]`, default `claude`, backend `acpx`) digabung peta agen plugin `plugins.entries.acpx.config.agents` (command per harness, mis. `/usr/local/bin/semanggi-acp-claude-opus`). Dispatch claude-code tetap berjalan LEWAT orchestrator (90D214DF: `sdmk-kader-architect`, nama harness menumpang preamble instruksi). Maka Test Connection claude-code kini dua bagian yang jujur: `listAcpAgents()` (RPC `config.get`, union allowedAgents+acpx, `null` bila tak bisa bertanya — membedakan "tak ada harness" dari "tak bisa bertanya") memverifikasi nama yang dipin; bila terdaftar, probe dispatch dijalankan ke orchestrator hidup non-probe pertama (urut nama — `main` di cluster), dan hasilnya MENGAKUM lingkupnya (field `message`: harness tak dispatchable langsung di 2026.8.2; harness baru teruji pada task nyata pertama). Bila nama tak terdaftar: pesan berisi daftar allowed saat ini + arahan fix. Jalur lama (agen hidup ber-id = acpAgent, era 7.1) tetap didahului. Terverifikasi live: BRN-89F3B3A2 → ok:true, probe ke `main`, 10.6 dtk.

**(c) Dialog eksekusi mengaku "tidak ada jawaban akhir".** Transkrip #5 4CA0D674 berujung toolResult semua — turn jawaban akhir kena cap `length` dan fallback reply gateway memang tidak di-stream ke subscriber (D82), jadi section Response tak punya apa pun untuk dirender. `ExecutionDetail` kini mendeteksi COMPLETE tanpa teks asisten (block text non-kosong pasca-stripFinal, atau fallback text) dan menampilkan kartu peringatan amber di ujung percakapan: kemungkinan cap output model, periksa output tool terakhir atau revisi meminta kesimpulan saja — bukan mengarang Response palsu. Perbaikan akarnya (menaikkan `maxTokens` metadata model gateway untuk glm-5.2/claude-code lewat `models-add`) tetap milik operator.

**Tes:** 550 → 558 (listModels: view configured, set kosong jujur tanpa panggilan ulang, retry owner dari entri config pertama; listAcpAgents: union allowedAgents+acpx, null tanpa config.get; brain test: config-verifies + probe orchestrator non-probe dengan pesan lingkup, daftar allowed saat nama tak dikenal; jalur lama tetap).

## D84 — Sinyal kuota tanpa jam tidak pernah mengunci model lagi: jangkar fallback + pemulihan yang DIUKUR

**Gejala operator (2026-09-08):** "Run again" menjawab `policy-approved models are quota-exhausted` padahal glm-5.2 sudah bisa dipakai. Baris `resources`-nya: `QUOTA_EXHAUSTED, next_available_at NULL, window_kind NULL` — sinyal 13:11Z berbunyi `⚠️ Usage limit reached for 5 hour. Your limit will reset at 2026-09-08 22:17:50`. Akar gandanya: OpenClaw 2026.8.2 mengirim penolakan kuota sebagai TEKS tanpa `resetsAt`/`rateLimitType` terstruktur (jalur 7.1 memilikinya, POC-3 E8), sehingga `applyQuotaSignal` menulis `next_available_at = NULL` — dan `releaseExpiredQuota` hanya membalik baris yang stempel waktunya LEWAT, baris NULL di-skip selamanya. PATCH Model Map memang tidak pernah menyentuh sinyal live (D66, disengaja), jadi operator pun tidak punya jalur manual untuk melepasnya.

**Tiga lapis perbaikan, bukan satu:** (1) **Jangkar fallback** — `applyQuotaSignal` tanpa jam men harga jendela provider via `quotaAnchorFallbackMs`: keluarga per-menit (google/groq/cerebras) memakai jendela PENDEKNYA (jamnya sendiri, D52: tembok menitan ditunggu, bukan diprobe berhorizon harian); keluarga langganan (zai/claude-code) memakai jendela PANJANG — keputusan yang sama dengan ETA clockless D63, karena pesan tidak menyebut jendela MANA yang habis; provider tak dikenal → 30 menit. `resetsAt`/`retryAfterSeconds` terstruktur tetap menang. (2) **Penyembuhan baris lama** — `releaseExpiredQuota` membalik baris NULL ke AVAILABLE (`quota.no-clock-reset`): kenyataan diuji ulang oleh dispatch berikutnya, dan model yang betul-betul masih habis menolak lagi dengan sinyal yang KINI selalu berjangkar. Satu siklus flap lebih jujur daripada terkunci selamanya. (3) **Probe pemulihan** (`domain/quota-recovery.mjs`, timer `SEMANGGI_QUOTA_PROBE_MS` default 10 mnt, matikan `SEMANGGI_QUOTA_PROBE=0`) — jangkar apa pun adalah TEBAKAN tentang kapan provider pulih; satu run minimal sekali-pakai per model ter-exhaust per pass MENGUKURNYA: agen hidup yang melayani model persis itu (agen probe diutamakan — sekali pakai memang untuk ditusuk), sukses → AVAILABLE (`source: recovery-probe`) + `scheduler.notify(QUOTA_RESET)` supaya task yang parkir langsung dievaluasi ulang. Pagar: claude-code TIDAK PERNAH diprobe (harness tidak model-matched, disiplin yang sama dengan D78/D80); model dengan run hidup tidak diprobe (runnyalah probenya yang jujur); jangkar yang akan lewat ≤ horizon 10 mnt diserahkan ke pass jendela; kegagalan probe KUALITAS-KUOTA hanya men-jangkar ulang baris yang NULL/lewat — tidak pernah memperpanjang jangkar hidup (envelope yang meluncur menunda pelepasan selamanya, satu probe demi satu probe); dan probe still-exhausted berurutan melipatgandakan cooldown-nya (10 mnt → 6 jam cap) supaya tembok mingguan sungguhan tidak menjadi seribu dispatch ditolak per minggu.

**Terverifikasi live:** baris glm-5.2 disembuhkan `quota.no-clock-reset` pada pass pertama pasca-deploy; TASK-4CA0D674 (yang tombol Run again-nya tadinya ditolak) DISPATCHED; WAIT_QUOTA kosong.

**Tes:** 558 → 561 (jangkar: clockless zai → jendela panjang, provider tak dikenal → 30 mnt, resetsAt terstruktur tetap menang; penyembuhan: baris NULL dibalik, jangkar masa depan dihormati; probe: sukses → AVAILABLE, agen probe dipilih, kegagalan tidak memperpanjang jangkar hidup, jangkar lewat di-jangkar ulang via sinyal yang dikeraskan, claude-code/run-hidup/jangkar-iminen/model-tanpa-agen dilewati).

## D85 — Brain harness dicocokkan pada nama agen ACP, bukan pada "agen mana pun di workspace"

**Gejalanya menyamar sebagai kuota.** TASK-5A24B39E dirutekan ke Brain `claude-opus-high` (`mode: acp`, `acpAgent: claude-opus`) lalu parkir `WAIT_RESOURCE` dengan pesan *"⚠️ Usage limit reached for 5 hour. Your limit will reset at 2026-09-09 03:34:02"*. Operator yang menangkapnya: **langganan Claude-nya sedang sehat**, dan kalimat "Your limit will reset at …" adalah milik ZAI, bukan Anthropic. Run itu memakai kuota provider lain.

**Sebabnya satu baris di `agent-registry.mjs`:**

```js
const wantModel = ignoreModel || isHarnessRouted(candidate) ? null : modelKey(...)
```

Untuk harness, pencocokan model **dimatikan tanpa ada yang menggantikannya**. Yang tersisa di `matches()` hanyalah filter workspace — dan `preferAgentId` (agen milik worker) diperiksa lebih dulu. Jadi `sdmk-kader-architect` (zai/glm-5.2) lolos, dan dispatch mencatatnya `via: "exact"` seolah pencocokan berhasil.

**Asumsi yang dipegang komentar lama tidak pernah terbukti.** Ia berbunyi *"dispatched to an orchestrator agent that then drives the Claude harness over ACP"*. Bukti bahwa itu tidak terjadi, dikumpulkan 2026-09-08: **nol** container berlabel `openclaw.acp=1` (termasuk exited), **nol** `.claude-home` di seluruh workspace, **nol** `session/request_permission` dalam 24 jam, **nol** galat wrapper di log — sementara transkrip TASK-90D214DF mencatat `exec` **tiga kali** dan task `COMPLETE`. Wrapper `semanggi-acp-claude` (yang membuat `.claude-home` sebagai langkah PERTAMA) tidak pernah dieksekusi; konfigurasinya benar, `harness-bootstrap` mendaftarkannya tiap start, image `semanggi/sandbox-claude` ada di node. Yang tidak ada hanyalah pemanggilnya.

**Yang hilang lebih luas dari model yang salah:** run harness melewati SELURUH kontrak POC-3 — sandbox `--cap-drop ALL --read-only`, `.claude-home` durable di NFS, dan interposer gerbang izin (P3-03, P3-04) — tanpa meninggalkan satu baris log pun. Sebuah task L3 yang menjalankan shell tiga kali tanpa satu izin pun ditanyakan.

**Keputusan:** untuk `provider === "claude-code"`, `acpAgent` **MENGGANTIKAN** pencocokan model, bukan sekadar mematikannya. Agen dicocokkan pada `id`-nya sendiri — distinction yang sama yang `agentsForBrain` (brain test, 2026-09-06) sudah buat untuk provider ini, kini berlaku juga di jalur dispatch.

Tiga konsekuensi yang mengikat:

1. **Berlaku juga saat `ignoreModel`.** Jalur override admin sengaja berhenti memeriksa model, jadi justru di sanalah agen asing paling mudah lolos. Override model tidak mengubah agen mana yang sah untuk sebuah harness.
2. **Brain harness tanpa `acpAgent` tidak cocok dengan apa pun.** "Tidak ada yang cocok" adalah jawaban yang benar; menerima agen mana pun adalah bug ini.
3. **Pesan galat menyebut nama agen ACP**, bukan `claude-code/claude-code`. Pesan lama mengirim operator mencari agen bermodel yang tidak akan pernah ada.

**Yang perbaikan ini TIDAK selesaikan.** Dari 17 agen yang gateway iklankan, tidak ada satu pun bernama `claude`, `claude-opus`, atau `claude-sonnet` — agen ACP tidak muncul di `agents.list`. Setelah D85, dispatch claude-code **gagal keras** dengan alasan yang benar alih-alih diam-diam memakai GLM. Jalur suksesnya masih terbuka dan MUST diverifikasi dengan mengirim permintaan (aturan 4), bukan ditebak: apakah agen role memerlukan mapping `agents.entries.*.runtime.acp.agent` (yang docs OpenClaw sebut diperiksa sebelum dispatch), atau apakah dispatch harness harus memakai `sessions_spawn({ runtime: "acp", agentId })` alih-alih RPC `agent`.

**Test:** 561 → 568. Tes lama *"claude-code routes on workspace alone"* DIGANTI, bukan diperbaiki: ia menegaskan bahwa Brain claude-code tanpa `acpAgent` boleh dirutekan ke agen mana pun — bug ini, dikodifikasi sebagai kontrak. Regresi yang dipaku: harness memilih `acpAgent` meski `preferAgentId` menunjuk agen lain; armada tanpa agen ACP mengembalikan null alih-alih agen worker; jalur override tidak menyerahkan harness ke agen asing; Brain tanpa `acpAgent` tidak cocok; pesan galat menyebut agen ACP; Brain non-harness tidak berubah perilaku.
