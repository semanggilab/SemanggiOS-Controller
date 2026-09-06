// Project Role Level (modal Settings → Project) dan lapisan default Brain Map.
//
// Dua hal yang diuji di sini adalah kontrak yang membuat grid (template ×
// profile × role) bermakna bagi project nyata: snapshot milik project benar-benar
// menang atas global saat dispatch, dan lapisan default grid Brain Map tidak
// menghidupkan kembali Brain yang operator matikan.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { Level } from "../../src/domain/brains.mjs";
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

test("GET project role-levels menyebut role aktual: template ∪ worker ∪ tersimpan", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  // Worker seedBasics membawa role "documentation" (di luar kosakata template);
  // satu role template-extra ditambah lewat snapshot tersimpan.
  await h.repos.projects.roleLevels.replace(project.id, [{ role: "historian", level: "normal" }]);
  const api = await startApi(h);
  try {
    const res = await api.call("GET", `/api/work/projects/${project.id}/role-levels`);
    assert.equal(res.status, 200);
    const roles = res.body.roles.map((r) => r.role);
    assert.ok(roles.includes("analyst"), "role template harus ada");
    assert.ok(roles.includes("documentation"), "role worker yang melayani project harus ada");
    assert.ok(roles.includes("historian"), "role tersimpan harus tetap terlihat");
    // Setiap baris membawa resolusi yang sama dengan dispatch, plus Brain-nya.
    for (const row of res.body.roles) {
      assert.ok(["low", "normal", "critical"].includes(row.level), `${row.role}: level tidak sah`);
      assert.ok(row.brainSource, `${row.role}: sumber Brain harus dilaporkan`);
    }
    assert.equal(res.body.hasOwnMapping, true);
  } finally {
    await api.close();
  }
});

test("PUT project role-levels menyimpan snapshot, mengubah profile, dan WORK mengikutinya", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  // Dekomposisi menugaskan worker per fase (D29/D35) — tanpa worker, WORK
  // menolak membuat dan snapshot tidak pernah teruji sampai ke task.
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const api = await startApi(h);
  try {
    const res = await api.call("PUT", `/api/work/projects/${project.id}/role-levels`, {
      profile: "fast",
      roleLevels: [
        { role: "builder", level: "critical" },
        { role: "tester", level: "low" },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const project2 = await h.repos.projects.get(project.id);
    assert.equal(project2.profile, "fast", "profile ikut tersimpan sebagai bagian modal");

    // Snapshot milik project menang: builder fast bawaannya normal, snapshot
    // bilang critical — dekomposisi harus memakai critical.
    const work = await api.call("POST", "/api/work/control/message", {
      text: "task bangun fitur ekspor laporan",
      projectId: project.id,
      force: true,
    });
    assert.equal(work.status, 200);
    const builder = work.body.tasks.find((s) => s.role === "builder");
    assert.equal(builder.level, "critical", "snapshot project harus menang atas default (template, profile)");
    const tester = work.body.tasks.find((s) => s.role === "tester");
    assert.equal(tester.level, "low");
  } finally {
    await api.close();
  }
});

test("PUT project role-levels menolak level yang tidak sah", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const res = await api.call("PUT", `/api/work/projects/${project.id}/role-levels`, {
      roleLevels: [{ role: "builder", level: "turbo" }],
    });
    assert.equal(res.status, 400);
  } finally {
    await api.close();
  }
});

test("PUT role-levels dengan level null menghapus override global kembali ke default", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const set = await api.call("PUT", "/api/work/role-levels", {
      template: "software",
      profile: "balanced",
      role: "builder",
      level: "critical",
    });
    assert.equal(set.status, 200);

    const cleared = await api.call("PUT", "/api/work/role-levels", {
      template: "software",
      profile: "balanced",
      role: "builder",
      level: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.level, null);

    const list = await api.call("GET", "/api/work/role-levels?template=software");
    assert.equal(
      list.body.overrides.filter((o) => o.role === "builder").length,
      0,
      "override harus hilang dari daftar, bukan bernilai null",
    );
  } finally {
    await api.close();
  }
});

test("default grid Brain Map menengahi saat sel tidak dipaku, tapi tidak menghidupkan Brain mati", async () => {
  const h = await buildHarness();
  // Harness menyemai "glm-5-2-max" (normal) dari katalog contoh — nama yang
  // sama dengan default grid untuk architect.
  const seeded = await h.brains.get("glm-5-2-max");
  assert.ok(seeded, "premis: harness menyemai brain bernama glm-5-2-max");

  const viaDefault = await h.brainMap.resolve({
    template: "software",
    role: "architect",
    level: Level.CRITICAL,
    brains: h.brains,
  });
  assert.equal(viaDefault.source, "default", "sel tanpa pemaku jatuh ke default grid");
  assert.equal(viaDefault.candidates[0].brain.name, "glm-5-2-max");
  assert.equal(
    viaDefault.candidates[0].belowLevel,
    true,
    "glm-5-2-max berkelas normal di sini — harus terlihat, bukan ditolak",
  );
  assert.deepEqual(viaDefault.names, ["glm-5-2-max"], "default grid adalah list satu-anggota");

  await h.brains.update(seeded.id, { enabled: false });
  const afterDisable = await h.brainMap.resolve({
    template: "software",
    role: "architect",
    level: Level.CRITICAL,
    brains: h.brains,
  });
  assert.notEqual(afterDisable.source, "default", "Brain mati tidak boleh dihidupkan oleh default grid");
  assert.match(String(afterDisable.reason ?? ""), /glm-5-2-max/, "operator harus tahu default-nya yang terlewat");
});
