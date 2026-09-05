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

  return {
    dispatches,

    /** Make the next dispatch throw; used for the runtime-refusal path. */
    failNextDispatch(error) {
      failNext = error instanceof Error ? error : new Error(String(error));
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
      };
      dispatches.push({ ...request, handoff });
      return handoff;
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
      return repos.executions.get(executionId);
    },
  };
}
