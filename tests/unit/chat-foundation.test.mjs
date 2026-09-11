// POC-10 T1 — fondasi chat: migrasi (tabel + kolom batas chat), repositori
// (sessions/messages/sandboxes), event kinds, dan role `chat` sebagai warga
// kosakata resolusi kelas satu (§10.1).
//
// Yang diuji bukan "kolomnya ada" tapi KEBIJAKANNYA: batas chat default 1 dan
// TIDAK menyentuh nilai lama (warisan memulai hidup dengan batas paling
// konservatif); urutan transkrip tidak bergantung pada jam yang diam; baris
// chat cascade bersama project-nya; dan role chat eksplisit di tabel default —
// bukan jatuh ke level profil yang kebetulan.
import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../../src/db/index.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";
import { resolveLevel, rolesForTemplate, DEFAULT_ROLE_LEVELS } from "../../src/domain/brains.mjs";

// --- migrasi ------------------------------------------------------------------

// Bentuk `resources` pra-POC-10: persis kolom lama, tanpa chat_concurrency_limit.
const LEGACY_RESOURCES = `
  CREATE TABLE resources (
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
    quota_policy      TEXT NOT NULL DEFAULT '{}',
    availability      TEXT NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (availability IN ('AVAILABLE','QUOTA_EXHAUSTED','UNAVAILABLE')),
    credit_class      TEXT NOT NULL DEFAULT 'metered',
    next_available_at INTEGER,
    window_kind       TEXT,
    last_quota_signal TEXT,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (provider, model)
  );`;

test("migrasi: DB warisan dapat kolom chat_concurrency_limit default 1, nilai lama utuh", async () => {
  const path = join(tmpdir(), `semanggi-chat-mig-${randomUUID()}.db`);
  const legacy = new Database(path);
  legacy.exec("PRAGMA foreign_keys = ON");
  legacy.exec(LEGACY_RESOURCES);
  legacy
    .prepare("INSERT INTO resources (provider, model, concurrency_limit, updated_at) VALUES (?, ?, ?, ?)")
    .run("zai", "glm-4.7", 3, 123);
  legacy.close();

  const store = await openStore({ driver: "sqlite", location: path });
  const row = await store.get("SELECT * FROM resources WHERE provider = 'zai' AND model = 'glm-4.7'");
  assert.equal(row.concurrency_limit, 3, "kebijakan task lama tidak tersentuh");
  assert.equal(row.chat_concurrency_limit, 1, "warisan memulai dengan batas chat paling konservatif");

  for (const t of ["chat_sessions", "chat_messages", "chat_sandboxes"]) {
    const found = await store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [t]);
    assert.ok(found, `tabel ${t} tercipta di DB warisan`);
  }

  // Idempoten: boot kedua tidak error dan tidak mengubah nilai.
  await store.close();
  const again = await openStore({ driver: "sqlite", location: path });
  const row2 = await again.get("SELECT * FROM resources WHERE provider = 'zai' AND model = 'glm-4.7'");
  assert.equal(row2.chat_concurrency_limit, 1);
  await again.close();
});

test("migrasi: DB baru memilikinya sejak awal (schema.sql, bukan ALTER)", async () => {
  const store = await openStore({ driver: "sqlite", location: ":memory:" });
  const row = await store.get("SELECT chat_concurrency_limit FROM resources LIMIT 1").catch(() => null);
  assert.equal(row, null, "tabel kosong — kolom dicek lewat sqlite_master");
  const col = await store.get("SELECT name FROM pragma_table_info('resources') WHERE name = 'chat_concurrency_limit'");
  assert.ok(col);
  await store.close();
});

// --- repositori ---------------------------------------------------------------

test("chatSessions: create/get/event, project tak dikenal ditolak", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const brain = await h.brains.create({ name: "gemini-flash-high", provider: "google", model: "gemini-flash" });

  const s = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "operator-a" });
  assert.match(s.id, /^CHS-/);
  assert.equal(s.status, "ACTIVE");
  assert.equal(s.gateway_session_ref, null, "sesi baru = dispatch pertama FRESH (§7.2)");

  const evts = await h.events.list({ subjectType: "chat_session", subjectId: s.id });
  assert.ok(evts.some((e) => e.kind === "chat.session-created" && e.payload.projectId === project.id));

  await assert.rejects(
    () => h.repos.chatSessions.create({ projectId: "PRJ-NOPE", brainId: brain.id, actor: "x" }),
    /unknown project/,
  );
});

test("chatMessages: urutan seq stabil di jam yang diam, attachments roundtrip, jam sesi ikut naik", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const brain = await h.brains.create({ name: "gemini-flash-high", provider: "google", model: "gemini-flash" });
  const s = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "operator-a" });
  const before = (await h.repos.chatSessions.get(s.id)).last_active_at;

  // Jam harness tidak dimajukan — created_at kedua pesan identik.
  await h.repos.chatMessages.append({ sessionId: s.id, role: "operator", content: "pertama" });
  await h.repos.chatMessages.append({
    sessionId: s.id,
    role: "brain",
    content: "kedua",
    attachments: ["chat/CHS-1/uploads/a.md"],
  });

  const msgs = await h.repos.chatMessages.list(s.id);
  assert.deepEqual(
    msgs.map((m) => m.content),
    ["pertama", "kedua"],
    "urutan transkrip dari seq, bukan rencana eksekusi pada stempel sama",
  );
  assert.deepEqual(msgs[1].attachments, ["chat/CHS-1/uploads/a.md"], "attachments JSON bulat-bulat");

  const after = await h.repos.chatSessions.get(s.id);
  assert.ok(after.last_active_at >= before, "pesan menaikkan jam sesi di sidebar");

  const evts = await h.events.list({ subjectType: "chat_session", subjectId: s.id });
  assert.equal(evts.filter((e) => e.kind === "chat.message-sent").length, 2);

  await assert.rejects(
    () => h.repos.chatMessages.append({ sessionId: s.id, role: "alien", content: "x" }),
    /role must be/,
  );
});

test("chatSessions: sidebar terbaru-dulu; patch judul/arsip; setGatewayRef untuk CONTINUE", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const brain = await h.brains.create({ name: "gemini-flash-high", provider: "google", model: "gemini-flash" });
  const a = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "o" });
  h.clock.advance(5_000);
  const b = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "o" });
  assert.deepEqual((await h.repos.chatSessions.listByProject(project.id)).map((s) => s.id), [b.id, a.id]);

  // Sesi lama menerima pesan → ia yang naik ke puncak.
  h.clock.advance(5_000);
  await h.repos.chatMessages.append({ sessionId: a.id, role: "operator", content: "bangun lagi" });
  assert.deepEqual((await h.repos.chatSessions.listByProject(project.id)).map((s) => s.id), [a.id, b.id]);

  const renamed = await h.repos.chatSessions.patch(a.id, { title: "soal workspace" });
  assert.equal(renamed.title, "soal workspace");
  const archived = await h.repos.chatSessions.patch(a.id, { status: "ARCHIVED" });
  assert.equal(archived.status, "ARCHIVED");
  await assert.rejects(() => h.repos.chatSessions.patch(a.id, { status: "GONE" }), /ACTIVE or ARCHIVED/);

  const withRef = await h.repos.chatSessions.setGatewayRef(b.id, "agent:x:key-1");
  assert.equal(withRef.gateway_session_ref, "agent:x:key-1");
});

test("cascade: project delete membawa sesi+pesan+sandbox; hapus sesi membawa pesannya", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const brain = await h.brains.create({ name: "gemini-flash-high", provider: "google", model: "gemini-flash" });
  const s = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "o" });
  await h.repos.chatMessages.append({ sessionId: s.id, role: "operator", content: "hai" });
  await h.repos.chatSandboxes.upsert({
    projectId: project.id,
    brainId: brain.id,
    agentId: "sem-chat-a",
    provider: "google",
    model: "gemini-flash",
  });

  const s2 = await h.repos.chatSessions.create({ projectId: project.id, brainId: brain.id, actor: "o" });
  await h.repos.chatMessages.append({ sessionId: s2.id, role: "operator", content: "hai 2" });
  await h.repos.chatSessions.remove(s2.id);
  assert.equal((await h.repos.chatMessages.list(s2.id)).length, 0, "pesan ikut sesinya");

  await h.repos.projects.delete(project.id);
  assert.equal((await h.repos.chatSessions.listByProject(project.id)).length, 0);
  assert.equal((await h.repos.chatMessages.list(s.id)).length, 0);
  assert.equal(await h.repos.chatSandboxes.get(project.id, brain.id), null);
});

test("resources: setChatConcurrencyLimit menulis kebijakan + event resource.policy", async () => {
  const h = await buildHarness();
  await seedBasics(h);
  const before = await h.repos.resources.get("zai", "glm-4.7");
  assert.equal(before.chat_concurrency_limit, 1, "default schema");

  const after = await h.repos.resources.setChatConcurrencyLimit("zai", "glm-4.7", 3);
  assert.equal(after.chat_concurrency_limit, 3);
  assert.equal(after.concurrency_limit, before.concurrency_limit, "batas task tidak ikut berubah");

  const evts = await h.events.list({ kind: "resource.policy" });
  assert.ok(evts.some((e) => e.payload.field === "chat_concurrency_limit" && e.payload.to === 3));

  await assert.rejects(() => h.repos.resources.setChatConcurrencyLimit("zai", "glm-4.7", -1), /integer >= 0/);
  await assert.rejects(() => h.repos.resources.setChatConcurrencyLimit("zai", "tak-ada", 1), /unknown resource/);
});

// --- role chat (§10.1) ---------------------------------------------------------

test("role chat: eksplisit di semua template×profile, bukan jatuh ke level profil", async () => {
  for (const template of Object.keys(DEFAULT_ROLE_LEVELS)) {
    assert.ok(rolesForTemplate(template).includes("chat"), `${template} menawarkan role chat`);
    for (const profile of ["fast", "balanced", "quality"]) {
      const resolved = resolveLevel({ template, role: "chat", profile });
      assert.equal(resolved, "normal", `${template}/${profile}: chat eksplisit normal`);
    }
  }
  // Bukti bahwa tanpa entri eksplisit fast akan jatuh ke "low" — entri tabel
  // yang benar-benar mengubah perilaku, bukan hiasan.
  assert.equal(resolveLevel({ template: "software", role: "chat", profile: "fast" }), "normal");
  assert.equal(resolveLevel({ template: "software", role: "role-tak-ada", profile: "fast" }), "low");
});

test("role chat: brainMap.resolve memakai default grid, pemaku operator menang", async () => {
  const h = await buildHarness();
  await seedBasics(h);
  const free = await h.brains.create({ name: "gemini-flash-high", provider: "google", model: "gemini-flash" });
  // "glm-5.2-max" sudah di-seed buildHarness dari katalog routing — dipakai
  // apa adanya, bukan dibuat ulang (UNIQUE brains.name).
  const paid = await h.brains.get("glm-5.2-max");

  const def = await h.brainMap.resolve({ template: "software", role: "chat", level: "normal", brains: h.brains });
  assert.equal(def.source, "default", "belum dipaku → default grid");
  assert.equal(def.candidates[0].brain.name, "gemini-flash-high", "prioritas operator: gratis dulu (§7.4)");
  assert.equal(def.reason, null);

  await h.brainMap.set({ template: "software", role: "chat", level: "normal", brainIds: [paid.id], actor: "operator-a" });
  const pinned = await h.brainMap.resolve({ template: "software", role: "chat", level: "normal", brains: h.brains });
  assert.equal(pinned.source, "pinned");
  assert.equal(pinned.candidates[0].brain.name, "glm-5-2-max", "operator memaku ulang lewat halaman yang sama");

  const crit = await h.brainMap.resolve({ template: "research", role: "chat", level: "critical", brains: h.brains });
  assert.equal(crit.candidates[0].brain.name, "glm-5-2-max", "critical naik ke max — titik awal, bukan plafon");
});
