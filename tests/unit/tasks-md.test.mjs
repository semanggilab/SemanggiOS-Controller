// Parser docs/tasks.md (PREPARE "daftarkan…") — format checklist yang
// diminta prompt "Create tasks" sendiri. Yang diuji di sini bentuk dokumen
// nyata di cluster (workspaces/sdmk-kader/docs/tasks.md, 2026-09-06):
// checkbox bold `**T-XX — Judul**`, metadata `**Role:** … · **Dep:** …`,
// dan `**Deskripsi:** …` — plus variasi yang harus ditolerir karena
// dokumen ini ditulis model, bukan mesin.
import test from "node:test";
import assert from "node:assert/strict";
import { markRegistered, parseTasksMd, wantsImmediateRun } from "../../src/interface/tasks-md.mjs";

const SAMPLE = `# Daftar Task Implementasi

## Cara pakai

- \`[ ]\` belum selesai · \`[x]\` selesai.

## R0 — Foundation

- [ ] **T-01 — Scaffolding monorepo + lint boundaries**
  - **Role:** builder · **Dep:** — · **Kompleksitas:** simple · **Effort:** normal
  - **Deskripsi:** pnpm workspaces + Turborepo; struktur apps/ dan packages/.

- [ ] **T-02 — Infra Compose + observability**
  - **Role:** builder · **Dep:** T-01 · **Kompleksitas:** medium · **Effort:** critical
  - **Deskripsi:** docker-compose dev & prod, PostgreSQL 17, Redis 7.

- [x] **T-03 — Sudah dikerjakan sebelumnya**
  - **Role:** tester · **Dep:** T-02
  - **Deskripsi:** tidak boleh ikut terdaftar.

## R1 — Core

- [ ] **T-04 — Endpoint kader**
  - **Role:** builder · **Dep:** T-01, T-02 · **Kompleksitas:** complex
  - **Deskripsi:** CRUD kader + audit.
`;

test("parseTasksMd membaca judul, role, dependensi, dan deskripsi", () => {
  const tasks = parseTasksMd(SAMPLE);
  assert.equal(tasks.length, 4);

  const [t1, t2, t3, t4] = tasks;
  assert.equal(t1.localId, "T-01");
  assert.equal(t1.title, "Scaffolding monorepo + lint boundaries");
  assert.equal(t1.role, "builder");
  assert.deepEqual(t1.deps, []);
  assert.match(t1.description, /pnpm workspaces/);

  assert.deepEqual(t2.deps, ["T-01"]);
  assert.equal(t3.done, true);
  assert.deepEqual(t4.deps, ["T-01", "T-02"]);
});

test("heading mengakhiri blok metadata task sebelumnya", () => {
  // Deskripsi yang muncul SETELAH heading section baru tidak boleh menempel
  // ke task terakhir section sebelumnya.
  const md = `- [ ] **T-01 — Satu**
  - **Role:** builder · **Dep:** —

## Section lain

Bukan metadata task ini.
`;
  const tasks = parseTasksMd(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].description, null);
});

test("variasi ejaan tetap terbaca: tanpa bold, dash en, x besar", () => {
  const md = `- [X] T-09 – Judul tanpa bold
  - **Role:** Analyst · **Dep:** —
`;
  const tasks = parseTasksMd(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].localId, "T-09");
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[0].title, "Judul tanpa bold");
  assert.equal(tasks[0].role, "analyst");
});

test("dokumen kosong atau tanpa checklist menghasilkan daftar kosong", () => {
  assert.deepEqual(parseTasksMd(""), []);
  assert.deepEqual(parseTasksMd("# Hanya judul\n\nParagraf biasa."), []);
  assert.deepEqual(parseTasksMd(null), []);
});

test("wantsImmediateRun mengenali permintaan langsung jalankan", () => {
  assert.equal(wantsImmediateRun("daftarkan semua tasks dan langsung jalankan"), true);
  assert.equal(wantsImmediateRun("…dan lansung jalankan sekarang"), true);
  assert.equal(wantsImmediateRun("daftarkan dan langsung dijalankan"), true);
  assert.equal(wantsImmediateRun("LANGSUNG JALANKAN"), true);
  assert.equal(wantsImmediateRun("daftarkan semua tasks yang ada di docs/tasks.md"), false);
  assert.equal(wantsImmediateRun("jalankan nanti saja setelah saya review"), false);
});

// --- `[-]`: tanda "sudah didaftarkan ke basis data" ----------------------------

test("checkbox [-] terbaca sebagai registered, bukan done dan bukan open", () => {
  const md = `- [-] **T-01 — Sudah didaftarkan**
  - **Role:** builder · **Dep:** —
- [ ] **T-02 — Belum**
- [x] **T-03 — Selesai**
`;
  const tasks = parseTasksMd(md);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].registered, true);
  assert.equal(tasks[0].done, false);
  assert.equal(tasks[1].registered, false);
  assert.equal(tasks[2].done, true);
});

test("markRegistered menandai hanya localId yang diminta, sisanya utuh", () => {
  const md = `# Daftar

- [ ] **T-01 — Satu**
  - **Role:** builder · **Dep:** —
- [ ] **T-02 — Dua**
- [x] **T-03 — Tiga**
- [-] **T-04 — Empat**
`;
  const out = markRegistered(md, ["t-01", "T-04", "T-99"]);
  const tasks = parseTasksMd(out);
  assert.equal(tasks[0].registered, true, "T-01 ditandai (input lowercase tetap kena)");
  assert.equal(tasks[1].registered, false, "T-02 tidak disebut — tetap [ ]");
  assert.equal(tasks[2].done, true, "T-03 [x] tidak boleh diubah");
  assert.equal(tasks[3].registered, true, "T-04 sudah [-] — idempoten, tidak dobel");
  // Baris di luar checkbox tidak tersentuh.
  assert.match(out, /# Daftar/);
});
