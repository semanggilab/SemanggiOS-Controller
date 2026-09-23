// Shared test harness: an in-memory controller with a controllable clock and a
// fake AgentOS. Every suite builds its own so tests never share state.
import { createController } from "../../src/app.mjs";
import { createFakeAgentOS } from "../../src/runtime/fake-agentos.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

export const SAMPLE_ROUTING = {
  catalog: {
    "glm-4.7": { provider: "zai", model: "glm-4.7", mode: "interactive" },
    // Effort-bearing entries, mirroring the real catalog: routing carries the
    // reasoning level, not just the model.
    "glm-5.2-high": { provider: "zai", model: "glm-5.2", mode: "interactive", thinking: "high" },
    "glm-5.2-max": { provider: "zai", model: "glm-5.2", mode: "interactive", thinking: "max" },
    "glm-5.1-on": { provider: "zai", model: "glm-5.1", mode: "interactive", thinking: "low" },
    "claude-opus-high": { provider: "anthropic", model: "claude-opus-5", mode: "interactive" },
    "gemini-flash": { provider: "google", model: "gemini-flash", mode: "interactive" },
    "claude-code": { provider: "claude-code", model: "claude-code", mode: "acp" },
    "claude-code-misrouted": { provider: "claude-code", model: "claude-code", mode: "interactive" },
  },
  routes: {
    architecture: {
      critical: { preferred: ["claude-opus-high", "glm-5.2-high"], fallback: "none" },
      normal: { preferred: ["glm-4.7"] },
    },
    documentation: {
      normal: { preferred: ["gemini-flash", "glm-4.7"] },
      low: { preferred: ["gemini-flash"] },
    },
    coding: {
      normal: { preferred: ["claude-code"] },
      critical: { preferred: ["claude-code-misrouted"] },
    },
  },
  defaultCategory: "documentation",
};

export class Clock {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now = () => this.t;
  advance(ms) {
    this.t += ms;
    return this.t;
  }
}

export async function buildHarness({ routing = SAMPLE_ROUTING, config = {}, clock = new Clock(), log, sharedState = null } = {}) {
  const holder = {};
  const runtime = {
    dispatch: (req) => holder.fake.dispatch(req),
    // D71/D72: the same gateway surfaces production wires through
    // gatewayHooks, exposed here so watchdog/reconciler tests exercise the
    // real verification paths instead of skipping them.
    abortRun: (p) => holder.fake.abortRun(p),
    describeSession: (p) => holder.fake.describeSession(p),
  };
  const controller = await createController({
    routing,
    runtime,
    config: { maxRunning: 8, leaseTtlMs: 60_000, watchdogMs: 1_000_000, ...config },
    now: clock.now,
    sharedState,
    ...(log ? { log } : {}),
  });
  holder.fake = createFakeAgentOS({ repos: controller.repos });
  controller.gatewayHooks.abortRun = runtime.abortRun;
  controller.gatewayHooks.describeSession = runtime.describeSession;
  return { ...controller, clock, fake: holder.fake, runtime };
}

/** Convenience seeding: one project, one worker, one available model. */
export async function seedBasics(h, { weight = 1, maxConcurrent = 2, concurrencyLimit = 4 } = {}) {
  const project = await h.repos.projects.create({
    name: "alpha",
    weight,
    workspacePath: "/nfs/workspaces/alpha",
  });
  const worker = await h.repos.workers.create({
    role: "documentation",
    agentRef: "doc-worker",
    maxConcurrent,
    projectAccess: [project.id],
  });
  await h.repos.resources.upsert({ provider: "google", model: "gemini-flash", concurrencyLimit });
  await h.repos.resources.upsert({ provider: "zai", model: "glm-4.7", concurrencyLimit });
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.1", concurrencyLimit });
  await h.repos.resources.upsert({ provider: "zai", model: "glm-5.2", concurrencyLimit });
  return { project, worker };
}

/**
 * `isolate: true` gives the task its own workspace_path.
 *
 * Since 2026-08-21 the default workspace is the PROJECT's, so two tasks in one
 * project contend for one lease and the second parks on WAIT_WORKSPACE. That is
 * correct, but it masks whatever blocker a test is actually about, so tests
 * probing concurrency/worker/runtime limits opt out of the shared workspace.
 */
export async function queuedTask(h, { project, worker, isolate = false, ...overrides }) {
  const task = await h.repos.tasks.create({
    projectId: project.id,
    workerId: worker?.id ?? null,
    title: overrides.title ?? "task",
    ...(isolate ? { workspacePath: `${project.workspace_path}/isolated/${overrides.title ?? "task"}` } : {}),
    ...overrides,
  });
  await h.repos.tasks.setStatus(task.id, Status.QUEUED);
  return h.repos.tasks.get(task.id);
}
