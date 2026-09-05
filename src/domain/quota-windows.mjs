// Jadwal reset kuota provider — dua level per keluarga provider (D51).
//
// KENAPA MILIK BRAIN, BUKAN RESOURCES
//
// Tabel resources merekam keadaan SEKARANG (QUOTA_EXHAUSTED sampai kapan),
// bukan karakter jendela kuotanya — dan sinyal provider tidak selalu datang
// sebelum task pertama menabraknya. Jadwal reset adalah properti model di
// sisi provider: google memakai jendela per-menit + harian, keluarga
// berlangganan (zai/claude-code/groq-qwen) memakai 5 jam + mingguan. Menyimpan
// itu di Brain membuat kebijakan retry bisa memutuskan SEBELUM sinyal pertama
// tiba, dan operator bisa melihatnya di halaman yang sama dengan modelnya.

/** Jendela pendek dan panjang per provider, dalam milidetik. */
export const QUOTA_WINDOWS_BY_PROVIDER = Object.freeze({
  // Gemini: RPM (per menit) + kuota harian.
  google: Object.freeze({ shortMs: 60_000, longMs: 24 * 3_600_000 }),
  // GLM / Claude / QWEN(via groq): jendela 5 jam + mingguan.
  zai: Object.freeze({ shortMs: 5 * 3_600_000, longMs: 7 * 24 * 3_600_000 }),
  "claude-code": Object.freeze({ shortMs: 5 * 3_600_000, longMs: 7 * 24 * 3_600_000 }),
  groq: Object.freeze({ shortMs: 5 * 3_600_000, longMs: 7 * 24 * 3_600_000 }),
});

/**
 * Sebuah jendela pendek sependek ini berarti "coba lagi dalam menit yang
 * sama": menunggu 1× jendela lalu redispatch jauh lebih murah daripada
 * memblokir task dan menunggu operator resume. Jendela 5 jam ke atas bukan
 * kasus itu — menahannya di WAIT_* dengan ETA lebih jujur daripada siklus
 * redispatch.
 */
export const RETRYABLE_SHORT_WINDOW_MS = 60_000;

/** Batas ulang sebelum jendela pendek menyerah dan task diblokir (D51). */
export const QUOTA_RETRY_LIMIT = 10;

/**
 * Detektor pesan kuota lintas sumber.
 *
 * superset dari regex pertama di `applyQuotaSignal` (repositories): teks
 * Gemini memakai kata "quota"/"RESOURCE_EXHAUSTED", bukan hanya "rate limit",
 * dan late-error gateway membawa pesan mentah provider tanpa status HTTP —
 * jadi deteksi berbasis teks harus mengenal kosakata keduanya.
 */
export function isQuotaErrorMessage(text) {
  return /(?:\b429\b|rate.?limit|too many requests|session limit|usage limit|quota|resource_exhausted)/i.test(
    String(text ?? ""),
  );
}

/**
 * Menyelamatkan resetsAt/rateLimitType dari pesan provider yang menyematkan
 * JSON ({"resetsAt":…,"rateLimitType":"five_hour"} — terukur di POC-3 E8 dan
 * gateway-ws). Regex yang sama dipakai dua modul runtime; ia tinggal di sini
 * supaya late-error path bisa memakainya tanpa mengimpor adapter.
 */
export function parseQuotaReset(text) {
  const raw = String(text ?? "");
  const resetsAt = Number(raw.match(/"?resetsAt"?\s*[:=]\s*(\d+)/)?.[1] ?? 0) || null;
  const rateLimitType = raw.match(/"?rateLimitType"?\s*[:=]\s*"?([a-z_]+)"?/i)?.[1] ?? null;
  return { resetsAt, rateLimitType };
}

/** true bila jendela pendek Brain masuk kelas "retry in place". */
export function isRetryableWindow(shortMs) {
  return Number.isFinite(shortMs) && shortMs > 0 && shortMs <= RETRYABLE_SHORT_WINDOW_MS;
}

const WINDOW_LABELS = new Map([
  [60_000, "per-minute"],
  [5 * 60_000, "5-minute"],
  [3_600_000, "hourly"],
  [5 * 3_600_000, "5-hour"],
  [24 * 3_600_000, "daily"],
  [7 * 24 * 3_600_000, "weekly"],
]);

/** Label operator-facing (Inggris, aturan §4.2) untuk durasi jendela. */
export function describeWindow(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return WINDOW_LABELS.get(ms) ?? `${Math.round(ms / 60_000)}m`;
}
