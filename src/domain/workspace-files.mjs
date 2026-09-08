// Berkas workspace yang boleh dilihat dan disunting operator dari Command
// Center — pencarian "@", panel viewer, dan tombol Save-nya.
//
// KENAPA MODUL SENDIRI, BUKAN DI DALAM ROUTE
//
// Yang menentukan aman atau tidaknya fitur ini adalah SATU fungsi: resolusi
// sebuah string dari operator menjadi path absolut. Route HTTP tidak bisa
// diuji tanpa server, tetapi fungsi ini bisa diuji sebagai fungsi biasa —
// dan justru inilah bagian yang wajib punya tes: `../` yang lolos berarti
// seluruh disk container bisa dibaca dan ditulis lewat sebuah kotak chat.
//
// APA YANG BERUBAH DARI WHITELIST LAMA
//
// Endpoint dokumen lama (`/docs/{name}`) memakai whitelist NAMA — tujuh nama
// tetap, tidak ada segmen path dari request yang menyentuh filesystem. Itu
// aman tetapi terlalu sempit untuk pencarian "@": sebuah project punya
// deliverables dan catatan yang namanya tidak bisa didaftar lebih dulu.
//
// Gantinya whitelist DIREKTORI: tiga akar tetap (docs/, memory/,
// deliverables/), path harus tinggal di dalamnya setelah dinormalisasi, dan
// tulis hanya untuk `.md`. Yang dijaga tetap sama — tidak ada permintaan yang
// bisa menunjuk ke luar workspace project.

import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

/** Akar yang boleh dijelajah. Konstanta; tidak pernah datang dari request. */
export const FILE_ROOTS = Object.freeze(["docs", "memory", "deliverables"]);

/** Ekstensi yang boleh DITULIS. Membaca lebih longgar (lihat readWorkspaceFile). */
export const EDITABLE_EXT = ".md";

/** Sejauh mana pencarian menuruni sub-direktori. */
const MAX_DEPTH = 4;
/** Batas jumlah hasil listing — sebuah workspace bisa berisi ribuan berkas. */
const MAX_ENTRIES = 400;

/**
 * Resolusi path relatif dari operator menjadi path absolut di dalam workspace.
 *
 * Menolak, bukan membersihkan diam-diam: sebuah path yang menunjuk ke luar
 * adalah permintaan yang salah, dan "diperbaiki" menjadi path lain berarti
 * operator menyunting berkas yang bukan yang ia tulis. Pemeriksaannya
 * dilakukan pada hasil `resolve()` — perbandingan string sebelum normalisasi
 * bisa dikelabui oleh "docs/../../etc", yang secara tekstual memang diawali
 * "docs/".
 *
 * @returns {{ok: true, absolute: string, relative: string, root: string}
 *          | {ok: false, reason: string}}
 */
export function resolveWorkspaceFile(workspacePath, requested) {
  if (!workspacePath) return { ok: false, reason: "Project belum punya workspace." };
  const raw = String(requested ?? "").trim().replace(/^\.\//, "");
  if (!raw) return { ok: false, reason: "path is required" };
  // NUL memotong string di lapisan syscall: sebuah path yang lolos setiap
  // pemeriksaan JavaScript di atas bisa menunjuk berkas lain di bawahnya.
  if (raw.includes("\0")) return { ok: false, reason: "path tidak valid" };
  if (raw.startsWith("/")) return { ok: false, reason: "path harus relatif terhadap workspace project" };

  const root = raw.split("/")[0];
  // tmp/uploads adalah akar BACA tambahan (D76): lampiran chat bisa dibuka di
  // viewer dan dirujuk /doc, tetapi TIDAK masuk pencarian "@" — listing itu
  // untuk dokumen proyek yang permanen, dan lampiran hidupnya menit.
  const isUpload = raw === UPLOAD_DIR || raw.startsWith(`${UPLOAD_DIR}/`);
  if (!FILE_ROOTS.includes(root) && !isUpload) {
    return { ok: false, reason: `hanya ${FILE_ROOTS.map((d) => `${d}/`).join(", ")} dan ${UPLOAD_DIR}/ yang bisa dibuka` };
  }

  const base = resolve(workspacePath);
  const absolute = resolve(base, raw);
  // `${base}${sep}` — bukan `base` saja: tanpa pemisah, "/ws-lain" lolos
  // sebagai prefix dari "/ws".
  if (!absolute.startsWith(`${base}${sep}`)) {
    return { ok: false, reason: "path keluar dari workspace project" };
  }
  return { ok: true, absolute, relative: raw, root };
}

/** Boleh ditulis? Hanya markdown — lihat catatan kepala berkas. */
export function isEditablePath(relative) {
  return String(relative ?? "").toLowerCase().endsWith(EDITABLE_EXT);
}

/**
 * Daftar berkas di bawah tiga akar, untuk pencarian "@" di composer.
 *
 * Direktori yang tidak ada bukan galat — sebuah project baru belum punya
 * deliverables/, dan melaporkannya sebagai kegagalan akan membuat pencarian
 * mati total padahal docs/ sudah terisi.
 */
export async function listWorkspaceFiles(workspacePath, { extensions = null } = {}) {
  if (!workspacePath) return [];
  const out = [];
  const wanted = extensions ? extensions.map((e) => e.toLowerCase()) : null;

  const walk = async (dirAbsolute, dirRelative, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dirAbsolute, { withFileTypes: true });
    } catch {
      return; // direktori belum ada — keadaan normal, bukan kegagalan
    }
    // Urut nama supaya hasil pencarian stabil antar-panggilan; daftar yang
    // berubah urutan tiap ketikan membuat pilihan keyboard meleset.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_ENTRIES) return;
      if (entry.name.startsWith(".")) continue;
      const relative = `${dirRelative}/${entry.name}`;
      const absolute = `${dirAbsolute}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (wanted && !wanted.some((ext) => lower.endsWith(ext))) continue;
      let size = 0;
      let updatedAt = null;
      try {
        const info = await stat(absolute);
        size = info.size;
        updatedAt = info.mtimeMs;
      } catch {
        // Berkas hilang antara readdir dan stat — dilewati, bukan dilaporkan.
        continue;
      }
      out.push({ path: relative, name: entry.name, dir: dirRelative, size, updatedAt, editable: isEditablePath(relative) });
    }
  };

  for (const root of FILE_ROOTS) {
    await walk(resolve(workspacePath, root), root, 1);
  }
  return out;
}

/**
 * Isi satu berkas.
 *
 * Berkas biner ditolak dengan alasan, bukan dikirim sebagai teks rusak:
 * viewer akan menampilkannya sebagai karakter pengganti dan operator akan
 * mengira berkasnya yang rusak. Deteksinya kasar (byte NUL di 8 KB pertama) —
 * cukup untuk membedakan gambar dari markdown, yang memang satu-satunya
 * perbedaan yang perlu dibuat di sini.
 */
export async function readWorkspaceFile(absolute) {
  const buffer = await readFile(absolute);
  if (buffer.subarray(0, 8192).includes(0)) {
    return { binary: true, content: null, size: buffer.length };
  }
  return { binary: false, content: buffer.toString("utf8"), size: buffer.length };
}

// --- unggahan operator (D76, D77) ---------------------------------------------
//
// Lampiran chat HIDUP di workspace hanya sampai task yang membacanya selesai
// memuatnya. Direktori khusus tmp/uploads — bukan docs/ atau deliverables/ —
// supaya dua kontrak yang sudah ada tidak berubah: listing "@" hanya menunjuk
// dokumen proyek yang permanen, dan agen tidak mengira lampiran itu bagian
// dari workspace yang boleh dirujuk lusa.
//
// D77 — DUA TAHAP: STAGING, LALU ADOPSI PER-TASK
//
// tmp/uploads/ di root workspace hanyalah STAGING: pada saat menempel
// lampiran, task-nya belum ada, jaya path per-task mustahil diketahui lebih
// awal. Begitu sebuah pesan menciptakan task, setiap lampiran yang dirujuk
// deskripsinya DIADOPSI: disalin ke deliverables/<task-id>/tmp/uploads/ dan
// rujukannya ditulis ulang. Alasannya bukan kosmetik — dengan satu berkas
// global, dekomposisi WORK membuat N task yang merujuk berkas yang sama,
// dan agen fase pertama yang patuh menghapus setelah memuat merampas
// lampiran dari fase-fase di belakangnya. Salinan per-task membuat setiap
// agen menghapus miliknya sendiri.

/** Batas ukuran per berkas. Cukup untuk laporan panjang; jauh di bawah apa
 *  yang bisa dipakai untuk mengisi NFS dengan sebuah kotak chat. */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const UPLOAD_DIR = "tmp/uploads";

/** Direktori staging dalam workspace. */
export const uploadStagingDir = () => UPLOAD_DIR;

/** Direktori lampiran milik satu task (D77). */
export const uploadDirForTask = (taskId) => `deliverables/${taskId}/${UPLOAD_DIR}`;

/**
 * Ekstensi unggahan yang diterima — TEKS SAJA (D77). Lampiran adalah bahan
 * yang dibaca agen dan ditampilkan operator di viewer; berkas biner tidak
 * bisa menjadi keduanya, dan menolaknya di sini lebih murah daripada
 * menyimpannya lalu mengecewkan dua kali (agen membaca sampah, viewer
 * menolak render).
 */
export const UPLOAD_TEXT_EXTS = Object.freeze([
  ".md", ".markdown", ".mdx", ".txt", ".text", ".log",
  ".json", ".jsonl", ".ndjson", ".csv", ".tsv",
  ".yml", ".yaml", ".toml", ".ini", ".conf", ".cfg",
  ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".sql", ".graphql", ".svg",
]);

export function isTextUploadName(name) {
  const lower = String(name ?? "").toLowerCase();
  return UPLOAD_TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Rujukan lampiran yang disebut sebuah teks — bentuk staging
 * (`tmp/uploads/<nama>`) maupun bentuk per-task
 * (`deliverables/<task-id>/tmp/uploads/<nama>`). Pola lama hanya mencocokkan
 * yang pertama dan memotong yang kedua menjadi `tmp/uploads/<nama>`: preamble
 * lalu menyuruh agen menghapus path yang tidak pernah ada (D77).
 */
const UPLOAD_REF_RE = /(?:deliverables\/[A-Za-z0-9._\-]+\/)?tmp\/uploads\/[A-Za-z0-9._\-/]+/g;

export function extractUploadRefs(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(UPLOAD_REF_RE)) {
    const ref = m[0].replace(/[.,;:)]+$/, "");
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * Nama berkas dari input operator → basename polos yang AMAN DIJADIKAN TOKEN,
 * atau null bila kosong. Spasi diganti "-" bukan dibuang: rujukan lampiran
 * adalah token `@tmp/uploads/<nama>` di composer, dan pola token (completion,
 * parseDocRefs, extractUploadRefs) semuanya berhenti di spasi — nama berspasi
 * menghasilkan rujukan yang tidak pernah bisa dibaca kembali.
 */
function sanitizeUploadName(requestedName) {
  const name = String(requestedName ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  if (!name || name === "." || name === "..") return null;
  return name;
}

/**
 * Menulis satu unggahan ke staging. Nama disucikan menjadi BASENAME polos:
 * operator tidak pernah punya alasan meletakkan path di nama berkas, dan
 * mengizinkan "/" atau ".." di sana adalah menulis ke mana saja di workspace.
 *
 * Hanya teks (D77): ekstensi dicek daftar, dan isi diendus biner — NUL di
 * 8 KB pertama, heuristik yang sama dengan readWorkspaceFile. Ekstensi bisa
 * berbohong (PNG bernama .txt); isi tidak.
 *
 * @returns {{ok: true, path: string, size: number} | {ok: false, reason: string}}
 */
export async function saveUpload(workspacePath, requestedName, bytes) {
  const name = sanitizeUploadName(requestedName);
  if (!name) return { ok: false, reason: "nama berkas kosong atau tidak sah" };
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: "berkas kosong" };
  if (!isTextUploadName(name)) {
    return { ok: false, reason: `hanya berkas teks yang bisa dilampirkan (${UPLOAD_TEXT_EXTS.join(" ")}) — ${name} ditolak` };
  }
  if (bytes.length > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: `berkas ${Math.round(bytes.length / 1024)}KB melebihi batas ${UPLOAD_MAX_BYTES / 1024 / 1024}MB` };
  }
  if (bytes.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: `${name} terdeteksi biner — lampiran hanya berkas teks` };
  }
  const dir = resolve(workspacePath, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  const target = resolve(dir, name);
  await writeFile(target, bytes);
  return { ok: true, path: `${UPLOAD_DIR}/${name}`, size: bytes.length };
}

/**
 * Menghapus satu lampiran STAGING — tombol "×" pada chip lampiran di composer
 * (D77). Hanya staging: salinan per-task adalah milik task yang mengadopsinya,
 * dihapus agen setelah dimuat atau penyapu TTL, bukan oleh operator dari sini.
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export async function deleteUpload(workspacePath, requested) {
  const raw = String(requested ?? "").trim();
  const name = sanitizeUploadName(raw === UPLOAD_DIR || raw.startsWith(`${UPLOAD_DIR}/`) ? raw.slice(UPLOAD_DIR.length + 1) : raw);
  if (!name) return { ok: false, reason: "nama berkas kosong atau tidak sah" };
  const target = resolve(workspacePath, UPLOAD_DIR, name);
  const base = resolve(workspacePath);
  if (!target.startsWith(`${base}${sep}`)) return { ok: false, reason: "path keluar dari staging lampiran" };
  try {
    await rm(target, { force: false });
  } catch {
    return { ok: false, reason: `lampiran ${UPLOAD_DIR}/${name} tidak ada` };
  }
  return { ok: true, path: `${UPLOAD_DIR}/${name}` };
}

/**
 * Adopsi lampiran oleh satu task (D77): setiap rujukan staging di teks
 * disalin ke deliverables/<task-id>/tmp/uploads/ dan rujukannya ditulis
 * ulang. Rujukan yang sumbernya sudah tidak ada DIBIARKAN apa adanya —
 * task DOC menginstruksikan agen melaporkan berkas yang hilang, bukan
 * menebak isinya, dan menghapus rujukan diam-diam akan menyembunyikan
 * kegagalan itu dari operator.
 *
 * @returns {{text: string, adopted: string[], missing: string[], map: Record<string, string>}}
 */
export async function adoptUploadsForTask(workspacePath, taskId, text) {
  const source = String(text ?? "");
  const out = { text: source, adopted: [], missing: [], map: {} };
  if (!workspacePath || !taskId) return out;
  const base = resolve(workspacePath);
  const stagingRoot = resolve(base, UPLOAD_DIR);
  for (const ref of extractUploadRefs(source)) {
    // Hanya bentuk staging yang diadopsi; rujukan deliverables/…/tmp/uploads
    // sudah milik task lain — menyalinnya lagi berarti task ini ikut
    // menghapus milik tetangganya.
    if (!ref.startsWith(`${UPLOAD_DIR}/`)) continue;
    // Sumber divalidasi SEPERTI destinasi: ref datang dari teks operator
    // (termasuk /prepare dari Slack — identitas non-admin), dan pola ekstraksi
    // mengizinkan ".." — tanpa ini `@tmp/uploads/../../etc/passwd` menyalin
    // berkas host sembarang ke deliverables/ (temuan review D77; GET /file dan
    // DELETE sudah lama menolak jalan keluar, jalur salin ini yang tertinggal).
    // Ref yang mencoba kabur diperlakukan seperti sumber hilang.
    const src = resolve(base, ref);
    if (!src.startsWith(`${stagingRoot}${sep}`)) {
      out.missing.push(ref);
      continue;
    }
    const destRelative = `${uploadDirForTask(taskId)}/${basename(ref.slice(UPLOAD_DIR.length + 1))}`;
    const dest = resolve(base, destRelative);
    if (!dest.startsWith(`${base}${sep}`)) continue; // paranoia: ref datang dari teks operator
    try {
      await mkdir(dirname(dest), { recursive: true });
      // realpath, bukan sekadar cek leksikal: symlink di dalam staging bisa
      // menunjuk keluar, dan copyFile berjalan di host — mengikuti symlink
      // di SINI berarti membaca di luar sandbox tempat agen itu sendiri
      // dikurung.
      const realSrc = await realpath(src);
      const realStaging = await realpath(stagingRoot);
      if (!realSrc.startsWith(`${realStaging}${sep}`)) {
        out.missing.push(ref);
        continue;
      }
      await copyFile(realSrc, dest);
    } catch {
      out.missing.push(ref);
      continue;
    }
    out.adopted.push(destRelative);
    out.map[ref] = destRelative;
    out.text = out.text.split(ref).join(destRelative);
  }
  return out;
}

/**
 * Penyapu kedaluwarsa — pengaman kalau agen lupa menghapus setelah memuat
 * (instruksinya eksplisit, tapi "instruksi" bukan jaminan; deterministik yang
 * sejati adalah jam). Menyapu staging DAN setiap deliverables/<task>/tmp/uploads
 * (D77). Mengembalikan daftar path yang dihapus untuk diaudit.
 */
export async function cleanUploads(workspacePath, ttlMs, now = () => Date.now()) {
  const base = resolve(workspacePath);
  const removed = [];
  const sweepDir = async (dirAbsolute, labelFor) => {
    let entries;
    try {
      entries = await readdir(dirAbsolute);
    } catch {
      return; // direktori belum ada — keadaan normal, bukan kegagalan
    }
    for (const entry of entries) {
      const target = resolve(dirAbsolute, entry);
      try {
        const info = await stat(target);
        if (!info.isFile()) continue;
        if (now() - info.mtimeMs > ttlMs) {
          await rm(target);
          removed.push(labelFor(entry));
        }
      } catch {
        // Hilang di antara readdir dan stat — sudah tidak ada, selesai.
      }
    }
  };
  await sweepDir(resolve(base, UPLOAD_DIR), (entry) => `${UPLOAD_DIR}/${entry}`);
  // Pola tetap deliverables/<task-id>/tmp/uploads — bukan walk bebas: tidak
  // ada yang boleh menghapus deliverable sungguhan, dan pola satu tingkat ini
  // cukup karena adopsi selalu menulis ke bentuk itu.
  let taskDirs;
  try {
    taskDirs = await readdir(resolve(base, "deliverables"));
  } catch {
    taskDirs = [];
  }
  for (const taskDir of taskDirs) {
    await sweepDir(resolve(base, "deliverables", taskDir, UPLOAD_DIR), (entry) => `deliverables/${taskDir}/${UPLOAD_DIR}/${entry}`);
  }
  return removed;
}
