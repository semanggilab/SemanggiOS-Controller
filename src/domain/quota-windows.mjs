// Jadwal reset kuota provider — dua level per keluarga provider (D51).
//
// KENAPA MILIK BRAIN, BUKAN RESOURCES
//
// Tabel resources merekam keadaan SEKARANG (QUOTA_EXHAUSTED sampai kapan),
// bukan karakter jendela kuotanya — dan sinyal provider tidak selalu datang
// sebelum task pertama menabraknya. Jadwal reset adalah properti model di
// sisi provider: google/groq/cerebras memakai jendela per-menit + harian,
// keluarga berlangganan (zai/claude-code) memakai 5 jam + mingguan. Menyimpan
// itu di Brain membuat kebijakan retry bisa memutuskan SEBELUM sinyal pertama
// tiba, dan operator bisa melihatnya di halaman yang sama dengan modelnya.

/** Jendela pendek dan panjang per provider, dalam milidetik. */
export const QUOTA_WINDOWS_BY_PROVIDER = Object.freeze({
  // Gemini / Groq / Cerebras: RPM (per menit) + kuota harian (D59 — groq dan
  // cerebras dulu salah keluarga, ikut paket 5 jam + mingguan langganan).
  google: Object.freeze({ shortMs: 60_000, longMs: 24 * 3_600_000 }),
  groq: Object.freeze({ shortMs: 60_000, longMs: 24 * 3_600_000 }),
  cerebras: Object.freeze({ shortMs: 60_000, longMs: 24 * 3_600_000 }),
  // GLM / Claude: jendela 5 jam + mingguan.
  zai: Object.freeze({ shortMs: 5 * 3_600_000, longMs: 7 * 24 * 3_600_000 }),
  "claude-code": Object.freeze({ shortMs: 5 * 3_600_000, longMs: 7 * 24 * 3_600_000 }),
});

/**
 * Ambang "retry in place": model dengan jendela reset terpendek di bawah
 * sepuluh menit (D52; D51 memakai 60 dtk dan itu kebetulan hanya menangkap
 * Gemini). Aturannya dinamis terhadap jendela, bukan terhadap provider —
 * model mana pun yang resetnya cepat layak dicoba ulang satu jendela;
 * memblokirnya berarti membunuh task untuk tembok yang hilang dalam hitungan
 * menit. Jendela 5 jam ke atas bukan kasus itu — menunggu dengan backoff
 * (lewat jalur WAIT_RESOURCE) lebih jujur daripada siklus redispatch.
 */
export const RETRYABLE_SHORT_WINDOW_MS = 10 * 60_000;

/** Batas ulang sebelum jendela pendek menyerah dan task diblokir (D51). */
export const QUOTA_RETRY_LIMIT = 10;

/**
 * Batas ulang terpisah untuk penolakan TRANSIENT di jalur late-error —
 * rate limit pada jendela panjang dan UNAVAILABLE/overloaded (D52). Lebih
 * kecil dari QUOTA_RETRY_LIMIT karena setiap percobaan berbackoff 30 dtk →
 * 15 menit: lima percobaan ≈ seperempat jam menunggu sebelum menyerah.
 */
export const RESOURCE_RETRY_LIMIT = 5;
export const RESOURCE_RETRY_BASE_MS = 30_000;
export const RESOURCE_RETRY_MAX_MS = 15 * 60_000;

/** Backoff eksponensial untuk percobaan transient ke-n (0-based). */
export function resourceRetryBackoffMs(retries) {
  return Math.min(RESOURCE_RETRY_BASE_MS * 2 ** Math.max(0, retries), RESOURCE_RETRY_MAX_MS);
}

/**
 * Detektor penolakan transient — runtime/gateway sedang tidak sanggup, bukan
 * task yang salah: UNAVAILABLE, overloaded, "try again later", 5xx (D52).
 * Rate limit TIDAK di sini: ia sudah tertangkap isQuotaErrorMessage dan
 * membawa jadwal reset sendiri; tempatnya di klasifikasi kuota.
 */
export function isTransientRuntimeError(text) {
  return /(?:\bUNAVAILABLE\b|unavailable|overloaded|temporarily|try again later|\b50[234]\b)/i.test(
    String(text ?? ""),
  );
}

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

/** true bila jendela pendek Brain masuk kelas "retry in place" (< 10 menit). */
export function isRetryableWindow(shortMs) {
  return Number.isFinite(shortMs) && shortMs > 0 && shortMs < RETRYABLE_SHORT_WINDOW_MS;
}

const WINDOW_LABELS = new Map([
  [60_000, "per-minute"],
  [5 * 60_000, "5-minute"],
  [10 * 60_000, "10-minute"],
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
