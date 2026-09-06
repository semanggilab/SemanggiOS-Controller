// Brain Map dan dekomposisi — dua hal yang dipakai halaman Semanggi di AgentOS.
//
// Yang diuji bukan CRUD-nya melainkan dua sifat yang menentukan apakah halaman
// itu jujur: pemaku Brain tidak boleh menjadi jalan belakang untuk menurunkan
// level, dan sebuah rencana tidak boleh membuat separuh task lalu berhenti.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../../src/api/server.mjs";
import { Level } from "../../src/domain/brains.mjs";
import { buildPlan, pipelineFor, ROLE_CATEGORY, LEVEL_TO_QUALITY } from "../../src/domain/decompose.mjs";
import { Status } from "../../src/domain/state-machine.mjs";
import { buildHarness, seedBasics } from "../helpers/harness.mjs";

const TOKEN = "controller-token-for-tests";

async function startApi(h) {
  const api = createApi(h, { token: TOKEN });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, body, { token = TOKEN } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

// --- brain map ---------------------------------------------------------------

test("pemaku per level dipakai apa adanya, dan Brain di bawah level sel ditandai belowLevel", async () => {
  const h = await buildHarness();
  const murah = await h.brains.create({ name: "murah", provider: "google", model: "gemini-flash", level: Level.LOW });
  await h.brains.create({ name: "mahal", provider: "zai", model: "glm-5.2", thinking: "max", level: Level.CRITICAL });

  // Dengan kunci per level, memilih Brain murah untuk sel critical adalah
  // keputusan eksplisit operator — dipakai, dan peringatannya ikut. Menolaknya
  // akan memalsukan grid: sel yang diisi lalu diam-diam tidak berjalan.
  await h.brainMap.set(
    { template: "software", role: "architect", level: Level.CRITICAL, brainId: murah.id },
    { brains: h.brains },
  );
  const picked = await h.brainMap.resolve({
    template: "software",
    role: "architect",
    level: Level.CRITICAL,
    brains: h.brains,
  });

  assert.equal(picked.source, "pinned");
  assert.equal(picked.candidates[0].brain.name, "murah");
  assert.equal(picked.candidates[0].belowLevel, true, "penurunan eksplisit harus terlihat, bukan diam-diam");

  // Sel level lain tidak ikut-ikutan: pemaku tidak tumpah ke sel sebelah.
  const sebelah = await h.brainMap.resolve({
    template: "software",
    role: "architect",
    level: Level.NORMAL,
    brains: h.brains,
  });
  assert.notEqual(sebelah.source, "pinned", "pemaku tidak boleh bocor ke sel level lain");
});

test("pemaku yang setara atau lebih tinggi dari level dipakai tanpa tanda belowLevel", async () => {
  const h = await buildHarness();
  const a = await h.brains.create({ name: "pilihan-a", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL });
  await h.brains.create({ name: "pilihan-b", provider: "zai", model: "glm-5.1", thinking: "low", level: Level.NORMAL });
  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainId: a.id },
    { brains: h.brains },
  );

  const picked = await h.brainMap.resolve({ template: "software", role: "builder", level: Level.NORMAL, brains: h.brains });
  assert.equal(picked.source, "pinned");
  assert.equal(picked.candidates[0].brain.name, "pilihan-a");
  assert.notEqual(picked.candidates[0].belowLevel, true);

  // Membayar lebih atas kemauan sendiri boleh; yang dilarang hanya turun diam-diam.
  const naik = await h.brains.create({ name: "lebih-tinggi", provider: "zai", model: "glm-5.2", thinking: "max", level: Level.CRITICAL });
  await h.brainMap.set(
    { template: "software", role: "tester", level: Level.NORMAL, brainId: naik.id },
    { brains: h.brains },
  );
  const picked2 = await h.brainMap.resolve({ template: "software", role: "tester", level: Level.NORMAL, brains: h.brains });
  assert.equal(picked2.source, "pinned");
});

test("memaku ke Brain yang dimatikan ditolak saat disetel, bukan saat dispatch", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({ name: "mati", provider: "zai", model: "glm-5.1", level: Level.NORMAL });
  await h.brains.update(b.id, { enabled: false });
  await assert.rejects(
    () => h.brainMap.set({ template: "software", role: "builder", level: Level.NORMAL, brainId: b.id }, { brains: h.brains }),
    /disabled/,
    "kalau lolos, halaman menampilkan pemetaan yang tidak pernah berjalan — kelas kesalahan yang sama dengan agen config-only",
  );
});

test("melepas pemaku mengembalikan sel ke default grid, lalu kandidat level", async () => {
  const h = await buildHarness();
  const b = await h.brains.create({ name: "dipaku", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL });
  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainId: b.id },
    { brains: h.brains },
  );
  await h.brainMap.clear({ template: "software", role: "builder", level: Level.NORMAL });
  assert.deepEqual(await h.brainMap.getCell("software", "builder", Level.NORMAL), []);

  // Default grid (DEFAULT_BRAIN_MAP) mengambil alih sel yang tidak dipaku —
  // asalkan Brain-nya hidup di instance ini.
  const picked = await h.brainMap.resolve({
    template: "software",
    role: "builder",
    level: Level.NORMAL,
    brains: h.brains,
  });
  assert.ok(["default", "level"].includes(picked.source), `sumber tak terduga: ${picked.source}`);
});

// --- daftar terurut (D68) -----------------------------------------------------

test("sel memegang daftar terurut; anggota hidup pertama menang, names membawa semuanya", async () => {
  const h = await buildHarness();
  const pertama = await h.brains.create({ name: "utama", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL });
  const kedua = await h.brains.create({ name: "cadangan", provider: "aliyuncs", model: "qwen3.5-max", level: Level.NORMAL });

  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainIds: [pertama.id, kedua.id] },
    { brains: h.brains },
  );
  const cell = await h.brainMap.getCell("software", "builder", Level.NORMAL);
  assert.deepEqual(
    cell.map((m) => [m.position, m.brainId]),
    [[0, pertama.id], [1, kedua.id]],
    "urutan disimpan sebagai posisi, ditulis ulang dari 0",
  );

  const picked = await h.brainMap.resolve({
    template: "software",
    role: "builder",
    level: Level.NORMAL,
    brains: h.brains,
  });
  assert.equal(picked.source, "pinned");
  assert.equal(picked.candidates[0].brain.name, "utama");
  assert.deepEqual(picked.names, ["utama", "cadangan"], "preferred membawa seluruh daftar, bukan pemenang saja");
  assert.deepEqual(picked.skipped, [], "semua anggota hidup — tidak ada yang diskip");
});

test("anggota yang dimatikan diskip dengan alasan, tapi tetap di names — fail-back otomatis", async () => {
  const h = await buildHarness();
  const utama = await h.brains.create({ name: "sering-habis", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL });
  const cadangan = await h.brains.create({ name: "penengah", provider: "aliyuncs", model: "qwen3.5-max", level: Level.NORMAL });
  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainIds: [utama.id, cadangan.id] },
    { brains: h.brains },
  );

  // Mematikan anggota pertama SETELAH disetel boleh: itu keadaan hidup, bukan
  // konfigurasi. Resolve melompat ke cadangan dan melaporkan kenapa.
  await h.brains.update(utama.id, { enabled: false });
  const picked = await h.brainMap.resolve({
    template: "software",
    role: "builder",
    level: Level.NORMAL,
    brains: h.brains,
  });
  assert.equal(picked.candidates[0].brain.name, "penengah");
  assert.deepEqual(
    picked.skipped.map((s) => [s.name, s.reason]),
    [["sering-habis", "dimatikan"]],
  );
  // Nama yang dimatikan TETAK di names: begitu dihidupkan lagi, ia menang
  // kembali tanpa ada yang menyentuh sel — itulah fail-back tanpa penunjuk.
  assert.deepEqual(picked.names, ["sering-habis", "penengah"]);

  await h.brains.update(utama.id, { enabled: true });
  const revived = await h.brainMap.resolve({
    template: "software",
    role: "builder",
    level: Level.NORMAL,
    brains: h.brains,
  });
  assert.equal(revived.candidates[0].brain.name, "sering-habis", "pemulihan otomatis kembali ke urutan awal");
});

test("seluruh daftar dimatikan ditolak saat disetel — sel yang tidak pernah jalan", async () => {
  const h = await buildHarness();
  const hidup = await h.brains.create({ name: "hidup", provider: "zai", model: "glm-5.2", level: Level.NORMAL });
  const mati = await h.brains.create({ name: "mati", provider: "zai", model: "glm-5.1", level: Level.NORMAL });
  await h.brains.update(mati.id, { enabled: false });

  await assert.rejects(
    () =>
      h.brainMap.set(
        { template: "software", role: "builder", level: Level.NORMAL, brainIds: [mati.id] },
        { brains: h.brains },
      ),
    /disabled/,
    "list satu-anggota yang mati adalah sel yang tidak pernah berjalan",
  );
  // Anggota mati di TENGAH daftar diperbolehkan — ia diskip saat resolve.
  await h.brainMap.set(
    { template: "software", role: "builder", level: Level.NORMAL, brainIds: [hidup.id, mati.id] },
    { brains: h.brains },
  );
  const picked = await h.brainMap.resolve({ template: "software", role: "builder", level: Level.NORMAL, brains: h.brains });
  assert.equal(picked.candidates.length, 1);
});

test("anggota kembar dan anggota tak dikenal ditolak saat disetel", async () => {
  const h = await buildHarness();
  const a = await h.brains.create({ name: "kembar", provider: "zai", model: "glm-5.2", level: Level.NORMAL });
  await assert.rejects(
    () =>
      h.brainMap.set(
        { template: "software", role: "builder", level: Level.NORMAL, brainIds: [a.id, a.id] },
        { brains: h.brains },
      ),
    /duplicate/,
    "daftar failover menyebut tiap peer sekali — kembar hanya memalsukan panjangnya",
  );
  await assert.rejects(
    () =>
      h.brainMap.set(
        { template: "software", role: "builder", level: Level.NORMAL, brainIds: ["BRN-NGACO"] },
        { brains: h.brains },
      ),
    /unknown brain/,
  );
});

test("sel tanpa pemaku dan tanpa default hidup memakai seluruh pool level sebagai daftar", async () => {
  const h = await buildHarness();
  // tester/critical: default grid-nya "qwen-high", yang tidak disemai harness
  // ini → jatuh ke pool level. Pool penuh jadi names: sel yang tak pernah
  // disentuh operator tetap punya rantai failover, bukan satu nama.
  const picked = await h.brainMap.resolve({
    template: "software",
    role: "tester",
    level: Level.CRITICAL,
    brains: h.brains,
  });
  assert.equal(picked.source, "level");
  assert.ok(picked.names.length >= 1);
  assert.equal(picked.names.length, picked.candidates.length, "pool level tidak menyembunyikan anggota");
});

// --- dekomposisi -------------------------------------------------------------

test("rencana software berurut dan tiap fase membawa kategori routingnya", () => {
  const plan = buildPlan({
    request: "Bangun API pemesanan dengan NestJS",
    template: "software",
    levelFor: () => Level.NORMAL,
  });

  assert.deepEqual(
    plan.map((s) => s.role),
    ["analyst", "architect", "builder", "reviewer", "tester", "learner"],
  );
  for (const step of plan) {
    assert.equal(step.category, ROLE_CATEGORY[step.role], `${step.role} harus punya kategori routing`);
    assert.equal(step.qualityClass, LEVEL_TO_QUALITY[Level.NORMAL]);
    // Permintaan asli dibawa UTUH ke setiap fase: meringkasnya per fase membuat
    // tiap fase membaca versi berbeda dari permintaan yang sama.
    assert.match(step.description, /Bangun API pemesanan dengan NestJS/);
  }
});

test("review berjalan sebagai pembaca, implementasi sebagai penulis", () => {
  const plan = buildPlan({ request: "apa saja", template: "software", levelFor: () => Level.NORMAL });
  const byRole = Object.fromEntries(plan.map((s) => [s.role, s]));
  assert.equal(byRole.reviewer.workspaceMode, "read", "penilai tidak boleh menulis ulang yang dinilainya");
  assert.equal(byRole.builder.workspaceMode, "write");
});

test("level per role diambil dari pemanggil, bukan diseragamkan", () => {
  const plan = buildPlan({
    request: "apa saja",
    template: "software",
    levelFor: (role) => (role === "architect" ? Level.CRITICAL : Level.LOW),
  });
  const byRole = Object.fromEntries(plan.map((s) => [s.role, s]));
  assert.equal(byRole.architect.level, Level.CRITICAL);
  assert.equal(byRole.architect.qualityClass, "L5");
  assert.equal(byRole.builder.qualityClass, "L1");
});

test("template tak dikenal tetap menghasilkan rencana, bukan lemparan", () => {
  assert.deepEqual(pipelineFor("entah-apa"), pipelineFor("software"));
});

test("permintaan kosong ditolak", () => {
  assert.throws(() => buildPlan({ request: "   ", template: "software", levelFor: () => Level.NORMAL }), /required/);
});

// --- endpoint control --------------------------------------------------------

test("WORK menolak membuat apa pun selama ada fase tanpa Brain", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    // Default grid (DEFAULT_BRAIN_MAP) kini menengahi resolusi, jadi "tidak ada
    // Brain" harus dibuat sungguhan: seluruh benih katalog dimatikan dulu,
    // lalu hanya tersedia satu Brain normal. Fase critical (analyst, architect,
    // reviewer, learner pada software/balanced) tidak punya pemaku, default
    // grid-nya menunjuk Brain yang dimatikan, dan kandidat levelnya kosong.
    for (const b of await h.brains.list()) {
      await h.brains.update(b.id, { enabled: false });
    }
    await h.brains.create({ name: "cuma-normal", provider: "zai", model: "glm-4.7", level: Level.NORMAL });

    const res = await api.call("POST", "/api/work/control/message", {
      text: "task bangun layanan pemesanan",
      projectId: project.id,
      template: "software",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "WORK");
    assert.equal(res.body.created, false, "rencana setengah jadi harus dibersihkan tangan; jangan buat sebagian");
    assert.match(res.body.reply, /Brain Map/);

    const after = await h.repos.tasks.list({ projectId: project.id, limit: 100 });
    assert.equal(after.length, 0, "tidak satu pun task boleh terbentuk saat rencana ditolak");
  } finally {
    await api.close();
  }
});

test("WORK memecah permintaan menjadi task berantai, hanya fase pertama yang masuk antrian", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  // D29/D35 di jalur WORK: setiap fase kini ditugaskan worker saat
  // dekomposisi — tanpa worker per role, permukaan menolak membuat.
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const api = await startApi(h);
  try {
    await h.brains.create({ name: "normal-brain", provider: "zai", model: "glm-4.7", level: Level.NORMAL });
    const critical = await h.brains.create({
      name: "critical-brain", provider: "zai", model: "glm-5.2", thinking: "max", level: Level.CRITICAL,
    });
    // Dipaku lewat Brain Map supaya yang diuji adalah jalur pemaku itu sendiri,
    // bukan urutan kandidat katalog contoh milik harness.
    await h.brainMap.set(
      { template: "software", role: "architect", level: Level.CRITICAL, brainId: critical.id },
      { brains: h.brains },
    );

    const res = await api.call("POST", "/api/work/control/message", {
      text: "task bangun layanan pemesanan dengan NestJS",
      projectId: project.id,
      template: "software",
    });
    assert.equal(res.body.created, true);
    assert.equal(res.body.tasks.length, 6);

    const tasks = await h.repos.tasks.list({ projectId: project.id, limit: 100 });
    assert.equal(tasks.length, 6);

    // Dilihat dari "sudah dilepas", bukan dari QUEUED: begitu dilepas,
    // scheduler boleh langsung memindahkannya ke WAIT_* atau DISPATCHED, dan
    // memeriksa QUEUED akan menguji kecepatan scheduler, bukan aturan rilis.
    const released = tasks.filter((t) => t.status !== Status.CREATED);
    assert.equal(released.length, 1, "melepas semuanya sekaligus akan memakan worker beberapa project sebelum siapa pun sempat melihat");
    assert.match(released[0].title, /Analisis kebutuhan/);

    // Rantainya nyata, bukan hiasan di balasan.
    const architect = res.body.tasks.find((t) => t.role === "architect");
    const analyst = res.body.tasks.find((t) => t.role === "analyst");
    const deps = await h.repos.tasks.dependencies(architect.taskId);
    assert.deepEqual(deps.map((d) => d.id), [analyst.taskId]);

    // Pemaku Brain Map benar-benar sampai ke model_policy task, bukan berhenti
    // sebagai tampilan di rencana.
    assert.equal(architect.brainSource, "pinned");
    const archTask = await h.repos.tasks.get(architect.taskId);
    assert.deepEqual(archTask.model_policy.preferred, ["critical-brain"]);
    assert.equal(archTask.model_policy.class, Level.CRITICAL);
  } finally {
    await api.close();
  }
});

test("klasifikasi yang tidak yakin menjadi pertanyaan, bukan aksi", async () => {
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/control/message", { text: "TASK-ABCD" });
    assert.equal(res.body.intent, "CONFIRM");
    assert.equal(res.body.tasks.length, 0);
  } finally {
    await api.close();
  }
});

test("komentar task tersimpan di log append-only dan terbaca lewat events", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const task = await h.repos.tasks.create({ projectId: project.id, title: "dikomentari" });
  const api = await startApi(h);
  try {
    const res = await api.call("POST", `/api/work/tasks/${task.id}/comments`, { text: "tolong periksa asumsinya" });
    assert.equal(res.status, 200);

    const events = await api.call("GET", `/api/work/events?subject=${task.id}&kind=task.comment`);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].payload.text, "tolong periksa asumsinya");
  } finally {
    await api.close();
  }
});

test("PUT membaca body — role-levels dan brain-map sama-sama bergantung padanya", async () => {
  // Regresi: `handle` hanya membaca body untuk POST dan PATCH, sehingga
  // `PUT /api/work/role-levels` menolak SETIAP panggilan dengan "template, role
  // and level are required" — sebuah route yang tidak bisa berhasil di input
  // apa pun.
  const h = await buildHarness();
  const api = await startApi(h);
  try {
    const res = await api.call("PUT", "/api/work/role-levels", {
      template: "software",
      profile: "balanced",
      role: "builder",
      level: "critical",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.level, "critical");
  } finally {
    await api.close();
  }
});

test("PUT brain-map menyimpan daftar terurut, dan urutannya sampai ke preferred task", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const utama = await h.brains.create({ name: "list-utama", provider: "zai", model: "glm-5.2", thinking: "high", level: Level.NORMAL });
  const cadangan = await h.brains.create({ name: "list-cadangan", provider: "aliyuncs", model: "qwen3.5-max", level: Level.NORMAL });
  const api = await startApi(h);
  try {
    const put = await api.call("PUT", "/api/work/brain-map", {
      template: "software",
      role: "builder",
      level: "normal",
      brainIds: [utama.id, cadangan.id],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.mapping.map((m) => m.brainId), [utama.id, cadangan.id]);

    const get = await api.call("GET", "/api/work/brain-map?template=software");
    const cell = get.body.mappings.find((m) => m.role === "builder" && m.level === "normal");
    assert.deepEqual(
      cell.brains.map((b) => b.brainName),
      ["list-utama", "list-cadangan"],
      "GET mengelompokkan baris jadi sel dengan daftar terurut",
    );

    // End-to-end: dekomposisi membawa seluruh daftar ke model_policy.preferred
    // — admission yang memilih anggota hidup pertama per dispatch (D68).
    const res = await api.call("POST", "/api/work/control/message", {
      text: "task bangun layanan pemesanan dengan NestJS",
      projectId: project.id,
      template: "software",
    });
    assert.equal(res.body.created, true, JSON.stringify(res.body).slice(0, 300));
    const builder = res.body.tasks.find((t) => t.role === "builder");
    assert.deepEqual(builder.brainList.slice(0, 2), ["list-utama", "list-cadangan"]);
    const task = await h.repos.tasks.get(builder.taskId);
    assert.deepEqual(
      task.model_policy.preferred.slice(0, 2),
      ["list-utama", "list-cadangan"],
      "preferred membawa rantai failover, bukan pemenang saja",
    );

    // Clear lewat [] — dibedakan dari field yang tidak dikirim.
    const cleared = await api.call("PUT", "/api/work/brain-map", {
      template: "software",
      role: "builder",
      level: "normal",
      brainIds: [],
    });
    assert.equal(cleared.status, 200);
    assert.equal((await h.brainMap.getCell("software", "builder", "normal")).length, 0);
  } finally {
    await api.close();
  }
});

test("PUT brain-map menolak daftar kembar tanpa menyentuh sel yang ada", async () => {
  const h = await buildHarness();
  const a = await h.brains.create({ name: "asli", provider: "zai", model: "glm-5.2", level: Level.NORMAL });
  const b = await h.brains.create({ name: "kembar-put", provider: "aliyuncs", model: "qwen3.5-max", level: Level.NORMAL });
  const api = await startApi(h);
  try {
    await api.call("PUT", "/api/work/brain-map", {
      template: "software", role: "builder", level: "normal", brainIds: [a.id],
    });
    const dup = await api.call("PUT", "/api/work/brain-map", {
      template: "software", role: "builder", level: "normal", brainIds: [b.id, b.id],
    });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error ?? "", /duplicate/);
    const cell = await h.brainMap.getCell("software", "builder", "normal");
    assert.deepEqual(cell.map((m) => m.brainId), [a.id], "sel yang ditolak tidak berubah");
  } finally {
    await api.close();
  }
});

// Ditemukan live 2026-09-05: tombol "Create plans" Command Center mengirim
// teks berawalan "WORK: …" dan controller menjawab CONFIRM "could not
// classify" — prefix deklarasi tidak dikenal classifier. Kedua tes ini
// mengunci jalur yang benar lewat HTTP, bukan cuma lewat classify().
test("WORK: dari Command Center terdekomposisi tanpa terjebak CONFIRM", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  // Dekomposisi menugaskan worker per fase (D29/D35) — sediakan agar jalur
  // yang diuji adalah prefix intent, bukan penolakan karena tak ada worker.
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const api = await startApi(h);
  try {
    await h.brains.create({ name: "normal-brain", provider: "zai", model: "glm-4.7", level: Level.NORMAL });
    await h.brains.create({ name: "critical-brain", provider: "zai", model: "glm-5.2", thinking: "max", level: Level.CRITICAL });

    const res = await api.call("POST", "/api/work/control/message", {
      text:
        "WORK: Baca semua dokumen di memory/blueprint.md, memory/decisions.md, dan docs/brief.md (jika ada). " +
        "Berdasarkan dokumen-dokumen tersebut, buat rencana implementasi. Tulis hasilnya ke docs/plans.md.",
      projectId: project.id,
      force: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "WORK", JSON.stringify(res.body).slice(0, 200));
    assert.equal(res.body.created, true, `harus terdekomposisi: ${res.body.reply?.slice(0, 120)}`);
    // Payload tanpa prefix: fase tidak boleh membaca sisa "WORK:" di
    // deskripsinya.
    const first = res.body.tasks[0];
    assert.ok(!first.title.includes("WORK:"), `prefix bocor ke judul: ${first.title}`);
  } finally {
    await api.close();
  }
});

test("TASK: dari Command Center membuat TEPAT SATU task di project terpilih", async () => {
  const h = await buildHarness();
  const { project, worker } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/control/message", {
      text: "TASK: Perbaiki bug kecil pada footer",
      projectId: project.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "TASK", JSON.stringify(res.body).slice(0, 200));
    assert.match(res.body.taskId, /^TASK-/, "route melaporkan id task yang baru dibuat");

    const tasks = await h.repos.tasks.list({ projectId: project.id, limit: 100 });
    assert.equal(tasks.length, 1, "TASK: harus membuat satu task langsung, bukan rantai fase");
    assert.equal(tasks[0].project_id, project.id);
    assert.equal(tasks[0].worker_id, worker.id, "task harus ditugaskan ke worker project ini");
    assert.match(tasks[0].title, /^Perbaiki bug kecil/, "kata pertama deskripsi tidak boleh terpotong");
  } finally {
    await api.close();
  }
});

// PREPARE: satu task analyst untuk dokumen rencana — tanpa rantai
// dekomposisi (D47). Level, Brain, dan worker mengikuti aturan yang sama
// dengan fase analyst dekomposisi.
test("PREPARE: membuat SATU task analyst ber-brain, dan menolak tanpa worker analyst", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  for (const role of ["analyst", "architect", "builder", "reviewer", "tester", "learner"]) {
    await h.repos.workers.create({ role, agentRef: `w-${role}`, projectAccess: [project.id] });
  }
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/control/message", {
      text: "PREPARE: Baca semua dokumen di memory/blueprint.md dan docs/brief.md. Buat docs/plans.md dan docs/tasks.md.",
      projectId: project.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "PREPARE", JSON.stringify(res.body).slice(0, 200));
    assert.match(res.body.taskId, /^TASK-/);

    const tasks = await h.repos.tasks.list({ projectId: project.id, limit: 100 });
    assert.equal(tasks.length, 1, "PREPARE membuat tepat satu task, bukan rantai fase");
    const task = tasks[0];
    assert.equal(task.worker_id, (await h.repos.workers.list()).find((w) => w.role === "analyst")?.id);
    assert.equal(task.model_policy.class, "critical", "analyst pada software/balanced adalah critical");
    assert.deepEqual(task.model_policy.preferred, ["glm-5-2-max"], "Brain analyst dari grid/Brain Map");
  } finally {
    await api.close();
  }
});

test("PREPARE: tanpa worker analyst ditolak dengan alasan yang bisa ditindaklanjuti", async () => {
  const h = await buildHarness();
  const { project } = await seedBasics(h);
  const api = await startApi(h);
  try {
    const res = await api.call("POST", "/api/work/control/message", {
      text: "PREPARE: Buat docs/plans.md dan docs/tasks.md dari dokumen yang ada.",
      projectId: project.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, "PREPARE");
    assert.equal(res.body.taskId, null);
    assert.match(res.body.reply, /analyst/);
    const tasks = await h.repos.tasks.list({ projectId: project.id, limit: 100 });
    assert.equal(tasks.length, 0, "penolakan tidak meninggalkan task setengah jadi");
  } finally {
    await api.close();
  }
});
