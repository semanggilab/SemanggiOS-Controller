// Dekomposisi permintaan operator menjadi sekumpulan task berurut.
//
// APA YANG DIKERJAKAN MODUL INI, DAN APA YANG TIDAK
//
// Ia memecah pekerjaan menurut STRUKTUR, bukan menurut isi. Permintaan
// "bangun API pemesanan" menjadi analisis → desain → implementasi → review →
// uji → konsolidasi, karena itulah urutan yang berlaku untuk pekerjaan
// perangkat lunak apa pun. Yang TIDAK ia lakukan adalah membaca permintaan itu
// dan menyimpulkan bahwa pemesanan butuh tiga modul dengan nama tertentu.
//
// Pemisahan ini disengaja. Dekomposisi struktural bersifat deterministik, bisa
// diuji, tidak memakai kuota, dan tidak bisa salah membaca kalimat. Dekomposisi
// semantik membutuhkan model, dan sebuah model yang salah membaca satu kalimat
// menghasilkan lima task salah yang sudah terlanjur memakan worker — jauh lebih
// mahal daripada satu task salah.
//
// Isi permintaan tetap sampai ke agen: ia dibawa utuh ke dalam instruksi setiap
// fase, dan tiap fase membacanya dengan tanggung jawab rolenya sendiri. Yang
// hilang hanyalah pemecahan berbasis pemahaman — dan itu memang belum ada.

import { Level } from "./brains.mjs";

/**
 * Role → kategori routing.
 *
 * Kategori inilah yang dibaca RoutingPolicy (`model_policy.category`), jadi
 * pemetaan ini yang menentukan sebuah fase dirutekan ke tabel `architecture`,
 * `coding`, `analysis`, `documentation` atau `review` di config/routing.json.
 */
export const ROLE_CATEGORY = Object.freeze({
  architect: "architecture",
  analyst: "analysis",
  researcher: "analysis",
  strategist: "analysis",
  browser: "analysis",
  builder: "coding",
  tester: "coding",
  reviewer: "review",
  learner: "documentation",
  writer: "documentation",
  archivist: "documentation",
});

/** Level → kelas kualitas task. Satu-satu; keduanya kosakata untuk hal sama. */
export const LEVEL_TO_QUALITY = Object.freeze({
  [Level.LOW]: "L1",
  [Level.NORMAL]: "L3",
  [Level.CRITICAL]: "L5",
});

/**
 * Tanggung jawab tiap role, dalam satu kalimat yang masuk ke instruksi.
 *
 * Ditulis sebagai perintah, bukan deskripsi jabatan: yang membacanya adalah
 * model yang akan mengerjakannya, bukan manusia yang sedang merekrut.
 */
const RESPONSIBILITY = Object.freeze({
  analyst:
    "Uraikan kebutuhan: siapa penggunanya, proses bisnis apa yang berjalan, dan kriteria selesai yang bisa diperiksa. Jangan merancang solusi teknis.",
  architect:
    "Rancang bentuk teknisnya: batas modul, kontrak antar layanan, model data, dan keputusan yang mengikat beserta alasannya. Jangan menulis kode implementasi.",
  researcher:
    "Kumpulkan dan bandingkan sumber yang relevan, lalu simpulkan apa yang didukung bukti dan apa yang masih terbuka.",
  strategist: "Tetapkan sudut pandang, sasaran, dan urutan penyampaian sebelum ada yang ditulis.",
  builder: "Implementasikan sesuai desain yang sudah ada. Kalau desainnya salah, laporkan — jangan diam-diam menyimpang.",
  tester: "Tulis dan jalankan pengujian yang benar-benar bisa gagal. Uji yang tidak pernah merah tidak menguji apa pun.",
  browser: "Kerjakan bagian yang membutuhkan interaksi peramban, dan catat apa yang terlihat, bukan yang diasumsikan.",
  writer: "Tulis naskahnya sesuai sudut pandang yang sudah ditetapkan.",
  reviewer:
    "Periksa hasil sebelumnya sebagai penilai, bukan sebagai penulisnya. Sebutkan yang salah beserta lokasinya; persetujuan tanpa temuan harus menyebut apa yang sudah diperiksa.",
  learner:
    "Padatkan yang sudah diputuskan ke dalam memory/ dan perbarui penunjuk di MEMORY.md, supaya task berikutnya menemukannya.",
  archivist: "Rapikan dan simpan hasil supaya bisa ditemukan kembali tanpa membaca ulang seluruh transkrip.",
});

/** Keluaran yang diharapkan tiap role, relatif terhadap workspace project. */
const DELIVERABLE = Object.freeze({
  analyst: "docs/brief.md",
  architect: "docs/architecture.md",
  researcher: "docs/findings.md",
  strategist: "docs/angle.md",
  builder: null,
  tester: null,
  browser: null,
  writer: "docs/draft.md",
  reviewer: "docs/review.md",
  learner: "memory/decisions.md",
  archivist: "docs/index.md",
});

const phase = (role, label, { mode = "write", after = [] } = {}) => ({ role, label, mode, after });

/**
 * Urutan fase per template AgentOS.
 *
 * `after` menyebut role yang harus selesai lebih dulu, bukan indeks: sebuah
 * fase yang dihapus tidak boleh menggeser ketergantungan fase lain menjadi
 * salah tanpa ada yang tahu.
 *
 * Fase `read` boleh berjalan paralel dengan `read` lain (D22: lease baca
 * dibagi). Fase `write` mengunci workspace project, jadi ia berurutan dengan
 * sendirinya — itu bukan keputusan modul ini, melainkan konsekuensi lease.
 */
export const PIPELINES = Object.freeze({
  software: [
    phase("analyst", "Analisis kebutuhan", { mode: "read" }),
    phase("architect", "Desain arsitektur", { after: ["analyst"] }),
    phase("builder", "Implementasi", { after: ["architect"] }),
    phase("reviewer", "Review hasil", { mode: "read", after: ["builder"] }),
    phase("tester", "Pengujian", { after: ["builder"] }),
    phase("learner", "Konsolidasi keputusan", { after: ["reviewer", "tester"] }),
  ],
  backend: [
    phase("analyst", "Analisis kebutuhan", { mode: "read" }),
    phase("architect", "Desain arsitektur", { after: ["analyst"] }),
    phase("builder", "Implementasi", { after: ["architect"] }),
    phase("reviewer", "Review hasil", { mode: "read", after: ["builder"] }),
    phase("tester", "Pengujian", { after: ["builder"] }),
    phase("learner", "Konsolidasi keputusan", { after: ["reviewer", "tester"] }),
  ],
  frontend: [
    phase("analyst", "Analisis kebutuhan", { mode: "read" }),
    phase("architect", "Desain arsitektur", { after: ["analyst"] }),
    phase("builder", "Implementasi", { after: ["architect"] }),
    phase("browser", "Verifikasi di peramban", { after: ["builder"] }),
    phase("reviewer", "Review hasil", { mode: "read", after: ["builder"] }),
    phase("learner", "Konsolidasi keputusan", { after: ["reviewer", "browser"] }),
  ],
  research: [
    phase("researcher", "Pengumpulan sumber", { mode: "read" }),
    phase("reviewer", "Uji ulang kesimpulan", { mode: "read", after: ["researcher"] }),
    phase("learner", "Konsolidasi temuan", { after: ["reviewer"] }),
  ],
  content: [
    phase("strategist", "Tetapkan sudut pandang", { mode: "read" }),
    phase("writer", "Penulisan", { after: ["strategist"] }),
    phase("reviewer", "Review naskah", { mode: "read", after: ["writer"] }),
    phase("analyst", "Analisis dampak", { mode: "read", after: ["reviewer"] }),
  ],
});

/** Template yang tidak dikenal tetap menghasilkan sesuatu yang masuk akal. */
export const FALLBACK_TEMPLATE = "software";

export function pipelineFor(template) {
  return PIPELINES[String(template ?? "").toLowerCase()] ?? PIPELINES[FALLBACK_TEMPLATE];
}

/** Judul yang masih terbaca di kartu kanban: ringkas, tapi menyebut fasenya. */
function titleFor(label, request) {
  const summary = String(request ?? "").replace(/\s+/g, " ").trim();
  const short = summary.length > 60 ? `${summary.slice(0, 57)}…` : summary;
  return `${label}: ${short}`;
}

/**
 * Instruksi satu fase.
 *
 * Permintaan asli disertakan UTUH dan ditandai sebagai kutipan. Meringkasnya
 * per fase akan membuat tiap fase membaca versi yang berbeda dari permintaan
 * yang sama — dan perbedaan itu tidak akan terlihat sampai hasilnya tidak
 * nyambung satu sama lain.
 */
function instructionFor({ role, label, request, deliverable, predecessors }) {
  const lines = [
    `Fase: ${label} (role: ${role}).`,
    "",
    "Permintaan operator, apa adanya:",
    "",
    String(request ?? "").trim(),
    "",
    RESPONSIBILITY[role] ?? "Kerjakan bagian ini sesuai tanggung jawab role Anda.",
  ];
  if (predecessors.length > 0) {
    lines.push(
      "",
      `Fase ini melanjutkan: ${predecessors.join(", ")}. Baca keluaran mereka lebih dulu; ` +
        "kalau bertentangan dengan permintaan di atas, laporkan pertentangannya alih-alih memilih sendiri.",
    );
  }
  if (deliverable) {
    lines.push("", `Tulis hasilnya ke \`${deliverable}\`, dan sebutkan berkas itu di MEMORY.md agar fase berikutnya menemukannya.`);
  }
  return lines.join("\n");
}

/**
 * Rencana dekomposisi — murni, tanpa I/O.
 *
 * Level tiap fase datang dari `resolveLevel` milik pemanggil (yang tahu
 * override operator), sehingga modul ini tidak perlu menyentuh basis data dan
 * bisa diuji sebagai fungsi biasa.
 *
 * @param {object} o
 * @param {string} o.request      teks permintaan operator, apa adanya
 * @param {string} o.template     template AgentOS project
 * @param {(role: string) => string} o.levelFor  level efektif per role
 * @returns {Array<{role, label, level, category, qualityClass, workspaceMode, title, description, after}>}
 */
export function buildPlan({ request, template, levelFor }) {
  const text = String(request ?? "").trim();
  if (!text) throw new Error("request is required");

  const pipeline = pipelineFor(template);
  return pipeline.map((p) => {
    const level = levelFor(p.role);
    const deliverable = DELIVERABLE[p.role] ?? null;
    return {
      role: p.role,
      label: p.label,
      level,
      category: ROLE_CATEGORY[p.role] ?? null,
      qualityClass: LEVEL_TO_QUALITY[level] ?? "L3",
      workspaceMode: p.mode,
      deliverable,
      title: titleFor(p.label, text),
      description: instructionFor({
        role: p.role,
        label: p.label,
        request: text,
        deliverable,
        predecessors: p.after,
      }),
      after: p.after,
    };
  });
}
