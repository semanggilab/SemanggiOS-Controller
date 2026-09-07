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
  // Review/revisi sebuah dokumen yang SUDAH ada — satu task, role dipilih
  // dari verba permintaannya. Bukan PREPARE (yang menulis rencana dari nol)
  // dan bukan WORK (yang membayar lima fase); memperbaiki satu dokumen
  // selesai dalam satu run, alasan yang sama dengan D47.
  DOC: "DOC",
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
  // Dead-end cancel (CANCELLED), bukan "stop sementara" — itu PAUSE/BLOCKED.
  // Ditambah untuk Command Center: operator yang mendaftarkan 40 task dari
  // docs/tasks.md butuh cara membuang yang salah tanpa menahannya dulu.
  CANCEL: "cancel",
});

const TASK_ID = /\b(TASK-[A-Z0-9]{4,})\b/i;
const TASK_ID_ALL = /\bTASK-[A-Z0-9]{4,}\b/g;

/**
 * Operators refer to tasks by code, not by full id: "#4F59F63A" or bare
 * "4F59F63A". Both are normalized to TASK-4F59F63A before extraction so
 * every downstream handler sees one canonical shape. Deliberately strict —
 * exactly 8 hex digits, the shape shortId("TASK") produces — because a
 * looser pattern would turn ordinary prose (commit hashes, ticket numbers
 * from other systems) into task ids. Bare codes must be UPPERCASE: a
 * lowercase 8-hex word ("deadbeef") is indistinguishable from prose.
 */
export function normalizeTaskIds(text) {
  let s = String(text ?? "");
  s = s.replace(/#([0-9A-Fa-f]{8})\b/g, (_m, code) => `TASK-${code.toUpperCase()}`);
  // Canonicalize any casing of the full prefix first ("task-4f59f63a"), so
  // the bare-code pass below can never double-prefix it.
  s = s.replace(/\btask-([0-9A-Fa-f]{8})\b/gi, (_m, code) => `TASK-${code.toUpperCase()}`);
  s = s.replace(/(?<!TASK-)\b([0-9A-F]{8})\b/g, "TASK-$1");
  return s;
}

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
  // Setelah RUN: "cancel" adalah jalan buntu (CANCELLED), bukan tahan —
  // verba tahan sudah ada di PAUSE. Diulang di sini, bukan dilewatkan ke
  // PAUSE, karena dua kata itu menyelesaikan task ke status yang berbeda.
  { action: Action.CANCEL, re: /^(cancel|batalkan|batal)(\s|$)/i, intent: Intent.TASK },
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
//
// Bentuk utama adalah sintaks slash ala chatbot (`/work`, `/task`,
// `/prepare`); bentuk lama dua-titik TETAP diterima karena router ini dibagi
// dengan Slack dan kebiasaan lama tidak boleh mati diam-diam — yang berubah
// adalah bentuk yang dipasang tombol-tombol template.
const INTENT_PREFIX = /^(?:\/(work|task|prepare|doc)\b|(work|task|prepare|doc)\s*:)\s*:?\s*/i;

// --- level eksplisit ---------------------------------------------------------
//
// ":level critical" di mana pun dalam kalimat menetapkan level task, menimpa
// resolveLevel(template, role, profile). Kosakatanya SAMA dengan Level di
// brains.mjs — bukan sinonim bebas: level yang tidak dikenal akan diam-diam
// memilih Brain yang salah, dan operator tidak akan tahu sampai hasilnya
// mengecewakan. Karena itu polanya menuntut salah satu dari tiga kata itu
// persis; ":level tinggi" tidak cocok dan token itu tinggal sebagai prosa,
// terlihat di judul task — kegagalan yang kelihatan, bukan yang senyap.
const LEVEL_TOKEN = /(^|\s):level\s+(low|normal|critical)\b/i;

/**
 * Mengambil level eksplisit dan MENGHAPUS tokennya dari teks.
 *
 * Token harus hilang: yang tersisa menjadi judul dan deskripsi task, dan
 * ":level critical" di dalam judul kartu kanban adalah sisa sintaks, bukan
 * informasi. @returns {{level: string|null, text: string}}
 */
export function parseLevel(raw) {
  const s = String(raw ?? "");
  const m = LEVEL_TOKEN.exec(s);
  if (!m) return { level: null, text: s };
  return {
    level: m[2].toLowerCase(),
    text: s.replace(LEVEL_TOKEN, "$1").replace(/\s{2,}/g, " ").trim(),
  };
}

// --- rujukan dokumen ---------------------------------------------------------
//
// "@docs/plans.md" menunjuk berkas di workspace project. Polanya menuntut
// sebuah ekstensi (titik + huruf) atau garis miring supaya ia tidak menelan
// mention orang ("@satria") — dua sintaks yang mustahil dibedakan tanpa itu,
// dan router ini dibagi dengan Slack, tempat mention orang adalah hal biasa.
const DOC_REF = /@([A-Za-z0-9._\-/]*[/.][A-Za-z0-9._\-/]+)/g;

/** Semua berkas yang dirujuk "@…", terurut kemunculan, tanpa duplikat. */
export function parseDocRefs(raw) {
  const out = [];
  for (const m of String(raw ?? "").matchAll(DOC_REF)) {
    const ref = m[1].replace(/[.,;:]+$/, "");
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

// Role yang mengerjakan sebuah permintaan /doc, dipilih dari VERBA-nya.
//
// Tiga role, karena tiga jenis pekerjaan berbeda terhadap sebuah dokumen:
// menilai yang sudah ada (reviewer), merancang ulang bentuknya (architect),
// menguraikan isinya (analyst). Urutan penting — "periksa desainnya" adalah
// review, bukan desain, jadi pola reviewer diuji lebih dulu.
const DOC_ROLE_RULES = [
  { role: "reviewer", re: /\b(review|periksa|cek|audit|nilai|koreksi|kritik|telaah)\b/i },
  { role: "architect", re: /\b(rancang|desain|design|arsitektur|architecture|struktur(kan)?|refactor)\b/i },
];
const DOC_ROLE_DEFAULT = "analyst";

/** @returns {"analyst"|"architect"|"reviewer"} */
export function pickDocRole(text) {
  return DOC_ROLE_RULES.find((r) => r.re.test(String(text ?? "")))?.role ?? DOC_ROLE_DEFAULT;
}

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
  // Normalized BEFORE prefix stripping so a declared payload ("TASK: stop
  // #4F59F63A") and a bare command ("status 4F59F63A") both reach the same
  // canonical id — and so the `text` every handler receives already carries
  // the full TASK- form.
  //
  // Dua hal dilucuti dari teks mentah lebih dulu, dan keduanya ikut dalam
  // hasil sebagai field tersendiri — bukan dibiarkan hanyut ke dalam judul
  // task, tempat sisa sintaks akan dibaca agen sebagai instruksi.
  //
  // Rujukan dokumen dibaca dari teks MENTAH karena pembuangan mention di
  // bawah memakan token "@…" pertama, dan "@docs/plans.md" di awal kalimat
  // adalah rujukan berkas, bukan sapaan — mengambilnya lebih dulu membuat
  // urutan kedua aturan itu tidak lagi menentukan.
  const docRefs = parseDocRefs(raw);
  // Mention orang dibuang hanya bila ia memang mention orang: token tanpa
  // "/" dan tanpa titik. Tanpa syarat ini, "@docs/plans.md review" kehilangan
  // berkas yang justru menjadi objek permintaannya. Pola lama dibuat untuk
  // Slack, tempat "@" selalu orang; di Command Center ia juga berkas.
  const withoutMention = String(raw ?? "")
    .trim()
    .replace(/^@([A-Za-z0-9._\-]+)(\s+|$)/, (m, token) => (/[./]/.test(token) ? m : ""));
  const { level, text: cleaned } = parseLevel(withoutMention);
  return { ...classifyText(cleaned), level, docRefs };
}

/** Klasifikasi teks yang sudah dibersihkan dari mention dan token `:level`. */
function classifyText(raw) {
  let text = normalizeTaskIds(String(raw ?? "").trim());
  if (!text) return { intent: Intent.CONFIRM, action: null, taskId: null, confidence: 0, text, reason: "empty message" };

  // Declared intent: strip the prefix and remember it. Everything after the
  // prefix is the payload — it is classified as usual, but a bare payload
  // can no longer fall through to CONFIRM (the declaration is the answer).
  let forced = null;
  const prefix = INTENT_PREFIX.exec(text);
  if (prefix) {
    // Grup 1 = bentuk slash (`/work`), grup 2 = bentuk dua-titik lama (`WORK:`).
    forced = (prefix[1] ?? prefix[2]).toUpperCase();
    text = text.slice(prefix[0].length).trim();
    if (!text) {
      return {
        intent: Intent.CONFIRM,
        action: null,
        taskId: null,
        confidence: 0.4,
        text,
        reason: `empty "/${forced.toLowerCase()}" command — say what should be done`,
      };
    }
  }

  const taskId = TASK_ID.exec(text)?.[1]?.toUpperCase() ?? null;
  // Multi-id ("run TASK-A TASK-B"): setiap id diekstrak, taskId tetap yang
  // pertama agar pemanggil lama (single-id) tidak berubah perilaku. Sumber
  // duplikat ("cancel TASK-A TASK-A") dilipat — satu task dibatalkan dua kali
  // bukan dua task.
  const taskIds = taskId ? [...new Set(text.toUpperCase().match(TASK_ID_ALL) ?? [])] : [];
  const verb = VERBS.find((v) => v.re.test(text));

  // Inside a declared prefix, a CREATE verb ("Buat rencana…") is the payload
  // describing the work — only task-scoped commands outrank the declaration.
  //
  // "/doc" tidak punya perintah task-scoped sama sekali: verbanya JUSTRU yang
  // memilih role ("review …" → reviewer). Membiarkan aturan lama berlaku akan
  // membuat "/doc @plans.md review keamanannya" jatuh ke Action.REVIEW,
  // menuntut task id yang memang tidak ada, dan berakhir CONFIRM — sebuah
  // perintah yang tidak bisa berhasil pada input apa pun (kegagalan yang sama
  // bentuknya dengan D36).
  const verbIsCommand = verb && forced !== "DOC" && !(forced && verb.action === Action.CREATE);

  if (verbIsCommand) {
    // A task-scoped verb without a task id is ambiguous: "approve" which one?
    const needsId = [
      Action.STATUS, Action.PAUSE, Action.EXPEDITE, Action.APPROVE, Action.REJECT,
      Action.CONTINUE, Action.REVIEW, Action.MODEL, Action.RUN, Action.CANCEL,
    ];
    if (needsId.includes(verb.action) && !taskId) {
      return {
        intent: Intent.CONFIRM,
        action: verb.action,
        taskId: null,
        taskIds: [],
        confidence: 0.4,
        text,
        reason: `"${verb.action}" needs a task id`,
      };
    }
    return {
      intent: verb.intent,
      action: verb.action,
      taskId,
      taskIds,
      confidence: forced ? 0.95 : 0.9,
      text,
      hasVerbPrefix: true,
    };
  }

  if (forced) {
    // Declared intent wins over a CREATE verb in the payload: "PREPARE:
    // Buat rencana…" is natural language describing the work, not a command
    // to re-classify — honoring the verb here would flip every Indonesian
    // prepare request ("Buat rencana…") back to WORK and defeat the
    // declaration. Only task-scoped commands (status/stop/…) outrank it.
    return {
      intent:
        forced === "WORK"
          ? Intent.WORK
          : forced === "PREPARE"
            ? Intent.PREPARE
            : forced === "DOC"
              ? Intent.DOC
              : Intent.TASK,
      action: Action.CREATE,
      taskId,
      taskIds,
      // Role hanya bermakna untuk DOC — di sana verbanya memang yang memilih
      // siapa yang mengerjakan; di jalur lain role datang dari pipeline.
      role: forced === "DOC" ? pickDocRole(text) : undefined,
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
