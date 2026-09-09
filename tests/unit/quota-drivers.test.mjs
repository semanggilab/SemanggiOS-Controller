// POC-6 (D63): quota drivers. Two durations alone cannot price a retry —
// "24h rolling" and "daily at midnight Pacific" are different answers to
// "when can this model serve again", and a groq 413 is not a window at all.
// These tests pin the contract the scheduler now leans on: registry lookup,
// per-provider defaults (including google's per-model free rates), the ETA
// rule (signal > prediction, fixed-time DST-aware, token-bucket pace cap),
// and fatal classification (groq structural 413, 402/401 billing/auth).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../src/db/index.mjs";
import {
  quotaDriverFor,
  quotaDriverIdFor,
  quotaDriverCatalog,
  googleDriver,
  groqDriver,
  cerebrasDriver,
  zaiDriver,
  claudeCodeDriver,
  mistralDriver,
} from "../../src/domain/quota-drivers/index.mjs";
import { nextFixedResetMs } from "../../src/domain/quota-drivers/core.mjs";

const MINUTE = 60_000;
const DAY = 24 * 3_600_000;

// --- registry ---------------------------------------------------------------

test("quotaDriverFor returns the provider driver and falls back to generic", () => {
  assert.equal(quotaDriverFor("google"), googleDriver);
  assert.equal(quotaDriverFor("GROQ"), groqDriver, "provider lookup is case-insensitive");
  assert.equal(quotaDriverFor("claude-code"), claudeCodeDriver);
  const unknown = quotaDriverFor("provider-yang-belum-ada");
  assert.equal(unknown.id, "generic");
  // The fallback must still classify the D52 vocabulary: an unregistered
  // provider is not a licence to lose quota parking.
  assert.equal(unknown.classifyError({ text: "rate limit exceeded" }).kind, "quota");
  assert.equal(unknown.classifyError({ status: 402, text: "anything" }).kind, "fatal");
});

// --- D64: resolution by alias, not name equality -------------------------------

test("a gateway label that is not the driver id still finds its driver (D64)", () => {
  // The live counterexample: the mistral pool is registered in AgentOS as
  // "mistral-custom" — name equality would hand a real provider to the
  // generic driver (null windows, no monthly-budget parking).
  assert.equal(quotaDriverFor("mistral-custom"), mistralDriver);
  assert.equal(quotaDriverFor("Mistral-Custom"), mistralDriver, "aliases are case-insensitive too");
  assert.equal(quotaDriverIdFor("mistral-custom"), "mistral");
  assert.equal(quotaDriverIdFor("label-tak-dikenal"), "generic");

  // The catalog is what the operator sees: every label a driver answers to.
  const mistral = quotaDriverCatalog().find((d) => d.id === "mistral");
  assert.deepEqual(mistral.providerKeys, ["mistral", "mistral-custom"]);
  assert.equal(mistral.tier, "free");
  assert.ok(quotaDriverCatalog().length >= 6);
});

// --- defaults ---------------------------------------------------------------

test("google defaults carry per-model free rates and a Pacific fixed reset", () => {
  const base = googleDriver.defaults({ model: "gemini-3.7-flash-preview" });
  assert.equal(base.quotaTier, "free");
  assert.equal(base.shortType, "rolling");
  assert.equal(base.longType, "fixed-time");
  assert.deepEqual(base.fixedReset, { atHourLocal: 0, timeZone: "America/Los_Angeles" });

  const rates = (model) => googleDriver.defaults({ model }).rates;
  assert.deepEqual(rates("gemini-2.5-flash-lite"), { rpm: 10, rpd: 20, tpm: 250_000, tpd: null });
  assert.deepEqual(rates("gemini-3.1-flash-lite"), { rpm: 15, rpd: 500, tpm: 250_000, tpd: null });
  assert.deepEqual(rates("gemini-3.5-flash-lite-latest"), { rpm: 15, rpd: 500, tpm: 250_000, tpd: null });
  assert.deepEqual(rates("gemini-3.7-flash"), { rpm: 5, rpd: 20, tpm: 250_000, tpd: null });
  // "3.7-flash-lite" must NOT borrow the flash (non-lite) rates.
  assert.deepEqual(rates("gemini-3.7-flash-lite"), { rpm: null, rpd: null, tpm: null, tpd: null });
  // A sibling we have not read numbers for stays null, not guessed.
  assert.deepEqual(rates("gemini-9-flash"), { rpm: null, rpd: null, tpm: null, tpd: null });
});

test("groq defaults record the MEASURED 7K input wall, not the advertised 8K", () => {
  const d = groqDriver.defaults();
  assert.equal(d.quotaTier, "free");
  assert.equal(d.shortType, "rolling");
  assert.equal(d.longType, "rolling");
  assert.equal(d.rates.tpm, 7_000, "D62: the 413 body names 7000 as the effective limit");
  assert.equal(d.rates.rpd, 1_000);
});

test("cerebras defaults pace a token bucket; zai prices credits on an anniversary", () => {
  assert.equal(cerebrasDriver.defaults().shortType, "token-bucket");
  assert.equal(cerebrasDriver.defaults().quotaTier, "free-trial");

  const z = zaiDriver.defaults();
  assert.equal(z.quotaTier, "lite");
  assert.equal(z.shortMs, 5 * 3_600_000);
  assert.equal(z.longType, "credits-anniversary");
  assert.equal(z.longMs, 7 * DAY);

  assert.equal(claudeCodeDriver.defaults().quotaTier, "pro");
  // D88: jangkar mingguan diukur operator (2026-09-09) — Senin 02:00 WIB.
  // Tes lama mematri fixedReset null ("belum diukur") — pengukuran datang,
  // klaimnya diganti, bukan dilangkahi diam-diam.
  assert.deepEqual(
    claudeCodeDriver.defaults().fixedReset,
    { atHourLocal: 2, timeZone: "Asia/Jakarta", day: 1 },
  );

  assert.equal(mistralDriver.defaults().quotaTier, "free");
  // Null-valued, not null itself: brains.create() reads rates.rpm etc. off
  // every driver's defaults, and "verify in the Admin Panel" must not crash
  // the create path.
  assert.deepEqual(
    mistralDriver.defaults().rates,
    { rpm: null, rpd: null, tpm: null, tpd: null },
  );
});

// --- nextReset (the ETA rule) ------------------------------------------------

test("rolling windows anchor on the signal time, not the ask time", () => {
  const now = Date.UTC(2026, 8, 6, 7, 0, 0);
  const hit = now - 20_000;
  const eta = groqDriver.nextReset({ kind: "rolling", ms: MINUTE }, { nowMs: now, lastSignalAt: hit });
  assert.equal(eta, hit + MINUTE);
});

test("a provider resetsAt in epoch SECONDS wins and is normalised to millis", () => {
  // POC-3 E8: the zai signal carries epoch seconds; compared raw against a
  // 1.7e12 now() it always looked "in the past" and the ETA silently fell
  // back to a guess.
  const now = 1_799_000_000_000;
  const seconds = Math.floor(now / 1000) + 3_600;
  const eta = zaiDriver.nextReset({ kind: "credits", ms: 5 * 3_600_000 }, { nowMs: now, resetsAt: seconds });
  assert.equal(eta, seconds * 1000);
});

test("token buckets pace one short window max — a full TPD wait on an RPM hiccup is a day lost", () => {
  const now = Date.UTC(2026, 8, 6, 7, 0, 0);
  const eta = cerebrasDriver.nextReset({ kind: "token-bucket", ms: DAY }, { nowMs: now });
  assert.equal(eta, now + 60_000);
});

test("google's daily reset is the next midnight Pacific, DST-aware both directions", () => {
  const fr = { atHourLocal: 0, timeZone: "America/Los_Angeles" };
  // Fall-back: 2026-11-01, PDT (-7) becomes PST (-8). At 08:00Z the local
  // wall already says 01:00 (post-transition); the next local midnight is
  // 2026-11-02T08:00Z. A zone-oblivious "+24h" or a fixed -7h offset gets
  // this wrong by an hour.
  const fallBack = googleDriver.nextReset(
    { kind: "fixed-time", ms: DAY, fixedReset: fr },
    { nowMs: Date.UTC(2026, 10, 1, 8, 0, 0) },
  );
  assert.equal(fallBack, Date.UTC(2026, 10, 2, 8, 0, 0));

  // Spring-forward: 2026-03-08, PST becomes PDT. The next local midnight
  // after 2026-03-08T09:30Z is 2026-03-09T07:00Z (-7, not -8).
  const springForward = googleDriver.nextReset(
    { kind: "fixed-time", ms: DAY, fixedReset: fr },
    { nowMs: Date.UTC(2026, 2, 8, 9, 30, 0) },
  );
  assert.equal(springForward, Date.UTC(2026, 2, 9, 7, 0, 0));

  // Same-instant sanity: local midnight just passed → tomorrow's, not zero
  // seconds from now.
  const justPast = googleDriver.nextReset(
    { kind: "fixed-time", ms: DAY, fixedReset: fr },
    { nowMs: Date.UTC(2026, 8, 6, 7, 0, 1) }, // 00:00:01 Pacific
  );
  assert.equal(justPast, Date.UTC(2026, 8, 7, 7, 0, 0));
});

test("weekly fixed resets walk to the wanted weekday without a calendar library", () => {
  // 2026-09-06 is a Sunday; asking for Monday (day 1) at 00:00 UTC must land
  // on 2026-09-07, not roll 7 days.
  const eta = nextFixedResetMs({ atHourLocal: 0, timeZone: "UTC", day: 1 }, Date.UTC(2026, 8, 6, 12, 0, 0));
  assert.equal(eta, Date.UTC(2026, 8, 7, 0, 0, 0));
});

test("credits-anniversary uses the cycle anchor when known, rolling ms when not", () => {
  const now = Date.UTC(2026, 8, 6, 7, 0, 0);
  const anchor = Date.UTC(2026, 7, 30, 0, 0, 0);
  // Anchor + 7d has passed; the next multiple is anchor + 14d.
  const eta = zaiDriver.nextReset(
    { kind: "credits-anniversary", ms: 7 * DAY },
    { nowMs: now, cycleAnchor: anchor },
  );
  assert.equal(eta, anchor + 14 * DAY);
  // Without an anchor the conservative fallback is the full window from now.
  const blind = zaiDriver.nextReset({ kind: "credits-anniversary", ms: 7 * DAY }, { nowMs: now });
  assert.equal(blind, now + 7 * DAY);
});

test("an unknown window prices to null, never a guess", () => {
  assert.equal(groqDriver.nextReset({ kind: null, ms: null }, { nowMs: Date.now() }), null);
  assert.equal(groqDriver.nextReset(null, { nowMs: Date.now() }), null);
});

// --- classifyError -----------------------------------------------------------

test("groq's 413 structural wall is fatal — no window climbs it", () => {
  const verdict = groqDriver.classifyError({ text: "Request Entity Too Large: Limit 7000, Requested 20011" });
  assert.equal(verdict.kind, "fatal");
  assert.equal(verdict.structural, true);
  assert.match(verdict.reason, /input-token window/);
});

test("a driver may add fatal patterns but never narrows the quota vocabulary", () => {
  // groq still recognises the generic phrasings it always did.
  assert.equal(groqDriver.classifyError({ text: "rate limit exceeded, retry later" }).kind, "quota");
  assert.equal(groqDriver.classifyError({ text: "model overloaded, try again later" }).kind, "transient");
  // google's exhaustion wording says neither "429" nor "rate limit".
  const g = googleDriver.classifyError({ text: "Resource has been exhausted (RESOURCE_EXHAUSTED)" });
  assert.equal(g.kind, "quota");
});

test("402 and 401 are fatal on status alone — billing and auth do not reset", () => {
  const cerebras = cerebrasDriver.classifyError({ status: 402, text: "{\"error\":\"payment_required\"}" });
  assert.equal(cerebras.kind, "fatal");
  assert.match(cerebras.reason, /payment required/);

  const anyProvider = quotaDriverFor("totally-unknown").classifyError({ status: 401, text: "unauthorized" });
  assert.equal(anyProvider.kind, "fatal");

  // Text-only 402 wording classifies the same way (late errors carry no status).
  assert.equal(groqDriver.classifyError({ text: "HTTP 402 payment_required: add credits" }).kind, "fatal");
});

test("quota verdicts carry the parsed provider clock and window kind", () => {
  const raw = JSON.stringify({ error: "usage limit hit", resetsAt: 1_799_003_600, rateLimitType: "five_hour" });
  const v = zaiDriver.classifyError({ text: raw });
  assert.equal(v.kind, "quota");
  assert.equal(v.resetsAt, 1_799_003_600);
  assert.equal(v.rateLimitType, "five_hour");
});

// --- D63 migration -----------------------------------------------------------

test("a pre-D63 brains database gains the quota columns and backfills from drivers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semanggi-quota-mig-"));
  const file = join(dir, "controller.db");
  try {
    const db = new DatabaseSync(file);
    // The pre-D63 shape: D51's two duration columns and nothing more.
    db.exec(`
      CREATE TABLE brains (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT,
        effort_mode TEXT NOT NULL DEFAULT 'guaranteed',
        effort_evidence TEXT,
        mode TEXT NOT NULL DEFAULT 'interactive',
        acp_agent TEXT,
        quota_reset_short_ms INTEGER,
        quota_reset_long_ms INTEGER,
        level TEXT NOT NULL DEFAULT 'NORMAL',
        category TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(
      `INSERT INTO brains (id, name, provider, model, quota_reset_short_ms, quota_reset_long_ms, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NORMAL', 1, 1)`,
    );
    insert.run("BRN-G", "gemini-3-7-flash", "google", "gemini-3.7-flash", null, null);
    insert.run("BRN-Q", "groq-wall", "groq", "qwen3.6-27b", null, null);
    // An operator-tuned window must survive the backfill untouched.
    insert.run("BRN-Z", "glm-tuned", "zai", "glm-5.3", 120_000, 7 * DAY);
    insert.run("BRN-X", "mystery", "provider-x", "model-x", null, null);
    db.close();

    const store = openStore({ location: file });
    try {
      const cols = (await store.all(`PRAGMA table_info(brains)`)).map((c) => c.name);
      for (const c of [
        "quota_tier", "quota_short_type", "quota_long_type", "quota_fixed_reset",
        "rpm", "rpd", "tpm", "tpd", "context_window_tokens",
      ]) {
        assert.ok(cols.includes(c), `migration must add ${c}`);
      }

      const g = await store.get(`SELECT * FROM brains WHERE id = 'BRN-G'`);
      assert.equal(g.quota_tier, "free");
      assert.equal(g.quota_long_type, "fixed-time");
      const fr = JSON.parse(g.quota_fixed_reset);
      assert.equal(fr.timeZone, "America/Los_Angeles");
      assert.equal(fr.atHourLocal, 0);
      assert.equal(g.rpm, 5, "per-model google rates survive the backfill path");
      assert.equal(g.rpd, 20);

      const q = await store.get(`SELECT * FROM brains WHERE id = 'BRN-Q'`);
      assert.equal(q.quota_tier, "free");
      assert.equal(q.tpm, 7_000);

      const z = await store.get(`SELECT * FROM brains WHERE id = 'BRN-Z'`);
      assert.equal(z.quota_tier, "lite");
      assert.equal(z.quota_short_type, "credits");
      assert.equal(z.quota_reset_short_ms, 120_000, "an operator-tuned window is never overwritten");

      const x = await store.get(`SELECT * FROM brains WHERE id = 'BRN-X'`);
      assert.equal(x.quota_tier, null, "an unknown provider backfills to honest nulls");
      assert.equal(x.quota_short_type, null);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D64 drops brains.category from a database that still has it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semanggi-cat-mig-"));
  const file = join(dir, "controller.db");
  try {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE brains (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT,
        effort_mode TEXT NOT NULL DEFAULT 'guaranteed',
        effort_evidence TEXT,
        mode TEXT NOT NULL DEFAULT 'interactive',
        acp_agent TEXT,
        quota_reset_short_ms INTEGER,
        quota_reset_long_ms INTEGER,
        category TEXT,
        level TEXT NOT NULL DEFAULT 'NORMAL',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO brains (id, name, provider, model, category, level, created_at, updated_at)
       VALUES ('BRN-C', 'punya-kategori', 'zai', 'glm-5.2', 'architecture', 'NORMAL', 1, 1)`,
    ).run();
    db.close();

    const store = openStore({ location: file });
    try {
      const cols = (await store.all(`PRAGMA table_info(brains)`)).map((c) => c.name);
      assert.equal(cols.includes("category"), false, "the ghost column must be gone, not ignored");
      const row = await store.get(`SELECT * FROM brains WHERE id = 'BRN-C'`);
      assert.equal(row.name, "punya-kategori", "the row survives the drop");
      // D63 backfill ran on the same boot.
      assert.equal(row.quota_tier, "lite");
    } finally {
      await store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- D88: jangkar mingguan Anthropic (Senin 02:00 WIB) ------------------------

test("claude-code long window prices the next Monday 02:00 Asia/Jakarta (D88)", () => {
  // Rabu 2026-09-09 12:00Z → Senin berikutnya 02:00 WIB = 2026-09-13T19:00Z.
  const wednesday = Date.parse("2026-09-09T12:00:00Z");
  const weekly = { kind: "fixed-time", ms: 7 * DAY, fixedReset: claudeCodeDriver.defaults().fixedReset };
  assert.equal(claudeCodeDriver.nextReset(weekly, { nowMs: wednesday }), Date.parse("2026-09-13T19:00:00Z"));

  // Tepat sebelum reset (Senin 01:30 WIB): masih Senin ini.
  assert.equal(
    claudeCodeDriver.nextReset(weekly, { nowMs: Date.parse("2026-09-13T18:30:00Z") }),
    Date.parse("2026-09-13T19:00:00Z"),
  );

  // Tepat setelah reset (Senin 02:30 WIB): Senin BERIKUTNYA — jam dinding
  // tetap, bukan envelope rolling dari now.
  assert.equal(
    claudeCodeDriver.nextReset(weekly, { nowMs: Date.parse("2026-09-13T19:30:00Z") }),
    Date.parse("2026-09-20T19:00:00Z"),
  );
});

test("D88 backfill: NULL descriptors get Monday-2am-WIB, hand-tuned rows stay (migration)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d88-"));
  const file = join(dir, "controller.db");
  try {
    // Boot pertama membuat skema penuh + backfill boot; sisipkan dua baris
    // lalu boot LAGI — #migrate() berjalan tiap openStore, dan backfill
    // harus idempoten terhadap baris yang sudah terisi.
    let store = openStore({ location: file });
    await store.run(
      `INSERT INTO brains (id, name, provider, model, quota_reset_short_ms, quota_reset_long_ms, created_at, updated_at)
       VALUES ('BRN-OLD', 'cc-old', 'claude-code', 'claude-code', ?, ?, 1, 1)`,
      [5 * 3_600_000, 7 * DAY],
    );
    await store.run(
      `INSERT INTO brains (id, name, provider, model, quota_reset_short_ms, quota_reset_long_ms, quota_fixed_reset, created_at, updated_at)
       VALUES ('BRN-TUNED', 'cc-tuned', 'claude-code', 'claude-code', ?, ?, ?, 1, 1)`,
      [5 * 3_600_000, 7 * DAY, JSON.stringify({ atHourLocal: 5, timeZone: "UTC" })],
    );
    await store.close();

    store = openStore({ location: file });
    const rows = await store.all(`SELECT id, quota_fixed_reset FROM brains ORDER BY id`);
    await store.close();

    const old = rows.find((r) => r.id === "BRN-OLD");
    assert.deepEqual(JSON.parse(old.quota_fixed_reset), { atHourLocal: 2, timeZone: "Asia/Jakarta", day: 1 });
    const tuned = rows.find((r) => r.id === "BRN-TUNED");
    assert.deepEqual(JSON.parse(tuned.quota_fixed_reset), { atHourLocal: 5, timeZone: "UTC" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
