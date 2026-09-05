// PREPARE "daftarkan semua tasks yang ada di docs/tasks.md…" lewat
// /api/work/control/message — pendaftaran task dari dokumen checklist.
//
// Kontrak yang diuji: default CREATED (tertahan, seperti fase lanjutan
// dekomposisi), "langsung jalankan" memindahkan semuanya ke QUEUED,
// dependensi antar temporary ID dipetakan ke id task nyata, item [x]
// dilewati, dan dokumen yang hilang dijawab — bukan dilempar 500.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness } from "../helpers/harness.mjs";
import { Status } from "../../src/domain/state-machine.mjs";

const TOKEN = "controller-token-for-tests";

const TASKS_MD = `# Daftar Task

- [ ] **T-01 — Fondasi**
  - **Role:** builder · **Dep:** — · **Kompleksitas:** simple
  - **Deskripsi:** siapkan struktur.

- [ ] **T-02 — Layanan inti**
  - **Role:** builder · **Dep:** T-01 · **Kompleksitas:** medium
  - **Deskripsi:** bangun di atas fondasi.

- [x] **T-03 — Sudah selesai di dokumen**
  - **Role:** tester · **Dep:** T-02
  - **Deskripsi:** tidak boleh terdaftar.
`;

async function setup({ withDoc = true } = {}) {
  const h = await buildHarness();
  const root = mkdtempSync(join(tmpdir(), "semanggi-register-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  if (withDoc) writeFileSync(join(root, "docs", "tasks.md"), TASKS_MD);
  const project = await h.repos.projects.create({ name: "reg", weight: 1, workspacePath: root });
  await h.repos.workers.create({ role: "documentation", agentRef: "doc-worker", maxConcurrent: 2, projectAccess: [project.id] });
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const send = async (text) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/work/control/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text, projectId: project.id }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return {
    h,
    project,
    root,
    send,
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("registrasi default menahan semua task di CREATED", async () => {
  const t = await setup();
  try {
    const { status, body } = await t.send("PREPARE: daftarkan semua tasks yang ada di docs/tasks.md");
    assert.equal(status, 200);
    assert.equal(body.intent, "PREPARE");
    assert.equal(body.action, "register");
    assert.equal(body.registered.length, 2, "item [x] tidak ikut terdaftar");
    for (const task of body.registered) assert.equal(task.status, Status.CREATED);
    const dbTask = await t.h.repos.tasks.get(body.registered[0].id);
    assert.equal(dbTask.status, Status.CREATED);
  } finally {
    await t.close();
  }
});

test("frasa langsung jalankan mengantrekan semua task (QUEUED)", async () => {
  const t = await setup();
  try {
    const { status, body } = await t.send(
      "PREPARE: daftarkan semua tasks yang ada di docs/tasks.md dan langsung jalankan",
    );
    assert.equal(status, 200);
    assert.equal(body.registered.length, 2);
    for (const task of body.registered) assert.equal(task.status, Status.QUEUED);
    // Setelah notify, admission boleh memarkir task berdependensi di
    // WAIT_DEP — bukti yang dituntut di sini hanyalah "tidak lagi CREATED".
    for (const task of body.registered) {
      const dbTask = await t.h.repos.tasks.get(task.id);
      assert.notEqual(dbTask.status, Status.CREATED, task.id);
    }
  } finally {
    await t.close();
  }
});

test("dependensi temporary ID dipetakan ke id task nyata", async () => {
  const t = await setup();
  try {
    const { body } = await t.send("PREPARE: daftarkan semua tasks yang ada di docs/tasks.md");
    const [first, second] = body.registered;
    assert.deepEqual(second.deps, ["T-01"]);
    const deps = await t.h.repos.tasks.dependencies(second.id);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].id, first.id);
  } finally {
    await t.close();
  }
});

test("docs/tasks.md hilang dijawab, bukan dilempar", async () => {
  const t = await setup({ withDoc: false });
  try {
    const { status, body } = await t.send("PREPARE: daftarkan semua tasks yang ada di docs/tasks.md");
    assert.equal(status, 200);
    assert.equal(body.action, "register");
    assert.deepEqual(body.registered, []);
    assert.match(body.reply, /tasks\.md tidak ada/);
  } finally {
    await t.close();
  }
});
