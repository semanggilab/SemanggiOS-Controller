// The Slack app: slash commands, Block Kit approvals, full control.
//
// This sits on top of `slack.mjs` rather than replacing it. That surface is
// transport-agnostic and stays useful for curl and the future UI; this one is
// specifically Slack, and it exists because two decisions made Slack different
// from every other caller:
//
// 1. Slack gets FULL control — create, stop, change model, run again. Slack is
//    also a place where people type fast and sometimes into the wrong window,
//    so every destructive verb asks first, and the question names the exact
//    target. A stray "yes" can then only confirm the thing that was actually
//    described back.
//
// 2. Identity is per operator. Slack knows who typed; the Slack user id is
//    mapped to a registered operator and every action is attributed to that
//    person. An unregistered Slack user is REFUSED rather than quietly acting as
//    "the Slack app" — otherwise the whole workspace shares one identity and
//    `decided_by` stops meaning anything. Deliberately no create-on-first-sight:
//    that would let anyone in the workspace mint themselves an identity by
//    typing a word.
import { classify, parseDuration, parseModelSpec, Intent, Action } from "./intent.mjs";
import { createPrepareTask } from "../domain/prepare.mjs";
import { Status } from "../domain/state-machine.mjs";
import { WakeReason } from "../scheduler/scheduler.mjs";
import { nullLogger } from "../domain/logger.mjs";

const ephemeral = (text, blocks) => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });
const inChannel = (text, blocks) => ({ response_type: "in_channel", text, ...(blocks ? { blocks } : {}) });

/**
 * Verbs that stop or destroy work, and therefore ask before acting.
 * CANCEL sits here too: CANCELLED is a dead end in the state machine — the
 * operator should get the same "name what will die" pause for a permanent
 * cancel as for a stop.
 */
const DESTRUCTIVE = new Set([Action.PAUSE, Action.CANCEL]);
const LIVE = ["PENDING", "DISPATCHED", "RUNNING"];

const HELP =
  "`task <what to do>` · `/work <what to do>` (decompose into phases) · " +
  "`/prepare <guidance>` (one analyst task → docs/plans.md + docs/tasks.md) · " +
  "`/task <what to do>` (one direct task) · `queue` · `status TASK-XXXX` · `stop TASK-XXXX` · " +
  "`model TASK-XXXX glm-5.2 high` · `run TASK-XXXX [TASK-YYYY …]` · `cancel TASK-XXXX [TASK-YYYY …]` · " +
  "`approve TASK-XXXX` · `expedite TASK-XXXX 30m`";

export function createSlackApp(controller, { defaultProjectId = null, log = nullLogger } = {}) {
  const { repos, scheduler, now } = controller;

  async function actorFor(slackUserId, slackUserName) {
    const operator = slackUserId ? await controller.operators?.bySlackUser(slackUserId) : null;
    if (!operator) {
      return {
        ok: false,
        message: ephemeral(
          "You're not registered as an operator here, so I won't act as you.\n" +
            `Ask an admin to register you: \`POST /api/work/operators {"name":"${slackUserName ?? "Your Name"}","slackUserId":"${slackUserId ?? "U…"}"}\``,
        ),
      };
    }
    return { ok: true, operator, readOnly: operator.role === "readonly" };
  }

  /** The Block Kit card an L2/L3 approval should produce. */
  const approvalBlocks = (approval, task) => [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${approval.level} approval needed* — \`${approval.task_id}\`${task ? ` ${task.title}` : ""}\n` +
          approval.question,
      },
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: approval.id },
        { type: "button", action_id: "reject", style: "danger", text: { type: "plain_text", text: "Reject" }, value: approval.id },
      ],
    },
  ];

  /**
   * The least-loaded active worker that may touch this project.
   *
   * Least-loaded rather than first-found: picking the head of the list would
   * pile every Slack-created task onto one worker while others idle, and the
   * queue would look busy for a reason that isn't real.
   */
  async function pickWorker(projectId) {
    const eligible = [];
    for (const w of await repos.workers.list()) {
      if (w.status !== "ACTIVE") continue;
      if (w.project_access.length > 0 && !w.project_access.includes(projectId)) continue;
      eligible.push({ worker: w, active: await repos.workers.activeCount(w.id) });
    }
    if (!eligible.length) return null;
    eligible.sort((a, b) => a.active - b.active);
    return eligible[0].worker;
  }

  async function queueSummary() {
    const rows = [];
    const interesting = [
      Status.QUEUED,
      Status.DISPATCHED,
      Status.RUNNING,
      Status.BLOCKED,
      ...Object.values(Status).filter((s) => s.startsWith("WAIT_")),
    ];
    for (const status of [...new Set(interesting)]) {
      for (const t of await repos.tasks.list({ status, limit: 25 })) {
        rows.push(
          `• \`${t.id}\` ${t.status} — ${String(t.title).slice(0, 60)}` +
            (t.wait_reason ? ` _(${String(t.wait_reason).slice(0, 60)})_` : ""),
        );
      }
    }
    return rows.length ? rows.join("\n") : "Nothing queued, running or waiting.";
  }

  async function taskDetail(id) {
    const task = await repos.tasks.get(id);
    if (!task) return ephemeral(`I don't know a task called \`${id}\`.`);
    const executions = await repos.executions.listByTask(id);
    const last = executions.at(-1);
    const spent = executions.reduce((n, e) => n + repos.executions.billableTokens(e), 0);
    const pending = await repos.approvals.pendingForTask(id);
    const lines = [
      `\`${task.id}\` *${task.status}* — ${task.title}`,
      task.wait_reason ? `waiting: ${task.wait_reason}` : null,
      last ? `last run: rev${last.revision_no} ${last.status} on ${last.model_provider}/${last.model_id}` : "never run",
      `revisions: ${executions.length} · tokens: ${spent}`,
      pending.length ? `waiting on you: ${pending[0].question}` : null,
    ].filter(Boolean);
    return ephemeral(lines.join("\n"), pending.length ? approvalBlocks(pending[0], task) : undefined);
  }

  /**
   * Pending confirmations, keyed by Slack user.
   *
   * In memory on purpose. A confirmation that survives a restart is a
   * confirmation nobody remembers giving, and this is the path that stops live
   * work. Losing it costs one retyped word; honouring a stale one could stop the
   * wrong task hours later.
   */
  const pendingConfirm = new Map();
  const CONFIRM_TTL_MS = 2 * 60 * 1000;

  const YES = /^(ya|yes|y|lanjut|confirm|konfirmasi)$/i;
  const NO = /^(tidak|no|n|batal|cancel)$/i;
  // "ok" is the most natural way to agree in a channel, and also the word the
  // intent router reads as `approve`. It answers a pending question when there
  // is one, and otherwise falls through to normal parsing — so it can never
  // both confirm a stop and approve something in the same breath.
  const MAYBE_YES = /^(ok|oke|okay|sip)$/i;

  async function handleCommand({ text, user_id: userId, user_name: userName } = {}) {
    const who = await actorFor(userId, userName);
    if (!who.ok) return who.message;
    const { operator, readOnly } = who;

    const trimmed = String(text ?? "").trim();

    // A bare yes/no answers the outstanding question rather than being parsed
    // afresh — otherwise "ok" would classify as `approve` and act on something
    // else entirely.
    const outstanding = pendingConfirm.get(userId);
    const fresh = outstanding && outstanding.expiresAt >= now();
    if (YES.test(trimmed) || (MAYBE_YES.test(trimmed) && fresh)) {
      pendingConfirm.delete(userId);
      if (!fresh) return ephemeral("Nothing waiting to be confirmed.");
      return runAction(outstanding.parsed, operator, { confirmed: true });
    }
    if (NO.test(trimmed)) {
      const had = pendingConfirm.delete(userId);
      return ephemeral(had ? "Dropped it — nothing changed." : "Nothing waiting to be confirmed.");
    }

    const parsed = classify(trimmed);

    if (parsed.intent === Intent.CHAT) return ephemeral(`Hi ${operator.name}. ${HELP}`);
    if (parsed.intent === Intent.CONFIRM) {
      return ephemeral(`I'm not sure what you meant${parsed.reason ? ` — ${parsed.reason}` : ""}.\n${HELP}`);
    }

    if (readOnly && ![Action.STATUS, Action.QUEUE, Action.REVIEW].includes(parsed.action)) {
      return ephemeral(`You're registered read-only, ${operator.name}. I can show you \`queue\` and \`status\`.`);
    }

    if (DESTRUCTIVE.has(parsed.action)) {
      // Multi-id destructive verbs describe EVERY target before asking —
      // "cancel A B" confirmed against a description of only A is how B dies
      // without ever being named.
      const ids = parsed.taskIds?.length ? parsed.taskIds : [parsed.taskId];
      const targets = [];
      for (const id of ids) {
        const task = await repos.tasks.get(id);
        if (!task) return ephemeral(`I don't know a task called \`${id}\`.`);
        if (![Status.COMPLETE, Status.CANCELLED].includes(task.status)) targets.push(task);
      }
      if (targets.length === 0) {
        return ephemeral(`Already ${Status.COMPLETE} or ${Status.CANCELLED} — nothing to ${parsed.action.toLowerCase()}.`);
      }
      pendingConfirm.set(userId, { parsed, expiresAt: now() + CONFIRM_TTL_MS });
      const verbWord = parsed.action === Action.CANCEL ? "cancels" : "stops";
      return ephemeral(
        `This ${verbWord} ${targets.map((t) => `\`${t.id}\` — *${t.title}* (${t.status})`).join(", ")}.\n` +
          "Reply `yes` to go ahead, `no` to drop it.",
      );
    }

    return runAction(parsed, operator, { confirmed: false });
  }

  async function runAction(parsed, operator, { confirmed, projectId = null }) {
    // PREPARE: satu task analyst untuk dokumen rencana — kemampuan
    // control-plane yang sama dengan jalur Command Center (D47), hanya
    // project-nya jatuh ke default karena Slack tidak punya project picker.
    if (parsed.intent === Intent.PREPARE) {
      const targetProject = projectId ?? defaultProjectId;
      if (!targetProject) {
        return ephemeral("No default project is configured, so I don't know where to file this.");
      }
      const outcome = await createPrepareTask(controller, {
        projectId: targetProject,
        text: parsed.text,
        actor: operator.name,
      });
      if (!outcome.ok) return ephemeral(outcome.reason);
      return inChannel(
        `Queued \`${outcome.task.id}\` — analyst (${outcome.level}, ${outcome.brain.name}) will prepare ` +
          `docs/plans.md and docs/tasks.md  _(${operator.name})_`,
      );
    }

    switch (parsed.action) {
      case Action.QUEUE:
        return ephemeral(await queueSummary());

      case Action.STATUS:
      case Action.REVIEW:
        return taskDetail(parsed.taskId);

      case Action.CREATE: {
        // Command Center (TASK:) passes the operator's selected project; Slack
        // has no project picker, so it falls back to the configured default.
        const targetProject = projectId ?? defaultProjectId;
        if (!targetProject) return ephemeral("No default project is configured, so I don't know where to file this.");
        // Verb-declared text still carries its verb ("task perbaiki X"),
        // prefix-declared text does not ("TASK: perbaiki X") — stripping the
        // first word there would eat a word of the actual request.
        const title = (parsed.hasVerbPrefix === false
          ? parsed.text
          : parsed.text.replace(/^\S+\s*/, "")
        ).trim();
        if (!title) return ephemeral("Say `task <what to do>`.");

        // A task with no worker parks on WAIT_WORKER forever — admission
        // assigns nobody, it only checks. Every other surface passes a
        // workerId; Slack has nowhere to type one, so it has to choose. Found
        // live: the first Slack-created task queued cleanly and then sat at
        // "no worker assigned" indefinitely, which reads to an operator as the
        // system quietly ignoring them.
        const worker = await pickWorker(targetProject);
        if (!worker) {
          return ephemeral(
            "No active worker can take this project, so queueing it would just park it forever. " +
              "Register a worker with access to it first.",
          );
        }

        const task = await repos.tasks.create({
          projectId: targetProject,
          workerId: worker.id,
          title: title.slice(0, 120),
          description: title,
        });
        await repos.tasks.setStatus(task.id, Status.QUEUED, { actor: operator.name });
        await scheduler.notify(WakeReason.TASK_CREATED);
        log.info("slack.task-created", { task: task.id, by: operator.name });
        return inChannel(`Queued \`${task.id}\` — ${title.slice(0, 80)}  _(${operator.name})_`);
      }

      case Action.PAUSE: {
        if (!confirmed) return ephemeral("That needs confirming first.");
        return stopTask(parsed.taskId, operator);
      }

      case Action.MODEL: {
        const { model, effort } = parseModelSpec(parsed.text);
        if (!model && !effort) return ephemeral("Say `model TASK-XXXX glm-5.2 high`.");
        const task = await repos.tasks.get(parsed.taskId);
        if (!task) return ephemeral(`I don't know a task called \`${parsed.taskId}\`.`);

        // Routing works in catalog names, not free text, and a name with
        // nothing behind it parks the task in WAIT_RESOURCE. Resolving here
        // means the operator finds out in the reply rather than by watching the
        // task fail to move.
        const match = controller.policy.matchCatalog(model, effort);
        if (!match.ok) {
          return ephemeral(
            `${match.reason}. Leaving \`${task.id}\` as it was.\n` +
              `Available: ${match.candidates.map((c) => `\`${c}\``).join(", ")}`,
          );
        }

        const policy = { ...(task.model_policy ?? {}), preferred: [match.name] };
        try {
          await repos.tasks.updatePlan(task.id, { modelPolicy: policy, actor: operator.name });
        } catch (err) {
          return ephemeral(`Can't change \`${task.id}\`: ${err.message}`);
        }
        log.info("slack.model-changed", { task: task.id, catalog: match.name, by: operator.name });
        // "at high" and "at high (preference only)" are different promises, and
        // the operator is about to spend money on the difference.
        const effortNote = match.entry.thinking
          ? ` at ${match.entry.thinking}` +
            ((match.entry.effortMode ?? "guaranteed") === "preference" ? " _(preference only — the provider ignores it)_" : "")
          : "";
        return inChannel(
          `\`${task.id}\` will now use *${match.entry.provider}/${match.entry.model}*` +
            `${effortNote} (\`${match.name}\`) _(${operator.name})_.\n` +
            ([Status.BLOCKED, Status.CREATED].includes(task.status)
              ? `Say \`run ${task.id}\` to start it.`
              : `It's ${task.status}; the change applies to its next run.`),
        );
      }

      case Action.RUN: {
        // Multi-id: "run TASK-A TASK-B" releases/resumes each in one breath —
        // the operator who registered a dozen held tasks from docs/tasks.md
        // should not send a dozen messages. Each id is judged independently:
        // one that is already moving must not fail the whole batch.
        const ids = parsed.taskIds?.length ? parsed.taskIds : [parsed.taskId];
        const lines = [];
        for (const id of ids) {
          const task = await repos.tasks.get(id);
          if (!task) {
            lines.push(`I don't know a task called \`${id}\`.`);
            continue;
          }

          // Three different meanings of "run", and conflating them is how a
          // finished task quietly gets re-billed:
          //   CREATED  -> it was stocked; release it
          //   BLOCKED  -> it was stopped or it failed; a new revision resumes it
          //   anything else -> it's already moving, or it's done
          if (task.status === Status.CREATED) {
            await repos.tasks.setStatus(task.id, Status.QUEUED, { actor: operator.name });
            await scheduler.notify(WakeReason.TASK_CREATED);
            lines.push(`Released \`${task.id}\` into the queue.`);
            continue;
          }
          if (task.status === Status.BLOCKED) {
            try {
              await repos.tasks.createRevision(task.id, {
                sessionMode: "CONTINUE",
                instruction: null,
                actor: operator.name,
              });
            } catch (err) {
              lines.push(`Can't run \`${task.id}\`: ${err.message}`);
              continue;
            }
            await scheduler.notify(WakeReason.MANUAL);
            log.info("slack.task-rerun", { task: task.id, by: operator.name });
            lines.push(`Running \`${task.id}\` again.`);
            continue;
          }
          lines.push(`\`${task.id}\` is ${task.status} — nothing to start.`);
        }
        // Attribution once per message, not per task: it belongs to the
        // command, and repeating it N times turns a two-task run into noise.
        return inChannel(`${lines.join("\n")} _(${operator.name})_`);
      }

      case Action.CANCEL: {
        // CANCELLED, bukan BLOCKED: permintaan "buang task ini", bukan
        // "tahan sebentar". Run yang masih hidup di-finalisasi dan di-abort
        // di gateway dulu (urutan yang sama dengan stopTask — finalisasi
        // sebelum abort, supaya lifecycle `end` dari gateway tidak menimpa
        // status yang operator minta), lease dilepas, baru status akhir.
        const ids = parsed.taskIds?.length ? parsed.taskIds : [parsed.taskId];
        const lines = [];
        for (const id of ids) {
          const task = await repos.tasks.get(id);
          if (!task) {
            lines.push(`I don't know a task called \`${id}\`.`);
            continue;
          }
          if ([Status.COMPLETE, Status.CANCELLED].includes(task.status)) {
            lines.push(`\`${task.id}\` is already ${task.status} — nothing to cancel.`);
            continue;
          }
          const execution = await repos.executions.latest(task.id);
          const live = execution && LIVE.includes(execution.status);
          if (live) {
            await repos.executions.setStatus(execution.id, "CANCELLED", { result: `cancelled by ${operator.name}` });
            if (execution.session_ref && controller.runtime?.abortRun) {
              try {
                await controller.runtime.abortRun({ sessionKey: execution.session_ref });
              } catch {
                // Abort gagal bukan berarti cancel gagal — run akan berakhir
                // sendiri; status task tetap CANCELLED sesuai permintaan.
              }
            }
            if (task.workspace_path) {
              await repos.leases.release(task.workspace_path, { executionId: execution.id, actor: operator.name });
            }
          }
          try {
            await repos.tasks.setStatus(task.id, Status.CANCELLED, {
              reason: "cancelled by operator",
              actor: operator.name,
            });
          } catch (err) {
            lines.push(`Can't cancel \`${task.id}\`: ${err.message}`);
            continue;
          }
          log.info("slack.task-cancelled", { task: task.id, wasLive: Boolean(live), by: operator.name });
          lines.push(`Cancelled \`${task.id}\` — *${String(task.title).slice(0, 60)}*.`);
        }
        return inChannel(`${lines.join("\n")} _(${operator.name})_`);
      }

      case Action.CONTINUE: {
        const instruction = parsed.text.replace(/^\S+\s+\S+\s*/, "").trim();
        try {
          await repos.tasks.createRevision(parsed.taskId, {
            sessionMode: "CONTINUE",
            instruction: instruction || null,
            actor: operator.name,
          });
        } catch (err) {
          return ephemeral(`Can't continue \`${parsed.taskId}\`: ${err.message}`);
        }
        await scheduler.notify(WakeReason.MANUAL);
        return inChannel(`Continuing \`${parsed.taskId}\` in the same session _(${operator.name})_.`);
      }

      case Action.EXPEDITE: {
        const ttlMs = parseDuration(parsed.text) ?? 30 * 60 * 1000;
        const task = await repos.tasks.get(parsed.taskId);
        if (!task) return ephemeral(`I don't know a task called \`${parsed.taskId}\`.`);
        await repos.tasks.expedite(task.id, { ttlMs, actor: operator.name });
        await scheduler.notify(WakeReason.MANUAL);
        return inChannel(
          `Boosted \`${task.id}\` for ${Math.round(ttlMs / 60000)} minutes _(${operator.name})_. It reverts on its own.`,
        );
      }

      case Action.APPROVE:
      case Action.REJECT: {
        const [approval] = await repos.approvals.pendingForTask(parsed.taskId);
        if (!approval) return ephemeral(`\`${parsed.taskId}\` has nothing waiting for a decision.`);
        return decideApproval(approval.id, parsed.action === Action.APPROVE ? "APPROVE" : "REJECT", operator);
      }

      default:
        return ephemeral(`I understood the words but not the request.\n${HELP}`);
    }
  }

  /**
   * Stop, not cancel.
   *
   * CANCELLED is a dead end in the state machine, which is right for "abandon
   * this" and wrong for "hold on, change the model, try again" — the thing
   * operators actually ask for. So the run is aborted at the gateway and the
   * task parks on BLOCKED, which routes back through RESUMABLE.
   */
  async function stopTask(id, operator) {
    const task = await repos.tasks.get(id);
    if (!task) return ephemeral(`I don't know a task called \`${id}\`.`);
    const execution = await repos.executions.latest(id);
    const live = execution && LIVE.includes(execution.status);
    let aborted = { aborted: false, status: "nothing-running" };

    if (live) {
      // Finalise BEFORE aborting. The gateway answers an abort with its own
      // lifecycle `end` carrying `aborted: true`, and the session sink reads
      // that — correctly — as a cancellation. Racing it would land the task in
      // CANCELLED, a dead end, which is the opposite of what was asked for.
      // The sink skips executions that are already final, so this ordering
      // makes the operator's intent the one that survives.
      await repos.executions.setStatus(execution.id, "CANCELLED", { result: `stopped by ${operator.name}` });
      if (execution.session_ref && controller.runtime?.abortRun) {
        try {
          aborted = await controller.runtime.abortRun({ sessionKey: execution.session_ref });
        } catch (err) {
          aborted = { aborted: false, status: `abort failed: ${err.message}` };
        }
      }
      if (task.workspace_path) {
        await repos.leases.release(task.workspace_path, { executionId: execution.id, actor: operator.name });
      }
    }

    try {
      await repos.tasks.setStatus(id, Status.BLOCKED, { reason: "stopped from Slack", actor: operator.name });
    } catch (err) {
      return ephemeral(`Stopped the run but couldn't park \`${id}\`: ${err.message}`);
    }
    log.info("slack.task-stopped", {
      task: id, exec: execution?.id ?? null, wasLive: Boolean(live),
      abortedAtGateway: aborted.aborted, by: operator.name,
    });
    return inChannel(
      `Stopped \`${id}\` _(${operator.name})_ — ` +
        (live ? (aborted.aborted ? "the run was aborted at the gateway." : "the run had already ended.") : "it wasn't running.") +
        `\nIt's BLOCKED now, so \`model ${id} <model> <effort>\` then \`run ${id}\`.`,
    );
  }

  async function decideApproval(approvalId, decision, operator) {
    let approval;
    try {
      approval = await repos.approvals.decide(approvalId, { decision, decidedBy: operator.name });
    } catch (err) {
      return ephemeral(`Couldn't record that: ${err.message}`);
    }
    // An approval raised mid-turn belongs to a run that is still alive:
    // approving resumes it, and re-admitting the task would dispatch a second
    // one. Only the parked case moves the task's status.
    const live = await repos.executions.latest(approval.task_id);
    const midTurn = live && LIVE.includes(live.status);
    const task = await repos.tasks.get(approval.task_id);
    if (midTurn && task?.status === Status.WAIT_HUMAN) {
      await repos.tasks.setStatus(approval.task_id, decision === "APPROVE" ? Status.RUNNING : Status.BLOCKED, {
        waitDetail: null,
        actor: operator.name,
      });
    }
    await scheduler.notify(WakeReason.APPROVAL_DECIDED);
    log.info("slack.approval", { approval: approvalId, decision, task: approval.task_id, by: operator.name });
    return inChannel(`${decision === "APPROVE" ? "Approved" : "Rejected"} \`${approval.task_id}\` _(${operator.name})_.`);
  }

  /** Block Kit button presses. Same identity rule as commands. */
  async function handleInteraction(payload = {}) {
    const who = await actorFor(payload?.user?.id, payload?.user?.name);
    if (!who.ok) return who.message;
    if (who.readOnly) return ephemeral(`You're registered read-only, ${who.operator.name}.`);

    const action = payload?.actions?.[0];
    if (!action) return ephemeral("There was no action in that interaction.");
    if (action.action_id === "approve") return decideApproval(action.value, "APPROVE", who.operator);
    if (action.action_id === "reject") return decideApproval(action.value, "REJECT", who.operator);
    return ephemeral(`I don't know the action \`${action.action_id}\`.`);
  }

  /**
   * Menjalankan satu perintah task tanpa melalui Slack.
   *
   * Dipakai halaman Control di UI. Ia TIDAK memakai `pendingConfirm`, karena
   * konfirmasi di sana milik satu Slack user dan kedaluwarsa — bentuk yang
   * tidak cocok untuk halaman web yang punya tombol sendiri. Sebagai gantinya
   * verba destruktif harus datang dengan `confirmed: true`, dan pemanggil yang
   * mengirimkannya bertanggung jawab sudah bertanya lebih dulu.
   *
   * Aturan §8.3 tetap berlaku dan justru menjadi eksplisit: perintah destruktif
   * tanpa konfirmasi ditolak beserta gambaran apa yang akan terhenti, bukan
   * dijalankan.
   */
  async function runCommand({ parsed, operator, confirmed = false, projectId = null }) {
    if (DESTRUCTIVE.has(parsed.action) && !confirmed) {
      // Deskripsikan SEMUA target (multi-id), bukan hanya yang pertama —
      // konfirmasi yang hanya menyebut A untuk "cancel A B" adalah cara B
      // mati tanpa pernah dinamakan (§8.7).
      const ids = parsed.taskIds?.length ? parsed.taskIds : [parsed.taskId];
      const targets = [];
      for (const id of ids) {
        const task = await repos.tasks.get(id);
        if (!task) return { ok: false, needsConfirmation: false, text: `Tidak ada task \`${id}\`.` };
        if (![Status.COMPLETE, Status.CANCELLED].includes(task.status)) targets.push(task);
      }
      if (targets.length === 0) {
        return {
          ok: false,
          needsConfirmation: false,
          text: `Semua task tersebut sudah ${Status.COMPLETE} atau ${Status.CANCELLED} — tidak ada yang perlu dihentikan.`,
        };
      }
      const verbWord = parsed.action === Action.CANCEL ? "membatalkan" : "menghentikan";
      return {
        ok: false,
        needsConfirmation: true,
        target: { id: targets[0].id, title: targets[0].title, status: targets[0].status },
        text:
          `Ini akan ${verbWord} ${targets.map((t) => `\`${t.id}\` — *${t.title}* (sekarang ${t.status})`).join(", ")}.` +
          (parsed.action === Action.CANCEL ? "\nCANCELLED adalah jalan buntu — task tidak bisa dijalankan ulang tanpa revisi." : ""),
      };
    }
    const reply = await runAction(parsed, operator, { confirmed: true, projectId });
    return { ok: true, needsConfirmation: false, text: reply.text ?? "", blocks: reply.blocks ?? [] };
  }

  return { handleCommand, handleInteraction, approvalBlocks, queueSummary, actorFor, runCommand };
}
