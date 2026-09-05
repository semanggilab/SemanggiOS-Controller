// Command Center readiness checklist — GET /projects/{id}/docs and the
// read-only content route behind it.
//
// What's under test is not file reading (the OS does that) but the two
// contract edges this route owns: the checklist is graded per template
// (research/content have no architect, so demanding architecture.md would
// make every research project permanently "not ready"), and no request
// input ever reaches a path segment — names outside the whitelist are
// rejected, so nothing outside the two doc directories can be read.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

function seedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "semanggi-docs-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "docs", "brief.md"), "# Brief\n\nBuild the registry.");
  writeFileSync(join(root, "memory", "decisions.md"), "# Decisions\n\n- D1: use SQLite");
  return root;
}

test("checklist dinilai per template: research tidak menuntut architecture.md", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  await h.repos.projects.update(project.id, { template: "research" });
  const api = await startApi(h);
  try {
    const res = await api.call("GET", `/api/work/projects/${project.id}/docs`);
    assert.equal(res.status, 200);
    const names = res.body.docs.map((d) => d.name);
    assert.ok(!names.includes("architecture"), "research tanpa architect phase tidak boleh dituntut architecture.md");
    assert.ok(names.includes("plans") && names.includes("tasks"), "plans dan tasks adalah dokumen wajib");
    assert.ok(names.includes("blueprint") && names.includes("decisions"), "dua tingkat memory tetap dicek");
    assert.ok(names.includes("brief"));
  } finally {
    await api.close();
  }
});

test("dokumen yang ada dilaporkan exists dengan isi terbaca; yang hilang exists=false", async () => {
  const h = await buildHarness();
  const root = seedWorkspace();
  const api = await startApi(h);
  try {
    // workspacePath is not PATCH-editable by design, so the project is
    // created directly against the temp workspace the way a real
    // registration would.
    const project = await h.repos.projects.create({
      name: "docs-project",
      workspacePath: root,
      template: "software",
    });

    const list = await api.call("GET", `/api/work/projects/${project.id}/docs`);
    assert.equal(list.status, 200);
    const byName = Object.fromEntries(list.body.docs.map((d) => [d.name, d]));
    assert.equal(byName.brief.exists, true, "docs/brief.md harus terdeteksi");
    assert.equal(byName.decisions.exists, true, "memory/decisions.md harus terdeteksi");
    assert.equal(byName.architecture.exists, false, "architecture.md tidak ditulis di sini");
    assert.equal(byName.tasks.exists, false);

    const brief = await api.call("GET", `/api/work/projects/${project.id}/docs/brief`);
    assert.equal(brief.status, 200);
    assert.equal(brief.body.exists, true);
    assert.match(brief.body.content, /Build the registry\./);

    const missing = await api.call("GET", `/api/work/projects/${project.id}/docs/architecture`);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.exists, false);
    assert.equal(missing.body.content, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await api.close();
  }
});

test("nama di luar whitelist ditolak — tidak ada input request yang menyusup ke path", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    for (const bad of ["..%2F..%2Fsecrets", "unknown-doc"]) {
      const res = await api.call("GET", `/api/work/projects/${project.id}/docs/${bad}`);
      assert.equal(res.status, 400, `"${bad}" harus ditolak, bukan dibaca`);
    }
  } finally {
    await api.close();
  }
});
