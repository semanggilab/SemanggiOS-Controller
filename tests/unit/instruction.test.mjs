// Preamble instruksi.
//
// Yang diuji bukan formatnya melainkan kejujurannya: agen harus tahu Brain apa
// yang benar-benar berjalan, apakah effort-nya aktif, ke mana menulis, dan
// apakah ia boleh menyentuh kode.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPreamble, withPreamble, deliverablesDirFor } from "../../src/runtime/instruction.mjs";

const task = { id: "TASK-91", title: "migrasi billing", workspace_mode: "write" };

test("effort yang dijamin disebut aktif", () => {
  const p = buildPreamble({
    task,
    brain: { name: "deep-coding", provider: "zai", model: "glm-5.2", thinking: "max", effortMode: "guaranteed" },
  });
  assert.match(p, /Brain: deep-coding \(zai\/glm-5\.2\)/);
  assert.match(p, /Reasoning effort: max \(aktif\)/);
});

test("effort preferensi diberitahukan sebagai TIDAK aktif", () => {
  // Ini alasan preamble ada. Agen yang tidak diberi tahu akan menyusun rencana
  // yang mengandalkan penalaran panjang yang tidak pernah terjadi, lalu
  // menghasilkan pekerjaan dangkal tanpa ada yang tahu sebabnya.
  const p = buildPreamble({
    task,
    brain: { name: "gemini-high", provider: "google", model: "gemini-3.1-flash-lite", thinking: "high", effortMode: "preference" },
  });
  assert.match(p, /TIDAK AKTIF/);
  assert.match(p, /jangan mengandalkan penalaran panjang/i);
});

test("brain tanpa thinking tidak menghasilkan klaim effort", () => {
  const p = buildPreamble({ task, brain: { name: "qwen", provider: "groq", model: "qwen/qwen3.6-27b" } });
  assert.doesNotMatch(p, /Reasoning effort/);
});

test("kandidat routing diterima sama seperti baris Brain", () => {
  // Kandidat menyebut dirinya `logical`, baris Brain menyebut `name`.
  // Normalisasi di preamble supaya tidak ada pemanggil yang lupa.
  const p = buildPreamble({
    task,
    brain: { logical: "glm-5.2-max", provider: "zai", model: "glm-5.2", thinking: "max" },
  });
  assert.match(p, /Brain: glm-5\.2-max/);
});

test("direktori keluaran memakai konvensi yang sudah diinstruksikan OpenClaw", () => {
  // AGENTS.md bawaan menyuruh agen menulis ke deliverables/. Memakai nama lain
  // berarti melawan instruksi bawaan setiap kali (spec §6.1).
  assert.equal(deliverablesDirFor("TASK-91"), "deliverables/TASK-91");
  assert.match(buildPreamble({ task }), /Tulis hasil ke: deliverables\/TASK-91\//);
});

test("mode lease diberitahukan, karena agen tidak bisa melihatnya sendiri", () => {
  const write = buildPreamble({ task });
  assert.match(write, /WRITE/);
  assert.match(write, /lease eksklusif/);

  const read = buildPreamble({ task: { ...task, workspace_mode: "read" } });
  assert.match(read, /READ/);
  assert.match(read, /Jangan mengubah berkas di luar direktori hasil/);
});

test("peran disebut bila worker punya", () => {
  assert.match(buildPreamble({ task, role: "Builder" }), /Peran: Builder/);
  assert.doesNotMatch(buildPreamble({ task }), /Peran:/);
});

test("preamble mendahului instruksi dan dipisah dengan jelas", () => {
  const full = withPreamble("Perbaiki bug pada modul pembayaran.", { task });
  const [head, body] = full.split("\n---\n");
  assert.match(head, /Konteks eksekusi \(Semanggi\)/);
  assert.match(body.trim(), /^Perbaiki bug pada modul pembayaran\.$/);
});

test("instruksi kosong tidak membuat preamble hilang", () => {
  const full = withPreamble("", { task });
  assert.match(full, /TASK-91/);
});
