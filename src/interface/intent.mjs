// Minimal intent routing — POC-4 §8.2, P4-12.
//
// Classifies an operator message as CHAT, WORK or TASK and extracts the entities
// a command needs. The binding rule from the spec: a classification the router
// is not confident about becomes a CONFIRMATION, never an action. Acting on a
// guess is how a "status" question turns into a cancelled task.
//
// Deliberately rule-based rather than model-backed. The spec allows an L1 model
// (Groq/Gemini Flash), but rules are deterministic, free, testable, and this
// vocabulary is small. A model can be layered in later behind the same
// interface: it only needs to return the same {intent, confidence} shape.

export const Intent = Object.freeze({
  CHAT: "CHAT",
  WORK: "WORK",
  TASK: "TASK",
  // Persiapan dokumen rencana (docs/plans.md + docs/tasks.md) sebagai SATU
  // task analyst — tanpa rantai dekomposisi. Membuat rencana lewat pipeline
  // penuh (analyst → architect → builder → …) membayar lima fase untuk
  // pekerjaan yang secara alami selesai dalam satu run (D47).
  PREPARE: "PREPARE",
  CONFIRM: "CONFIRM",
});

export const Action = Object.freeze({
  CREATE: "task",
  STATUS: "status",
  PAUSE: "pause",
  EXPEDITE: "expedite",
  APPROVE: "approve",
  REJECT: "reject",
  CONTINUE: "continue",
  REVIEW: "review",
  // Added for the Slack surface, which was given full control: an operator who
  // can stop a task needs to be able to change its model and run it again
  // without leaving the channel for curl.
  MODEL: "model",
  RUN: "run",
  QUEUE: "queue",
});

const TASK_ID = /\b(TASK-[A-Z0-9]{4,})\b/i;

// An explicit verb is a command; everything else has to earn its classification.
// Note `(\s|$)` rather than `\b`: \b matches before a hyphen, so "TASK-ABCD"
// was being read as the verb "task" and queued as new work.
const VERBS = [
  { action: Action.CREATE, re: /^(task|create|buat|kerjakan|bikin)(\s|$)/i, intent: Intent.WORK },
  { action: Action.STATUS, re: /^(status|state|progress|bagaimana|gimana)(\s|$)/i, intent: Intent.TASK },
  { action: Action.PAUSE, re: /^(pause|hold|stop|tahan)(\s|$)/i, intent: Intent.TASK },
  { action: Action.EXPEDITE, re: /^(expedite|urgent|prioritaskan|dahulukan)(\s|$)/i, intent: Intent.TASK },
  { action: Action.APPROVE, re: /^(approve|setuju|izinkan|ok)(\s|$)/i, intent: Intent.TASK },
  { action: Action.REJECT, re: /^(reject|tolak|deny)(\s|$)/i, intent: Intent.TASK },
  { action: Action.CONTINUE, re: /^(continue|lanjut|lanjutkan|resume)(\s|$)/i, intent: Intent.TASK },
  { action: Action.REVIEW, re: /^(review|periksa|cek)(\s|$)/i, intent: Intent.TASK },
  { action: Action.MODEL, re: /^(model|ganti|pakai|gunakan)(\s|$)/i, intent: Intent.TASK },
  { action: Action.RUN, re: /^(run|jalankan|start|mulai)(\s|$)/i, intent: Intent.TASK },
  // Deliberately after the task-scoped verbs: "queue" answers about everything
  // at once and takes no id, so it must not swallow a verb that needs one.
  { action: Action.QUEUE, re: /^(queue|antrian|antrean|daftar)(\s|$)/i, intent: Intent.TASK },
];

/**
 * Pulls a model and an optional effort out of "model TASK-X glm-5.2 high".
 *
 * Effort is matched against the levels the gateway actually accepts rather than
 * any adjective: an unrecognised word is far more likely to be part of a model
 * name than a level, and guessing would silently dispatch at the wrong effort.
 */
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "max", "adaptive"]);

export function parseModelSpec(text) {
  const words = String(text ?? "")
    .split(/\s+/)
    .slice(1) // drop the verb
    .filter((w) => w && !TASK_ID.test(w));
  if (!words.length) return { model: null, effort: null };
  const last = words.at(-1).toLowerCase();
  if (words.length > 1 && EFFORTS.has(last)) {
    return { model: words.slice(0, -1).join(" "), effort: last };
  }
  // A lone effort word ("model TASK-X high") changes only the effort.
  if (words.length === 1 && EFFORTS.has(last)) return { model: null, effort: last };
  return { model: words.join(" "), effort: null };
}

const CHATTY = /^(hi|halo|hello|thanks|terima kasih|makasih|good morning|pagi|siang)\b/i;

// Explicit intent prefixes — spec §8.2 documents them and the Command
// Center's template buttons insert them. An operator who DECLARED the intent
// is not guessing, so a declared intent must never be downgraded to CONFIRM.
// Found live 2026-09-05: "WORK: Baca semua dokumen…" fell through to
// "could not classify" because "work" was never a verb, and "TASK:" died on
// the verb boundary, which demands whitespace — a colon is not whitespace.
const INTENT_PREFIX = /^(work|task|prepare)\s*:\s*/i;

const DURATION = /(\d+)\s*(m|min|mins|minute|minutes|menit|h|hr|hrs|hour|hours|jam)\b/i;

/** Parses "30m" / "2 jam" into milliseconds; used by expedite. */
export function parseDuration(text) {
  const m = DURATION.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const hours = ["h", "hr", "hrs", "hour", "hours", "jam"].includes(unit);
  return n * (hours ? 3600 : 60) * 1000;
}

/**
 * @returns {{intent, action, taskId, confidence, text, reason?}}
 *   intent CONFIRM means: ask the operator what they meant. Never act.
 */
export function classify(raw) {
  let text = String(raw ?? "").trim().replace(/^@\S+\s*/, "");
  if (!text) return { intent: Intent.CONFIRM, action: null, taskId: null, confidence: 0, text, reason: "empty message" };

  // Declared intent: strip the prefix and remember it. Everything after the
  // prefix is the payload — it is classified as usual, but a bare payload
  // can no longer fall through to CONFIRM (the declaration is the answer).
  let forced = null;
  const prefix = INTENT_PREFIX.exec(text);
  if (prefix) {
    forced = prefix[1].toUpperCase();
    text = text.slice(prefix[0].length).trim();
    if (!text) {
      return {
        intent: Intent.CONFIRM,
        action: null,
        taskId: null,
        confidence: 0.4,
        text,
        reason: `empty "${forced}:" command — say what should be done`,
      };
    }
  }

  const taskId = TASK_ID.exec(text)?.[1]?.toUpperCase() ?? null;
  const verb = VERBS.find((v) => v.re.test(text));

  // Inside a declared prefix, a CREATE verb ("Buat rencana…") is the payload
  // describing the work — only task-scoped commands outrank the declaration.
  const verbIsCommand = verb && !(forced && verb.action === Action.CREATE);

  if (verbIsCommand) {
    // A task-scoped verb without a task id is ambiguous: "approve" which one?
    const needsId = [
      Action.STATUS, Action.PAUSE, Action.EXPEDITE, Action.APPROVE, Action.REJECT,
      Action.CONTINUE, Action.REVIEW, Action.MODEL, Action.RUN,
    ];
    if (needsId.includes(verb.action) && !taskId) {
      return {
        intent: Intent.CONFIRM,
        action: verb.action,
        taskId: null,
        confidence: 0.4,
        text,
        reason: `"${verb.action}" needs a task id`,
      };
    }
    return { intent: verb.intent, action: verb.action, taskId, confidence: forced ? 0.95 : 0.9, text, hasVerbPrefix: true };
  }

  if (forced) {
    // Declared intent wins over a CREATE verb in the payload: "PREPARE:
    // Buat rencana…" is natural language describing the work, not a command
    // to re-classify — honoring the verb here would flip every Indonesian
    // prepare request ("Buat rencana…") back to WORK and defeat the
    // declaration. Only task-scoped commands (status/stop/…) outrank it.
    return {
      intent: forced === "WORK" ? Intent.WORK : forced === "PREPARE" ? Intent.PREPARE : Intent.TASK,
      action: Action.CREATE,
      taskId,
      confidence: 1,
      text,
      hasVerbPrefix: false,
    };
  }

  if (CHATTY.test(text) && !taskId) {
    return { intent: Intent.CHAT, action: null, taskId: null, confidence: 0.8, text };
  }

  // A bare task id is most likely a status question, but "most likely" is not
  // good enough to act on.
  if (taskId) {
    return {
      intent: Intent.CONFIRM,
      action: Action.STATUS,
      taskId,
      confidence: 0.5,
      text,
      reason: `did you mean status for ${taskId}?`,
    };
  }

  // Long imperative prose is probably work, but the spec is explicit that a
  // failed classification falls back to confirmation rather than an action.
  return {
    intent: Intent.CONFIRM,
    action: null,
    taskId: null,
    confidence: 0.2,
    text,
    reason: "could not classify; ask the operator",
  };
}
