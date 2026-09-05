// PUT /api/work/projects/{id}/docs/{name} — penyimpanan suntingan dokumen
// dari modal Command Center (Edit/Save).
//
// Kontrak yang diuji: konten tersimpan dan terbaca balik lewat GET, nama
// dokumen di luar whitelist DITOLAK (whitelist yang sama dengan GET — satu
// lubang di PUT berarti seluruh workspace bisa ditulis lewat satu request),
// dan setiap penyimpanan meninggalkan jejak di event_log — "siapa mengubah
// tasks.md" harus bisa dijawab dari audit, bukan dari memori orang.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function setup() {
  const h = await buildHarness();
  const root = mkdtempSync(join(tmpdir(), "semanggi-docs-"));
  const project = await h.repos.projects.create({ name: "docs", weight: 1, workspacePath: root });
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return {
    h,
    project,
    call,
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("PUT menyimpan konten dan GET membacanya balik", async () => {
  const t = await setup();
  try {
    const saved = await t.call("PUT", `/api/work/projects/${t.project.id}/docs/tasks`, {
      content: "# Task\n\n- [-] **T-01 — Sudah didaftarkan**\n",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.exists, true);

    const read = await t.call("GET", `/api/work/projects/${t.project.id}/docs/tasks`);
    assert.equal(read.status, 200);
    assert.equal(read.body.exists, true);
    assert.match(read.body.content, /T-01/);
  } finally {
    await t.close();
  }
});

test("penyimpanan dokumen meninggalkan jejak audit", async () => {
  const t = await setup();
  try {
    await t.call("PUT", `/api/work/projects/${t.project.id}/docs/brief`, { content: "brief baru" });
    const events = await t.h.store.all(
      `SELECT * FROM event_log WHERE kind = 'project.doc-updated' AND subject_id = ?`,
      [t.project.id],
    );
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].payload).document, "docs/brief.md");
  } finally {
    await t.close();
  }
});

test("nama dokumen di luar whitelist ditolak oleh PUT", async () => {
  const t = await setup();
  try {
    const res = await t.call("PUT", `/api/work/projects/${t.project.id}/docs/..%2Fsecrets`, {
      content: "nope",
    });
    assert.equal(res.status, 400);
    const res2 = await t.call("PUT", `/api/work/projects/${t.project.id}/docs/unknown`, {
      content: "nope",
    });
    assert.equal(res2.status, 400);
  } finally {
    await t.close();
  }
});

test("dokumen memori agen (memory/) ditolak oleh PUT — wilayah agen, bukan operator", async () => {
  const t = await setup();
  try {
    const res = await t.call("PUT", `/api/work/projects/${t.project.id}/docs/blueprint`, {
      content: "mencoba menulis memori",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /memori agen/);
  } finally {
    await t.close();
  }
});

test("PUT tanpa content ditolak", async () => {
  const t = await setup();
  try {
    const res = await t.call("PUT", `/api/work/projects/${t.project.id}/docs/tasks`, {});
    assert.equal(res.status, 400);
  } finally {
    await t.close();
  }
});
