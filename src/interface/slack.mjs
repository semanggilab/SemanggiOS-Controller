// Slack surface — POC-4 §8.2, deliberately narrow.
//
// Commands plus approval notifications, nothing more. This is not a chat
// gateway: OpenClaw owns channel binding and delivery. What lives here is the
// mapping from an operator sentence to a controller action, and the four
// message shapes the parent spec §8.1 defines (command / task / event / decision).
import { classify, parseDuration, Intent, Action } from "./intent.mjs";
import { Status } from "../domain/state-machine.mjs";
import { isExpedited } from "../scheduler/selection.mjs";

const LEVEL_URGENCY = { L3: "ACTION REQUIRED", L2: "ACTION REQUIRED", L1: "FYI", L0: "FYI" };

export function createSlackSurface(controller, { defaultProjectId = null } = {}) {
  const { repos, scheduler, now } = controller;

  /** command level (§8.1): what the operator asked, echoed back plainly. */
  const say = (text, blocks = []) => ({ text, blocks });

  async function handle({ text, user = "operator" }) {
    const parsed = classify(text);

    // The spec's hard rule: a classification we are not sure about becomes a
    // question, never an action.
    if (parsed.intent === Intent.CONFIRM) {
      return say(
        `I'm not sure what you meant${parsed.reason ? ` — ${parsed.reason}` : ""}. ` +
          `Try: \`task <description>\`, \`status TASK-XXXX\`, \`approve TASK-XXXX\`, \`expedite TASK-XXXX 30m\`.`,
        [{ kind: "confirmation", parsed }],
      );
    }

    if (parsed.intent === Intent.CHAT) {
      return say("Hi. Ask me for `status TASK-XXXX`, or say `task <description>` to queue work.");
    }

    switch (parsed.action) {
      case Action.CREATE: {
        const projectId = defaultProjectId;
        if (!projectId) return say("No default project is configured, so I don't know where to file this.");
        const title = parsed.text.replace(/^\S+\s*/, "").trim() || "untitled";
        const task = await repos.tasks.create({ projectId, title });
        await repos.tasks.setStatus(task.id, Status.QUEUED);
        await scheduler.notify();
        const fresh = await repos.tasks.get(task.id);
        return say(`Queued *${task.id}* — ${title}\n${describe(fresh)}`);
      }

      case Action.STATUS: {
        const task = await repos.tasks.get(parsed.taskId);
        if (!task) return say(`I don't know a task called ${parsed.taskId}.`);
        const executions = await repos.executions.listByTask(task.id);
        const approvals = await repos.approvals.pendingForTask(task.id);
        const lines = [
          `*${task.id}* — ${task.title}`,
          describe(task),
          `revisions: ${executions.length}`,
        ];
        if (approvals.length) lines.push(`waiting on you: ${approvals[0].question}`);
        return say(lines.join("\n"));
      }

      case Action.EXPEDITE: {
        const ttlMs = parseDuration(parsed.text) ?? 30 * 60 * 1000;
        const task = await repos.tasks.get(parsed.taskId);
        if (!task) return say(`I don't know a task called ${parsed.taskId}.`);
        await repos.tasks.expedite(task.id, { ttlMs, actor: user });
        await scheduler.notify();
        return say(`Boosted *${task.id}* for ${Math.round(ttlMs / 60000)} minutes. It reverts on its own.`);
      }

      case Action.PAUSE: {
        const task = await repos.tasks.get(parsed.taskId);
        if (!task) return say(`I don't know a task called ${parsed.taskId}.`);
        try {
          await repos.tasks.cancel(task.id, { actor: user, note: "paused from Slack" });
        } catch (err) {
          return say(`Can't pause *${task.id}*: ${err.message}`);
        }
        return say(`Cancelled *${task.id}*.`);
      }

      case Action.APPROVE:
      case Action.REJECT: {
        const [approval] = await repos.approvals.pendingForTask(parsed.taskId);
        if (!approval) return say(`*${parsed.taskId}* has nothing waiting for a decision.`);
        const decision = parsed.action === Action.APPROVE ? "APPROVE" : "REJECT";
        await repos.approvals.decide(approval.id, { decision, decidedBy: user });
        await scheduler.notify();
        return say(`Recorded *${decision}* on ${approval.id} for *${parsed.taskId}*, by ${user}.`);
      }

      case Action.CONTINUE: {
        const task = await repos.tasks.get(parsed.taskId);
        if (!task) return say(`I don't know a task called ${parsed.taskId}.`);
        const instruction = parsed.text.replace(/^\S+\s+\S+\s*/, "").trim();
        try {
          await repos.tasks.createRevision(task.id, { sessionMode: "CONTINUE", instruction, actor: user });
        } catch (err) {
          return say(`Can't continue *${task.id}*: ${err.message}`);
        }
        await scheduler.notify();
        return say(`Continuing *${task.id}* in the same session.`);
      }

      case Action.REVIEW: {
        const executions = await repos.executions.listByTask(parsed.taskId);
        const last = executions.at(-1);
        if (!last) return say(`*${parsed.taskId}* has no executions yet.`);
        return say(
          `*${parsed.taskId}* revision ${last.revision_no}: ${last.status}\n` +
            `model ${last.model_provider}/${last.model_id}, ${repos.executions.billableTokens(last)} tokens\n` +
            (last.result ? `result: ${String(last.result).slice(0, 300)}` : "no result recorded"),
        );
      }

      default:
        return say("I understood the words but not the request.");
    }
  }

  function describe(task) {
    const bits = [`status: ${task.status}`];
    if (task.wait_reason) bits.push(`reason: ${task.wait_reason}`);
    if (task.next_retry_at) bits.push(`eta: ${new Date(task.next_retry_at).toISOString()}`);
    if (isExpedited(task, now())) bits.push("expedited");
    return bits.join(" · ");
  }

  /** event level (§8.1): the notification an approval should produce. */
  function approvalNotification(approval, task) {
    const urgency = LEVEL_URGENCY[approval.level] ?? "ACTION REQUIRED";
    return say(
      `*${urgency}* — ${approval.level} approval on *${task?.id ?? approval.task_id}*\n` +
        `${approval.question}\n` +
        `Reply \`approve ${approval.task_id}\` or \`reject ${approval.task_id}\`.`,
    );
  }

  return { handle, approvalNotification };
}
