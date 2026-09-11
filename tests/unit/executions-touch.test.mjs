// Regresi Postgres (ditemukan 2026-09-11, POC-10): executions.touch memakai
// MAX(COALESCE(last_event_at, 0), ?) — skalar dua-argumen yang sah di SQLite
// dan TIDAK ADA di Postgres ("function max(bigint, bigint) does not exist",
// log controller saat lifecycle start run chat). Bentuk CASE menguji perilaku
// yang sama (monoton naik, diam pada baris final) tanpa dialek.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, seedBasics, queuedTask } from "../helpers/harness.mjs";

test("touch: naik monoton — event lama tidak menyeret jam mundur, baris final diam", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const task = await queuedTask(h, { project, worker });
  const exec = await h.repos.executions.create({ taskId: task.id, mode: "batch" });

  await h.repos.executions.touch(exec.id, 1_000);
  await h.repos.executions.touch(exec.id, 500); // frame telat — tidak boleh mundur
  await h.repos.executions.touch(exec.id, 2_000);
  let row = await h.repos.executions.get(exec.id);
  assert.equal(Number(row.last_event_at), 2_000, "jam hanya maju");

  await h.repos.executions.setStatus(exec.id, "FAILED", { result: "done" });
  const finalized = await h.repos.executions.get(exec.id);
  assert.ok(finalized.finalized_at, "precondition: baris sudah final");
  await h.repos.executions.touch(exec.id, 9_000); // frame telat pasca-final — diam
  row = await h.repos.executions.get(exec.id);
  assert.equal(Number(row.last_event_at), 2_000, "baris final tidak tersentuh");
});
