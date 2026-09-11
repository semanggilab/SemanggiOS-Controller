// POC-10 T4 — injeksi konteks project/task untuk chat (spec §7.1).
//
// Empat jenis pertanyaan operator butuh sumber konteks berbeda, dan cara
// termurah untuk POC adalah injeksi di controller: Brain tidak pernah
// memanggil RPC gateway atau API AgentOS sendiri — menghindari membangun
// tool-calling loop sama sekali. Pola dengan task dispatch: pola withPreamble
// (blok konteks SEBELUM prompt operator, pemisah ---), bukan mekanisme baru.
//
// BLOK TIDAK PERNAH TERSIMPAN ke chat_messages (spec §12.7): transkrip tetap
// bersih mencatat apa yang operator ketik; blok adalah preamble pengiriman,
// bukan riwayat.

import { normalizeTaskIds } from "../interface/intent.mjs";

// Tepat 8 heksadesimal dengan prefiks — bentuk yang normalizeTaskIds
// pastikan. Tidak menerima bentuk pendek: teks biasa tidak boleh salah dibaca
// sebagai rujukan task (pelajaran pola TASK_ID di intent.mjs).
const TASK_REF = /\bTASK-([0-9A-F]{8})\b/g;

// Rujukan eksplisit dibatasi tiga per pesan: blok konteks yang lebih panjang
// dari pertanyaannya sendiri adalah jawaban yang menenggelamkan pertanyaan.
const MAX_TASK_REFS = 3;

// Kata kunci project: memicu ringkasan project TANPA task spesifik ("gimana
// project ini?", "statusnya?"). Daftar, bukan regex bebas — "task" dan
// "project" kata umum; mencocokkan frasa pendek yang benar-benar dipakai
// operator menanyakan keadaan, bukan setiap kemunculan kata.
const PROJECT_HINTS = [
  /project ini\b/i,
  /proyek ini\b/i,
  /\bstatus\s*(project|proyek|semua|keseluruhan)?\b/i,
  /\bberapa task\b/i,
  /\bsemua task\b/i,
];

function parseModelPolicy(task) {
  if (!task?.model_policy) return {};
  if (typeof task.model_policy === "object") return task.model_policy;
  try {
    return JSON.parse(task.model_policy);
  } catch {
    return {};
  }
}

function describeTaskBlock(task, events) {
  const policy = parseModelPolicy(task);
  const lines = [
    `Task ${task.id}: ${task.title}`,
    `- status: ${task.status}${task.wait_reason ? ` (${task.wait_reason})` : ""}`,
    `- role: ${policy.role ?? "-"} | level: ${policy.level ?? "-"} | priority: P${task.priority}`,
  ];
  if (Array.isArray(events) && events.length > 0) {
    // Tiga event terakhir, pola live-status D74 — "apa yang barusan terjadi"
    // menjawab lebih banyak daripada tabel status yang bisa basi semenit.
    const last = events.slice(-3).map((e) => `${e.kind}${e.actor ? ` by ${e.actor}` : ""}`);
    lines.push(`- last events: ${last.join("; ")}`);
  }
  return lines.join("\n");
}

function describeProjectBlock(project, tasks) {
  const counts = new Map();
  let latest = null;
  for (const t of tasks) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    if (!latest || t.created_at > latest.created_at) latest = t;
  }
  const summary = [...counts.entries()].map(([s, n]) => `${s}=${n}`).join(", ") || "no tasks";
  const lines = [`Project ${project.name} (${project.template}/${project.profile ?? "balanced"}): ${summary} tasks`];
  if (latest) lines.push(`- latest created: ${latest.id} ${latest.title} (${latest.status})`);
  return lines.join("\n");
}

/**
 * Rakit blok konteks untuk satu pesan chat.
 *
 * @returns {{ block: string | null, taskIds: string[], projectHint: boolean }}
 *   block null berarti pesan riset/umum — tidak ada injeksi (§7.1: "sama
 *   seperti riset — tidak ada injeksi"), bukan kegagalan.
 */
export async function buildChatContext({ repos, events, text, project }) {
  const raw = String(text ?? "");

  const ids = [];
  for (const m of raw.matchAll(TASK_REF)) {
    const id = `TASK-${m[1]}`;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_TASK_REFS) break;
  }

  const projectHint = PROJECT_HINTS.some((re) => re.test(raw));

  if (ids.length === 0 && !projectHint) return { block: null, taskIds: [], projectHint: false };

  const parts = [];
  for (const id of ids) {
    const task = await repos.tasks.get(id);
    if (!task) {
      // Rujukan ke task yang tidak ada tetap dilaporkan ke Brain — jawaban
      // "tidak ada task itu" lebih murah daripada Brain menebak dari nama id.
      parts.push(`Task ${id}: not found in this controller`);
      continue;
    }
    const recent = events?.list ? await events.list({ subjectType: "task", subjectId: id, limit: 3 }) : [];
    parts.push(describeTaskBlock(task, recent));
  }
  if (projectHint) {
    const tasks = await repos.tasks.list({ projectId: project.id });
    parts.push(describeProjectBlock(project, tasks));
  }
  if (parts.length === 0) return { block: null, taskIds: ids, projectHint };

  const header = "Context injected by Semanggi (read-only, as of this message):";
  return { block: `${header}\n${parts.join("\n\n")}`, taskIds: ids, projectHint };
}
