// Project-level template/profile (D37).
//
// What's tested: the setting persists and round-trips through the API, it
// validates the same way whether written through repos.projects.update or
// PATCH, and a WORK request through /control/message uses the project's own
// setting when the caller doesn't override it — the whole point of moving it
// out of the Control page.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("project mendapat template dan profile bawaan saat dibuat", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  assert.equal(project.template, "software");
  assert.equal(project.profile, "balanced");
});

test("repos.projects.update menolak profile yang bukan salah satu fast/balanced/quality", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  await assert.rejects(() => h.repos.projects.update(project.id, { profile: "premium" }), /fast\/balanced\/quality/);
});

test("repos.projects.update mengubah template dan profile, dan tercatat di event log", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const after = await h.repos.projects.update(project.id, { template: "backend", profile: "quality", actor: "satria" });
  assert.equal(after.template, "backend");
  assert.equal(after.profile, "quality");

  const events = await h.events.list({ subjectType: "project", subjectId: project.id });
  const changed = events.find((e) => e.kind === "project.settings-changed");
  assert.ok(changed, "event project.settings-changed tidak tercatat");
  assert.equal(changed.actor, "satria");
  assert.equal(changed.payload.to.profile, "quality");
});

test("PATCH /api/work/projects/{id} menulis template/profile lewat HTTP", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const res = await api.call("PATCH", `/api/work/projects/${project.id}`, { profile: "fast" });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.profile, "fast");
    assert.equal(res.body.project.template, "software");

    const list = await api.call("GET", "/api/work/projects");
    const found = list.body.projects.find((p) => p.id === project.id);
    assert.equal(found.profile, "fast");
  } finally {
    await api.close();
  }
});

test("PATCH /api/work/projects/{id} tanpa field apa pun ditolak", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const res = await api.call("PATCH", `/api/work/projects/${project.id}`, {});
    assert.equal(res.status, 400);
  } finally {
    await api.close();
  }
});

test("PATCH /api/work/projects/{id} untuk project yang tidak ada -> 404", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const res = await api.call("PATCH", "/api/work/projects/PRJ-NOPE", { profile: "fast" });
    assert.equal(res.status, 404);
  } finally {
    await api.close();
  }
});

test("WORK via /control/message memakai profile milik project ketika body tidak menyebutkannya", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  await h.repos.projects.update(project.id, { profile: "quality" });
  // Builder adalah role produksi (spec §4.0): critical hanya pada quality.
  // Kalau ia keluar sebagai "critical" setelah profile project diset quality,
  // itu membuktikan levelnya benar-benar dibaca per (template, profile, role)
  // milik project — bukan dari bawaan "balanced" yang lama di-hardcode.
  // WORK sekarang menugaskan worker per fase (D29/D35 di jalur dekomposisi).
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/control/message", {
      text: "task tambahkan endpoint baru untuk laporan bulanan",
      projectId: project.id,
      force: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "WORK");
    assert.ok(res.body.tasks.length > 0, "tidak ada task terbentuk");
    const builder = res.body.tasks.find((s) => s.role === "builder");
    assert.ok(builder, "fase builder tidak ada di rencana software");
    assert.equal(builder.level, "critical", "profile project = quality seharusnya membuat builder critical");
  } finally {
    await api.close();
  }
});

test("WORK via /control/message masih bisa ditimpa lewat body.profile eksplisit", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  await h.repos.projects.update(project.id, { profile: "quality" });
  // WORK sekarang menugaskan worker per fase (D29/D35 di jalur dekomposisi).
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const api = await startApi(h);
  try {
    // Builder adalah role produksi: normal pada fast/balanced, critical pada
    // quality (spec §4.0). Project diset quality, lalu body menimpa dengan
    // fast — level builder harus mengikuti timpaan itu, bukan profile project.
    const res = await api.call("POST", "/api/work/control/message", {
      text: "task perbaiki bug kecil pada footer",
      projectId: project.id,
      profile: "fast",
      force: true,
    });
    assert.equal(res.status, 200);
    const builder = res.body.tasks.find((s) => s.role === "builder");
    assert.ok(builder, "fase builder tidak ada di rencana software");
    assert.equal(
      builder.level,
      "normal",
      "override body.profile=fast seharusnya menjatuhkan builder ke normal (produksi fast)",
    );
  } finally {
    await api.close();
  }
});
