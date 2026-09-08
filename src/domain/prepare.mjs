// PREPARE — satu task analyst yang menghasilkan dokumen rencana
// (docs/plans.md + docs/tasks.md).
//
// KENAPA BUKAN DEKOMPOSISI
//
// Membuat rencana adalah pekerjaan yang secara alami selesai dalam satu run:
// baca dokumen, tulis rencana. Menjalankannya lewat pipeline penuh
// (analyst → architect → builder → reviewer/tester → learner) membayar lima
// fase — termasuk fase builder yang untuk permintaan "tuliskan rencana"
// tidak punya sesuatu untuk dibangun — dan menunda dokumen rencana di
// belakang dependensi yang tidak diperlukan (D47).
//
// Task yang dihasilkan meniru persis fase analyst dekomposisi: level dari
// (template, profile) milik project dengan snapshot-nya, Brain dari grid
// yang sama, kategori "analysis" — bedanya hanya tidak ada rantai.

import { resolveLevel } from "./brains.mjs";
import { LEVEL_TO_QUALITY, ROLE_CATEGORY } from "./decompose.mjs";
import { Status } from "./state-machine.mjs";
import { WakeReason } from "../scheduler/scheduler.mjs";
import { adoptUploadsForTask } from "./workspace-files.mjs";
import { shortId } from "./repositories.mjs";

export async function createPrepareTask(controller, { projectId, text, actor = "operator" }) {
  const project = await controller.repos.projects.get(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const template = String(project.template ?? "software").toLowerCase();
  const profile = String(project.profile ?? "balanced").toLowerCase();

  // Level analyst yang sama dengan yang akan diberikan dekomposisi: global
  // (template, profile) ditimpa snapshot milik project bila ada.
  const overrideRows = await controller.store.all(
    `SELECT role, level FROM role_levels WHERE template = ? AND profile = ?`,
    [template, profile],
  );
  const overrides = Object.fromEntries(overrideRows.map((r) => [r.role, r.level]));
  const projectOverrides = Object.fromEntries(
    (await controller.repos.projects.roleLevels.list(projectId)).map((r) => [r.role, r.level]),
  );
  const level = resolveLevel({ template, role: "analyst", profile, overrides, projectOverrides });
  // D68: daftar terurut, bukan satu Brain — preferred membawa seluruhnya dan
  // admission yang memilih anggota hidup pertama per percobaan dispatch.
  const pick = await controller.brainMap.resolve({
    template,
    role: "analyst",
    level,
    brains: controller.brains,
  });
  const brain = pick.candidates[0]?.brain ?? null;

  const worker = await controller.repos.workers.match({ projectId, role: "analyst" });
  if (!worker) {
    return {
      ok: false,
      reason:
        "Tidak ada worker aktif ber-role analyst yang boleh mengerjakan project ini — " +
        "daftarkan worker analyst dengan akses ke project tersebut lebih dulu.",
    };
  }
  if (!brain) {
    return {
      ok: false,
      reason: `Tidak ada Brain untuk analyst (${level}) — tetapkan di halaman Brain Map lebih dulu.`,
    };
  }

  // Id dibangkitkan di sini untuk hal yang sama dengan createDocTask: adopsi
  // lampiran (D77) butuh id task SEBELUM baris task ada, agar rujukan
  // tmp/uploads/ di deskripsi diganti salinan per-task yang pathnya sudah
  // final saat task lahir.
  const taskId = shortId("TASK");
  const adoption = await adoptUploadsForTask(project.workspace_path, taskId, String(text));
  const task = await controller.repos.tasks.create({
    id: taskId,
    projectId,
    workerId: worker.id,
    title: `Siapkan rencana & task: ${String(text).slice(0, 100)}`,
    description: adoption.text,
    qualityClass: LEVEL_TO_QUALITY[level] ?? "L3",
    workspaceMode: "write",
    workspacePath: project.workspace_path,
    modelPolicy: {
      category: ROLE_CATEGORY.analyst,
      class: level,
      preferred: pick.names,
    },
  });
  await controller.repos.tasks.setStatus(task.id, Status.QUEUED, { actor });
  await controller.scheduler.notify(WakeReason.TASK_CREATED);
  controller.log?.info?.("prepare.task-created", {
    task: task.id,
    project: projectId,
    level,
    brain: brain.name,
    preferred: pick.names,
    by: actor,
  });
  return { ok: true, task, level, brain, preferred: pick.names };
}
