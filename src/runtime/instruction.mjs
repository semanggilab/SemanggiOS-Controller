// Preamble yang menyertai setiap instruksi dispatch.
//
// Perilaku agen dibagi menurut seberapa sering ia berubah (spec §8.8):
//
//   stabil per (project, role)  →  skills/semanggi-role-<role>/SKILL.md
//   berubah tiap dispatch       →  DI SINI
//
// Yang ditaruh di sini adalah hal-hal yang berbahaya kalau basi: Brain yang
// benar-benar berjalan, kejujuran tentang apakah effort-nya dijamin, direktori
// keluaran task ini, dan apakah task ini memegang lease tulis.
//
// Semuanya diturunkan dari objek yang SAMA dengan yang dipakai membuat
// keputusan routing, jadi ia tidak bisa berbeda dari kenyataan. Itulah alasan
// bagian ini tidak dititipkan ke berkas skill: berkas bisa basi, ini tidak.

/**
 * Kalimat tentang effort, dan kenapa ia perlu ada.
 *
 * Sebuah Brain bernama "gemini-high" adalah janji yang providernya abaikan
 * (D31). Agen yang tidak diberi tahu akan menyusun rencana yang mengandalkan
 * penalaran panjang yang tidak pernah terjadi — lalu menghasilkan pekerjaan
 * yang dangkal tanpa ada yang tahu sebabnya.
 */
function effortLine(brain) {
  if (!brain?.thinking) return null;
  const mode = brain.effortMode ?? "guaranteed";
  if (mode === "guaranteed") return `Reasoning effort: ${brain.thinking} (aktif).`;
  return (
    `Reasoning effort: ${brain.thinking} DIMINTA TETAPI TIDAK AKTIF — provider ini ` +
    `mengabaikannya. Kerjakan seolah berjalan pada effort baku: jangan mengandalkan ` +
    `penalaran panjang yang tidak akan terjadi.`
  );
}

/**
 * Direktori keluaran task.
 *
 * Memakai `deliverables/` dan bukan nama sendiri adalah keputusan sadar: agen
 * SUDAH diinstruksikan ke sana oleh AGENTS.md bawaan OpenClaw. Memilih nama
 * lain berarti setiap instruksi harus menimpa instruksi bawaan, dan satu kali
 * lalai membuat hasil menclok di tempat lain (spec §6.1).
 */
export const deliverablesDirFor = (taskId) => `deliverables/${taskId}`;

/**
 * @param brain     baris Brain yang benar-benar dipilih, bukan yang diminta
 * @param task      untuk id dan mode workspace
 * @param role      role AgentOS yang diwakili worker, bila ada
 */
export function buildPreamble({ task, brain = null, role = null, workspacePath = null } = {}) {
  const lines = [];

  lines.push(`## Konteks eksekusi (Semanggi)`);
  lines.push(`Task: ${task.id}${task.title ? ` — ${task.title}` : ""}`);
  if (role) lines.push(`Peran: ${role}`);

  if (brain) {
    // Menerima baris Brain maupun kandidat routing: yang pertama menyebut
    // dirinya `name`, yang kedua `logical`. Menormalkan di sini, bukan di
    // pemanggil, supaya tidak ada jalur yang lupa melakukannya.
    const name = brain.name ?? brain.logical ?? `${brain.provider}/${brain.model}`;
    lines.push(`Brain: ${name} (${brain.provider}/${brain.model})`);
    const effort = effortLine(brain);
    if (effort) lines.push(effort);
  }

  lines.push(`Tulis hasil ke: ${deliverablesDirFor(task.id)}/`);

  // Mode lease menentukan apakah repo boleh disentuh. Ini satu-satunya tempat
  // agen bisa mengetahuinya — lease adalah pembukuan controller, tidak terlihat
  // dari dalam workspace.
  if (task.workspace_mode === "read") {
    lines.push(
      `Mode workspace: READ. Task lain mungkin sedang membaca workspace ini. ` +
        `Jangan mengubah berkas di luar direktori hasil di atas.`,
    );
  } else {
    lines.push(
      `Mode workspace: WRITE. Kamu memegang lease eksklusif atas workspace ini, ` +
        `jadi perubahan pada kode di root diperbolehkan bila task memang memintanya.`,
    );
  }

  if (workspacePath) lines.push(`Workspace: ${workspacePath}`);

  return lines.join("\n");
}

/**
 * Menggabungkan preamble dengan instruksi task.
 *
 * Preamble di depan, dipisah garis, supaya batas antara "konteks yang diberikan
 * sistem" dan "yang diminta operator" terlihat jelas oleh model — dan supaya
 * prefiks itu stabil antar-dispatch sehingga ikut ter-cache.
 */
export function withPreamble(instruction, context) {
  const preamble = buildPreamble(context);
  const body = String(instruction ?? "").trim();
  return `${preamble}\n\n---\n\n${body}`;
}
