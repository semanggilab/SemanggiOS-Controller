# Semanggi Work Controller

Admission control plane over AgentOS/OpenClaw — POC-4.

The controller decides **which task is allowed into the runtime, and when**. It does not run agents, own sessions, manage memory or tools, create sandboxes, or execute models: those stay with AgentOS and OpenClaw. OpenClaw remains the execution scheduler; this service is the admission controller in front of it.

## Status

Phases 1–3 of the POC-4 implementation order (§12.2) are complete and covered by tests that run without a cluster:

| Phase | Scope | State |
|---|---|---|
| 1 | Data model + append-only EventLog | done |
| 2 | State machine + revisions + `/api/work/*` + OpenAPI | done |
| 3 | Admission pipeline, fairness, lease, quota — against a fake AgentOS | done |
| 4+ | Real AgentOS dispatcher, Slack, intent router, stack integration | **not started** — blocked on §11 verification and on POC-3 closing |

`npm test` — 55 tests, no network, no cluster, no dependencies.

## What is deliberately not implemented yet

The AgentOS dispatch contract (§11 butir 1: endpoint, auth, payload) has not been verified against AgentOS 0.7.6. POC-1 §17 forbids substituting a guess, so `src/runtime/agentos.mjs` refuses to invent one: the endpoint and payload builder must be supplied by configuration, and dispatch throws a named error until they are. The admission pipeline is proven against `src/runtime/fake-agentos.mjs` instead.

Two more areas wait on POC-3 rather than on this repo:

- **Approval bridge for ACP tasks (P4-08).** POC-3 E1 showed the harness currently absorbs a permission denial internally — no `WAITING_HUMAN` reaches the control plane. The controller side is built and tested; the runtime side is POC-3 E3/E4.
- **`claude-code` cost accounting (P4-03/§4).** The resource class exists and is enforced; the usage numbers come from POC-3 E8.

## Layout

```text
src/
  db/schema.sql          data model; append-only and immutability enforced by triggers
  db/index.mjs           storage adapter (async interface, SQLite driver)
  domain/state-machine.mjs
  domain/events.mjs      EventLog + secret redaction
  domain/repositories.mjs the only code that writes tables
  scheduler/selection.mjs weighted fair queueing + priority + expedite
  scheduler/routing.mjs   model policy: quality picks candidates, availability picks timing
  scheduler/admission.mjs the nine-step pipeline
  scheduler/scheduler.mjs event-driven re-evaluation
  runtime/agentos.mjs     dispatch adapter (contract unverified — see above)
  runtime/fake-agentos.mjs test double
  api/server.mjs          /api/work/* over node:http
  api/openapi.json        API schema (deliverable per §7.1)
config/routing.example.json
tests/unit/                55 tests
docs/decisions.md          architecture decisions with reasoning
docs/poc4-evidence.md      what was verified and how
```

## Running

```sh
npm test

CONTROLLER_TOKEN_FILE=/run/secrets/semanggi_controller_token \
SEMANGGI_ROUTING_CONFIG=/config/routing.json \
SEMANGGI_DB=/opt/semanggi/volumes/shared/service/semanggios/controller/controller.db \
AGENTOS_URL=http://agentos:3000 \
npm start
```

Startup fails loudly on missing configuration. A controller that boots without a routing policy would report healthy while scheduling nothing.

## Design commitments worth knowing

- **A blocked task waits; it never fails.** Nine admission checks, nine distinct `WAIT_*` states, so the queue always says *why*.
- **No silent downgrade.** Quality decides the candidate models; availability decides only whether to dispatch now or wait. `fallback: none` means wait.
- **History is immutable.** A revision creates a new execution. Finalized executions and the EventLog are protected by database triggers, not by convention.
- **Fairness survives restart.** Weighted-fair counters are derived from the execution table, not from process memory.
- **One dispatcher.** Replica count is exactly 1, scheduling passes never overlap, and a task with a live execution is never dispatched twice.
