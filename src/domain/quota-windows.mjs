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

// D88: leaf module core.mjs (tanpa import) dipakai untuk aritmetika jam
// dinding tetap — aman dari siklus: driver mengimpor modul ini, modul ini
// hanya mengimpor core, bukan driver.
import { ANTHROPIC_WEEKLY_RESET, nextFixedResetMs } from "./quota-drivers/core.mjs";

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

/**
 * D87: jam dari teks penolakan 8.2 yang MEMBAWA jam — hanya saja bukan jam
 * yang bisa dibaca pembaca UTC.
 *
 * Terukur di cluster (event_log 2026-09-08, zai dan salah-rute D85):
 *   "⚠️ Usage limit reached for 5 hour. Your limit will reset at 2026-09-09 03:34:02"
 * Teks itu punya DUA fakta: durasi jendela ("for 5 hour") dan jam dinding
 * reset TANPA zona. Harness mencetak waktu lokal hostnya (UTC+7 pada dua
 * event terukur — delta 4.37j dan 2.11j, keduanya di dalam jendela 5 jam;
 * dibaca sebagai UTC delta-nya 9–11 jam, di luar jendela). D84 menolak
 * menebak dan menjangkarnya 7 hari; D87 menyelesaikan ambiguasinya dengan
 * jendelanya sendiri: offset valid ⇔ 0 < (T − offset) − now ≤ jendela + slack.
 * Jika tidak ada kandidat offset yang lolos, jam dibuang dan pemanggil
 * memakai jangkar D84 (teks itu mungkin bukan milik provider ini — pelajaran
 * salah-rute D85).
 *
 * Bentuk kedua (terukur POC-3 E8, langganan Claude):
 *   "You've hit your session limit · resets 9:40am (UTC)"
 * — jam eksplisit UTC tanpa tanggal; harinya adalah hari ini (atau besok
 * bila sudah lewat). Zona eksplisit tidak butuh disambiguasi.
 *
 * Header terstruktur (anthropic-ratelimit-*-reset RFC 3339, x-ratelimit-reset-*
 * Groq durasi Go, RetryInfo retryDelay Google) TIDAK diurai di sini: gateway
 * 8.2 tidak pernah meneruskannya (terukur — penolakan tiba sebagai teks
 * saja), jadi memparsenya berarti menguji kode yang tidak pernah berjalan.
 * Riset per provider terdokumentasi di decisions.md D87.
 */
const WALL_CLOCK_UNITS_MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

/** Slack untuk geser jam antar host (30 menit — dua event terukur muat 2–4.5j). */
export const CLOCK_SKEW_SLACK_MS = 30 * 60_000;

/** Kandidat offset zona (ms) teks lokal harness, urut kepercayaan. */
const OFFSET_CANDIDATES_MS = [
  0,
  7 * 3_600_000,
  8 * 3_600_000,
  9 * 3_600_000,
  5.5 * 3_600_000,
  3_600_000,
  -5 * 3_600_000,
  -8 * 3_600_000,
];

function hostOffsetMs(nowMs) {
  // getTimezoneOffset: menit yang harus DITAMBAH ke lokal untuk dapat UTC
  // (UTC+7 → -420). Offset teks-lokal = kebalikannya.
  return -new Date(nowMs).getTimezoneOffset() * 60_000;
}

export function parseUsageLimitReset(text, nowMs = Date.now()) {
  const raw = String(text ?? "");
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  // 1) Jam dinding eksplisit UTC (bentuk POC-3) — tidak ambigu.
  const utcClock = raw.match(/resets?\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*\(UTC\)/i);
  if (utcClock) {
    const h12 = Number(utcClock[1]);
    const pm = utcClock[3]?.toLowerCase() === "pm";
    const am = utcClock[3]?.toLowerCase() === "am";
    let hour = h12;
    if (am) hour = h12 % 12; // 12am → 0
    else if (pm) hour = (h12 % 12) + 12; // 12pm → 12
    const minute = Number(utcClock[2]);
    const today = new Date(now);
    let reset = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, minute);
    if (reset <= now) reset += 86_400_000; // jam itu sudah lewat hari ini
    return { resetMs: reset, windowMs: null, windowKind: null, offsetMs: 0 };
  }

  // 2) "Usage limit reached for N unit" + "reset at YYYY-MM-DD HH:MM:SS".
  const windowMatch = raw.match(/usage limit reached for (\d+)\s*(second|minute|hour|day|week)s?\b/i);
  const windowMs = windowMatch
    ? Number(windowMatch[1]) * WALL_CLOCK_UNITS_MS[windowMatch[2].toLowerCase()]
    : null;
  if (!windowMs) return null;

  const wall = raw.match(/reset(?:s|ling)?\s+(?:at|on)\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i);
  if (wall) {
    const asUtc = Date.UTC(
      Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]),
      Number(wall[4]), Number(wall[5]), Number(wall[6]),
    );
    const candidates = [...new Set([0, hostOffsetMs(now), ...OFFSET_CANDIDATES_MS])];
    for (const offset of candidates) {
      const reset = asUtc - offset;
      if (reset > now && reset - now <= windowMs + CLOCK_SKEW_SLACK_MS) {
        return {
          resetMs: reset,
          windowMs,
          windowKind: `${windowMatch[1]}_${windowMatch[2].toLowerCase()}`,
          offsetMs: offset,
        };
      }
    }
  }

  // 3) Jam tidak bisa dipercaya (atau tidak ada): jendelanya tetap fakta.
  //    Pemanggil menjangkarnya now + windowMs — lebih murah hati dari
  //    jendela panjang D84, dan probe pemulihan tetap membatasi kelewatnya.
  return {
    resetMs: null,
    windowMs,
    windowKind: `${windowMatch[1]}_${windowMatch[2].toLowerCase()}`,
    offsetMs: null,
  };
}

/** true bila jendela pendek Brain masuk kelas "retry in place" (< 10 menit). */
export function isRetryableWindow(shortMs) {
  return Number.isFinite(shortMs) && shortMs > 0 && shortMs < RETRYABLE_SHORT_WINDOW_MS;
}

/** Anchor default saat sinyal kuota TIDAK membawa jam (D84).
 *
 * OpenClaw 2026.8.2 mengirim penolakan kuota sebagai teks tanpa resetsAt;
 * baris QUOTA_EXHAUSTED tanpa next_available_at tidak pernah dilepaskan pass
 * jendela scheduler (terukur: glm-5.2 terjebak berjam-jam). Keluarga
 * per-menit memakai jendela pendeknya sendiri; keluarga langganan memakai
 * jendela PANJANG (keputusan yang sama dengan ETA clockless D63 — sinyal
 * tanpa jam tidak menyebut jendela mana yang habis). Probe pemulihan
 * (quota-recovery.mjs) membatasi biaya konservatisme itu ke ± kadensi probe,
 * dan probe yang gagal tidak pernah memperpanjang jangkar hidup. Provider
 * tak dikenal → 30 menit.
 */
export const NULL_CLOCK_FALLBACK_MS = 30 * 60_000;

export function quotaAnchorFallbackMs(provider) {
  const windows = QUOTA_WINDOWS_BY_PROVIDER[String(provider ?? "")];
  if (!windows) return NULL_CLOCK_FALLBACK_MS;
  // Jendela pendek seukuran retry adalah jamnya sendiri (D52: tembok yang
  // hilang dalam hitungan menit ditunggu, bukan diprobe pada horizon harian);
  // keluarga lain — sinyal tanpa jam tidak menyebut jendela MANA yang habis —
  // memakai jendela PANJANG, dengan probe pemulihan membatasi
  // konservatismenya.
  return isRetryableWindow(windows.shortMs) ? windows.shortMs : windows.longMs;
}

/**
 * D88: reset mingguan keluarga dengan jam dinding tetap (langganan Anthropic —
 * Senin 02:00 WIB, terukur operator 2026-09-09). Envelope rolling 7 hari
 * selalu overshoot reset tetap (now+7d vs Senin terdekat ≤ 7d), dan untuk
 * sinyal tanpa jam "Senin berikutnya" adalah batas ATAS yang jujur untuk KEDUA
 * jendela keluarga itu: tembok 5 jam dan mingguan sama-sama jebol paling
 * lambat pada jam itu. Descriptor hidup di core.mjs (satu tabel kebenaran
 * bersama driver + migrasi); pemetaan provider→descriptor di sini supaya
 * jangkar fallback tidak perlu mengimpor registry driver penuh.
 */
export const WEEKLY_FIXED_RESETS = Object.freeze({
  "claude-code": ANTHROPIC_WEEKLY_RESET,
});

/** Epoch reset mingguan tetap BERIKUTNYA untuk provider itu, atau null. */
export function nextWeeklyFixedResetMs(provider, nowMs = Date.now()) {
  const fixed = WEEKLY_FIXED_RESETS[String(provider ?? "")];
  if (!fixed) return null;
  return nextFixedResetMs(fixed, Number(nowMs));
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
