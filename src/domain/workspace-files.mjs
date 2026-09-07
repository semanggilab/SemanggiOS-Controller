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

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

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

// --- unggahan operator (D76) --------------------------------------------------
//
// Lampiran chat HIDUP di workspace hanya sampai task yang membacanya selesai
// memuatnya. Direktori khusus tmp/uploads — bukan docs/ atau deliverables/ —
// supaya dua kontrak yang sudah ada tidak berubah: listing "@" hanya menunjuk
// dokumen proyek yang permanen, dan agen tidak mengira lampiran itu bagian
// dari workspace yang boleh dirujuk lusa.

/** Batas ukuran per berkas. Cukup untuk PDF/laporan; jauh di bawah apa yang
 *  bisa dipakai untuk mengisi NFS dengan sebuah kotak chat. */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const UPLOAD_DIR = "tmp/uploads";

/**
 * Menulis satu unggahan. Nama disucikan menjadi BASENAME polos: operator
 * tidak pernah punya alasan meletakkan path di nama berkas, dan mengizinkan
 * "/" atau ".." di sana adalah menulis ke mana saja di workspace.
 *
 * @returns {{ok: true, path: string, size: number} | {ok: false, reason: string}}
 */
export async function saveUpload(workspacePath, requestedName, bytes) {
  const name = String(requestedName ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  if (!name || name === "." || name === "..") return { ok: false, reason: "nama berkas kosong atau tidak sah" };
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: "berkas kosong" };
  if (bytes.length > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: `berkas ${Math.round(bytes.length / 1024)}KB melebihi batas ${UPLOAD_MAX_BYTES / 1024 / 1024}MB` };
  }
  const dir = resolve(workspacePath, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  const target = resolve(dir, name);
  await writeFile(target, bytes);
  return { ok: true, path: `${UPLOAD_DIR}/${name}`, size: bytes.length };
}

/**
 * Penyapu kedaluwarsa — pengaman kalau agen lupa menghapus setelah memuat
 * (instruksinya eksplisit, tapi "instruksi" bukan jaminan; deterministik yang
 * sejati adalah jam). Mengembalikan daftar path yang dihapus untuk diaudit.
 */
export async function cleanUploads(workspacePath, ttlMs, now = () => Date.now()) {
  const dir = resolve(workspacePath, UPLOAD_DIR);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    const target = resolve(dir, entry);
    try {
      const info = await stat(target);
      if (!info.isFile()) continue;
      if (now() - info.mtimeMs > ttlMs) {
        await rm(target);
        removed.push(`${UPLOAD_DIR}/${entry}`);
      }
    } catch {
      // Hilang di antara readdir dan stat — sudah tidak ada, selesai.
    }
  }
  return removed;
}
