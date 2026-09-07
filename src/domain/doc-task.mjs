// DOC — satu task yang me-review atau merevisi dokumen yang SUDAH ada.
//
// KENAPA SATU TASK, BUKAN RANTAI
//
// Alasan yang sama dengan PREPARE (D47): membaca sebuah dokumen dan
// menuliskan penilaian atau perbaikannya selesai dalam satu run. Menjalankan
// pipeline penuh untuk itu berarti membayar fase builder yang tidak punya
// sesuatu untuk dibangun, dan menahan hasilnya di belakang dependensi yang
// tidak ada gunanya.
//
// KENAPA ROLE DIPILIH DARI VERBA, BUKAN DARI DAFTAR
//
// Tiga pekerjaan berbeda bisa dilakukan terhadap satu dokumen — menilai
// (reviewer), merancang ulang (architect), menguraikan (analyst) — dan
// operator sudah menyebutkan yang mana lewat kata kerjanya. Meminta ia
// memilih lagi dari dropdown adalah pertanyaan yang jawabannya sudah ada di
// kalimatnya sendiri. Pemilihannya rule-based dan bisa diuji (pickDocRole di
// intent.mjs); yang salah tebak terlihat langsung di balasan, yang menyebut
// role terpilih.
//
// Level: `:level critical` menang atas resolveLevel(template, role, profile).
// Sebuah dokumen yang sedang jadi taruhan pantas dapat Brain terbaik tanpa
// operator harus mengubah Role Map project untuk satu permintaan.

import { resolveLevel, Level } from "./brains.mjs";
import { LEVEL_TO_QUALITY, ROLE_CATEGORY } from "./decompose.mjs";
import { Status } from "./state-machine.mjs";
import { WakeReason } from "../scheduler/scheduler.mjs";
import { resolveWorkspaceFile } from "./workspace-files.mjs";

/** Apa yang dituntut dari tiap role ketika objeknya sebuah dokumen. */
const DOC_RESPONSIBILITY = Object.freeze({
  reviewer:
    "Periksa dokumen yang dirujuk sebagai penilai, bukan sebagai penulisnya. " +
    "Sebutkan temuan beserta lokasinya (judul bagian atau kutipan pendek); " +
    "persetujuan tanpa temuan harus menyebut apa saja yang sudah diperiksa.",
  architect:
    "Rancang ulang bentuk yang dibahas dokumen ini: batas modul, kontrak, model data, " +
    "dan keputusan yang mengikat beserta alasannya. Sebutkan apa yang berubah dari dokumen lama dan kenapa.",
  analyst:
    "Uraikan isi dokumen yang dirujuk: apa yang sudah jelas, apa yang masih terbuka, " +
    "dan kriteria selesai yang bisa diperiksa. Jangan merancang solusi teknis.",
});

/** Ke mana hasilnya ditulis bila operator tidak menyebutkan berkas keluaran. */
const DOC_DELIVERABLE = Object.freeze({
  reviewer: "docs/review.md",
  architect: "docs/architecture.md",
  analyst: "docs/brief.md",
});

/**
 * Instruksi task DOC.
 *
 * Permintaan operator dibawa UTUH — alasan yang sama dengan decompose.mjs:
 * meringkasnya berarti agen membaca versi lain dari permintaan yang sama, dan
 * perbedaannya tidak akan terlihat sampai hasilnya tidak nyambung.
 *
 * Berkas yang dirujuk disebut sebagai PATH, bukan disalin isinya: agen punya
 * akses baca ke workspace, dan menyalin isi dokumen ke dalam instruksi
 * membuat prompt membengkak dan — lebih buruk — membekukan salinan yang bisa
 * sudah basi saat task benar-benar dijalankan.
 */
export function buildDocInstruction({ role, request, refs, deliverable }) {
  const lines = [
    `Tugas: tinjau/revisi dokumen (role: ${role}).`,
    "",
    "Permintaan operator, apa adanya:",
    "",
    String(request ?? "").trim(),
    "",
    DOC_RESPONSIBILITY[role] ?? DOC_RESPONSIBILITY.analyst,
  ];
  if (refs.length > 0) {
    lines.push(
      "",
      `Dokumen yang dirujuk (baca lebih dulu, relatif terhadap workspace): ${refs.join(", ")}.`,
      "Kalau salah satu tidak ada, laporkan berkas mana yang hilang dan berhenti — jangan menebak isinya.",
    );
  } else {
    lines.push(
      "",
      "Tidak ada berkas yang dirujuk eksplisit. Tentukan sendiri dokumen mana di docs/ atau memory/ " +
        "yang dimaksud permintaan di atas, dan SEBUTKAN pilihan itu di awal jawaban sebelum mengerjakannya.",
    );
  }
  if (deliverable) {
    lines.push(
      "",
      `Tulis hasilnya ke \`${deliverable}\` (perbarui bila sudah ada, jangan buang isi yang masih berlaku), ` +
        "dan sebutkan berkas itu di MEMORY.md agar task berikutnya menemukannya.",
    );
  }
  return lines.join("\n");
}

/**
 * Membuat satu task DOC.
 *
 * Menolak lebih awal, bukan membuat task setengah jadi — pola yang sama
 * dengan PREPARE dan dekomposisi: tanpa worker, tanpa Brain, atau dengan
 * rujukan berkas yang menunjuk keluar workspace, task yang terlanjur dibuat
 * hanya akan parkir dan harus dibersihkan tangan.
 */
export async function createDocTask(controller, { projectId, text, refs = [], role = "analyst", level = null, actor = "operator" }) {
  const project = await controller.repos.projects.get(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const template = String(project.template ?? "software").toLowerCase();
  const profile = String(project.profile ?? "balanced").toLowerCase();

  // Rujukan divalidasi dengan resolusi yang sama dengan panel viewer. Sebuah
  // "@../../etc/passwd" ditolak di sini, sebelum ia sempat masuk ke instruksi
  // dan dibaca agen yang memang punya akses tulis ke sandbox-nya.
  const bad = [];
  const clean = [];
  for (const ref of refs) {
    const target = resolveWorkspaceFile(project.workspace_path, ref);
    if (target.ok) clean.push(target.relative);
    else bad.push(`${ref} (${target.reason})`);
  }
  if (bad.length > 0) {
    return { ok: false, reason: `Rujukan berkas ditolak: ${bad.join("; ")}.` };
  }

  const overrideRows = await controller.store.all(
    `SELECT role, level FROM role_levels WHERE template = ? AND profile = ?`,
    [template, profile],
  );
  const overrides = Object.fromEntries(overrideRows.map((r) => [r.role, r.level]));
  const projectOverrides = Object.fromEntries(
    (await controller.repos.projects.roleLevels.list(projectId)).map((r) => [r.role, r.level]),
  );
  const resolved = resolveLevel({ template, role, profile, overrides, projectOverrides });
  // Level eksplisit menang; kosakata sudah divalidasi classifier, tetapi
  // pemeriksaan diulang karena fungsi ini juga dipanggil dari tes dan bisa
  // dipanggil dari permukaan lain nanti.
  const effectiveLevel = level && Object.values(Level).includes(level) ? level : resolved;

  const worker = await controller.repos.workers.match({ projectId, role });
  if (!worker) {
    return {
      ok: false,
      reason:
        `Tidak ada worker aktif ber-role ${role} yang boleh mengerjakan project ini — ` +
        `daftarkan worker ${role} dengan akses ke project tersebut lebih dulu.`,
    };
  }

  const pick = await controller.brainMap.resolve({
    template,
    role,
    level: effectiveLevel,
    brains: controller.brains,
  });
  const brain = pick.candidates[0]?.brain ?? null;
  if (!brain) {
    return { ok: false, reason: `Tidak ada Brain untuk ${role} (${effectiveLevel}) — tetapkan di halaman Brain Map lebih dulu.` };
  }

  const deliverable = DOC_DELIVERABLE[role] ?? null;
  // Judul menyebut berkas pertama yang dirujuk: sebuah kartu kanban bertuliskan
  // "Dokumen: review keamanannya" tidak memberi tahu dokumen yang mana, dan
  // itulah satu-satunya hal yang membedakan task ini dari task DOC berikutnya.
  const subject = clean[0] ? `${clean[0]} — ` : "";
  const task = await controller.repos.tasks.create({
    projectId,
    workerId: worker.id,
    title: `Dokumen (${role}): ${subject}${String(text).slice(0, 80)}`.slice(0, 160),
    description: buildDocInstruction({ role, request: text, refs: clean, deliverable }),
    qualityClass: LEVEL_TO_QUALITY[effectiveLevel] ?? "L3",
    // reviewer MEMBACA; lease baca dibagi (D22), jadi sebuah review tidak
    // perlu mengunci workspace dan menghalangi builder yang sedang menulis.
    workspaceMode: role === "reviewer" ? "read" : "write",
    workspacePath: project.workspace_path,
    modelPolicy: {
      category: ROLE_CATEGORY[role] ?? "analysis",
      class: effectiveLevel,
      preferred: pick.names,
    },
  });
  await controller.repos.tasks.setStatus(task.id, Status.QUEUED, { actor });
  await controller.scheduler.notify(WakeReason.TASK_CREATED);
  controller.log?.info?.("doc.task-created", {
    task: task.id,
    project: projectId,
    role,
    level: effectiveLevel,
    levelExplicit: Boolean(level),
    refs: clean,
    brain: brain.name,
    by: actor,
  });
  return { ok: true, task, role, level: effectiveLevel, brain, refs: clean, deliverable, preferred: pick.names };
}
