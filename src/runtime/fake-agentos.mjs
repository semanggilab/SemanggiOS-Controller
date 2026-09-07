// Fake AgentOS — the test double POC-4 §12.2 calls for so the admission
// pipeline can be proven without a live cluster.
//
// It records what it was asked to do and lets a test drive the runtime side of
// the lifecycle (start, complete, fail, quota-reject) explicitly. Nothing here
// simulates OpenClaw behaviour; it only stands in for the dispatch contract.

import { ExecutionStatus, Status } from "../domain/state-machine.mjs";

export function createFakeAgentOS({ repos } = {}) {
  const dispatches = [];
  let failNext = null;
  let counter = 0;
  // The fake's own session registry: which dispatched runs the "gateway"
  // currently considers live, and what terminal classification a describe
  // would report. Backs abortRun/describeSession (D71/D72) so the watchdog
  // and reconciler are tested against the real contract shapes instead of
  // skipping their verification paths.
  const liveRuns = new Map(); // sessionKey -> { startedAt }
  const sessionStatus = new Map(); // sessionKey -> "running" | "done" | "killed" | ...

  return {
    dispatches,

    /** Make the next dispatch throw; used for the runtime-refusal path. */
    failNextDispatch(error) {
      failNext = error instanceof Error ? error : new Error(String(error));
    },

    /** Test knobs for the D71/D72 gateway surfaces. */
    gateway: {
      markRunning(sessionKey) {
        liveRuns.set(sessionKey, { startedAt: Date.now() });
        sessionStatus.set(sessionKey, "running");
      },
      markTerminal(sessionKey, status = "done") {
        liveRuns.delete(sessionKey);
        sessionStatus.set(sessionKey, status);
      },
      aborts: [],
    },

    async dispatch(request) {
      if (failNext) {
        const err = failNext;
        failNext = null;
        throw err;
      }
      counter += 1;
      const handoff = {
        runtimeRef: `dispatch-${String(counter).padStart(4, "0")}`,
        sessionRef: `agent:${request.worker.agent_ref}:${request.task.id}`,
        sessionKey: `agent:${request.worker.agent_ref}:${request.task.id.toLowerCase()}:r1`,
      };
      dispatches.push({ ...request, handoff });
      // Deliberately NOT auto-marked running: the default fake gateway models
      // "dispatched, then the gateway lost it" (D20's story — restart
      // mid-flight, describe finds nothing, abort says no-active-run, the
      // watchdog parks). Tests that want a LIVE run behind the silence call
      // gateway.markRunning(key) — the exact shape the cluster incident had.
      return handoff;
    },

    // The measured `sessions.describe` contract, reduced to the fields the
    // controller reads (D72): status is the gateway's durable classification.
    async describeSession({ key }) {
      const status = sessionStatus.get(key);
      if (!status) return null;
      const live = liveRuns.get(key);
      return {
        key,
        status,
        startedAt: live?.startedAt ?? null,
        endedAt: live ? null : Date.now(),
        abortedLastRun: status === "killed",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        sessionId: null,
      };
    },

    // The measured `sessions.abort` contract (D71): {ok, abortedRunId, status},
    // status "no-active-run" when nothing was live on that key.
    async abortRun({ sessionKey }) {
      this.gateway.aborts.push(sessionKey);
      if (!liveRuns.has(sessionKey)) {
        return { ok: true, aborted: false, status: "no-active-run" };
      }
      liveRuns.delete(sessionKey);
      sessionStatus.set(sessionKey, "killed");
      return { ok: true, aborted: true, status: "aborted" };
    },

    // --- lifecycle callbacks a test can trigger ------------------------------

    async startExecution(executionId) {
      const exec = await repos.executions.get(executionId);
      await repos.executions.setStatus(executionId, ExecutionStatus.RUNNING);
      await repos.tasks.setStatus(exec.task_id, Status.RUNNING);
      return repos.executions.get(executionId);
    },

    async completeExecution(executionId, { result = "ok", tokensIn = 0, tokensOut = 0 } = {}) {
      const exec = await repos.executions.get(executionId);
      await repos.executions.update(executionId, { tokens_input: tokensIn, tokens_output: tokensOut });
      await repos.executions.setStatus(executionId, ExecutionStatus.COMPLETE, { result });
      await repos.tasks.setStatus(exec.task_id, Status.COMPLETE);
      if (exec?.session_key) this.gateway.markTerminal(exec.session_key, "done");
      const task = await repos.tasks.get(exec.task_id);
      const workspacePath = task.workspace_path ?? null;
      const lease = workspacePath ? await repos.leases.get(workspacePath) : null;
      if (lease?.execution_id === executionId) await repos.leases.release(workspacePath, { executionId });
      return repos.executions.get(executionId);
    },

    async failExecution(executionId, { result = "error" } = {}) {
      const exec = await repos.executions.get(executionId);
      await repos.executions.setStatus(executionId, ExecutionStatus.FAILED, { result });
      await repos.tasks.setStatus(exec.task_id, Status.FAILED);
      if (exec?.session_key) this.gateway.markTerminal(exec.session_key, "failed");
      return repos.executions.get(executionId);
    },
  };
}
