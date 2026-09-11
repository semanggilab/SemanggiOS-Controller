// scripts/spike-poc10-e1.mjs — POC-10 §9, spike E1: workspace ARBITRARY pada agents.create
//
// SATU pertanyaan, dijawab dengan permintaan nyata (aturan D34/D38/D41: kontrak
// upstream diverifikasi dengan MENGIRIM permintaan, bukan membaca source):
// apakah `agents.create` di gateway ini menerima workspace absolut yang
// ARBITRARY — workspace project sungguhan — alih-alih hanya konvensi probe
// (.../workspaces/probe/<provider>) yang diasumsikan probeWorkspaceFor() (D65)?
//
// POC-10 membutuhkannya karena sandbox chat harus mount workspace project
// sungguhan (spec POC-10 §5.1). Bila gateway memvalidasi path workspace
// terhadap konvensinya sendiri, desain pool chat berubah bentuk SEBELUM satu
// baris kode produksi ditulis — itu sebabnya spike ini gerbang Tahap 0.
//
// Tiap langkah dibuktikan balisannya sendiri, tidak ada asumsi:
//   1. connect + sessions.subscribe (identitas device controller, scopes
//      operator.admin — jalur yang sama dengan provisioning D80 yang hidup)
//   2. agents.create {name: sem-chat-e1-*, workspace: <project>, model}
//   3. agents.list — agen harus muncul dengan workspace PERSIS (kebenaran
//      operabilitas adalah daftar armada, D32; bukan balasan create, D85)
//   4. SATU dispatch minimal (agent.run/agent, sesuai iklan hello) — agen di
//      workspace asing harus bisa MENJALANKAN run, bukan sekadar ada
//   5. tunggu bukti run: balasan asisten via session.message (D15) +
//      polling sessions.describe sebagai jalur lambat
//   6. agents.delete
//   7. agents.create NAMA SAMA sekali lagi — mencatat apakah kunci nama
//      deletion-cleanup (terukur 2026-09-08, D81) juga berlaku di sini
//
// Jalankan dalam container controller (jaringan + secret + identitas device):
//   docker cp scripts/spike-poc10-e1.mjs <cid>:/tmp/
//   docker exec <cid> bun /tmp/spike-poc10-e1.mjs \
//     --workspace /opt/.../openclaw/workspaces/<project> --model google/gemini-3.1-flash-lite
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pohon sumber yang berjalan (controller-src di NFS). Spike sengaja memakai
// salinan PRODUKSI — yang diuji kontraknya adalah runtime yang sama dengan
// yang hidup, bukan salinan lokal yang bisa saja berbeda.
const SRC = arg("src", "/opt/semanggi/volumes/shared/service/semanggios/controller-src");
// pathToFileURL jangan lewat path.resolve dulu — resolve memangkas trailing
// slash, dan URL relative tanpa slash akan MENGGANTI segmen terakhir alih-alih
// menggantung di bawahnya (mode pertama spike gagal persis di sini).
const srcUrl = pathToFileURL(`${resolve(SRC)}/`);
const { createGatewayRuntime } = await import(new URL("src/runtime/gateway-ws.mjs", srcUrl).href);

const url = arg("url", process.env.SEMANGGI_GATEWAY_URL ?? "ws://openclaw-gateway:18789");
const tokenFile = arg("token-file", process.env.SEMANGGI_GATEWAY_TOKEN_FILE ?? "/run/secrets/openclaw_gateway_token");
const token = readFileSync(tokenFile, "utf8").trim();
const workspace = arg("workspace");
const model = arg("model", "google/gemini-3.1-flash-lite");
const keep = process.argv.includes("--keep");

if (!workspace || !workspace.startsWith("/")) {
  console.error("--workspace <path absolut> wajib (workspace project sungguhan, bukan pola probe)");
  process.exit(2);
}

const stamp = Date.now().toString(36).toLowerCase();
const name = `sem-chat-e1-${stamp}`.slice(0, 63);
const idem = `e1-${stamp}`;
// Dibangun SETELAH create dari agentId balasan gateway — id diturunkan dari
// nama di sisi server dan itulah yang diminta sessionKey (gateway-ws.mjs:
// "keyed on the agent that WILL run … the gateway lowercases agent ids").
let sessionKey = null;

const replies = [];
const sessionEventNames = new Set();
let lifecycleEnd = null;
const onEvent = (evtName, payload) => {
  try {
    const key = payload?.sessionKey ?? payload?.session?.key ?? null;
    if (sessionKey && key === sessionKey) {
      sessionEventNames.add(evtName);
      const msg = payload?.message;
      if (evtName === "session.message" && msg?.role) {
        // content bisa berupa teks ATAU struktur blok — run pertama spike
        // mencetak "[object Object]" karena String() mentah; ekstrak teks
        // best-effort supaya bukti di laporan terbaca manusia.
        const c = msg.content;
        let text;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) text = c.map((b) => b?.text ?? JSON.stringify(b)).join("");
        else text = JSON.stringify(c);
        replies.push({ role: msg.role, content: String(text ?? "").slice(0, 400) });
      }
    }
    // D82: end {stopReason:"length"} prematur bisa digantikan koreksi "stop"
    // ~400ms kemudian — simpan yang TERAKHIR, bukan yang pertama.
    if (payload?.runId === idem && payload?.stream === "lifecycle" && payload?.data?.phase === "end") {
      lifecycleEnd = payload.data;
    }
  } catch {}
};

const report = { spike: "POC-10 E1", workspace, model, name, url, steps: {} };
const runtime = createGatewayRuntime({ url, token, version: "poc10-e1-spike", onEvent });

// Mutasi agen di gateway ini EVENTUALLY CONSISTENT terhadap agents.list —
// terukur pada run pertama spike: create diterima, list seketika masih kosong,
// delete menjawab "not found" sementara create ulang menjawab "already exists"
// (bentuk ekstrem dari catatan D81 "agents.list tertinggal beberapa detik").
// Setiap kesimpulan tentang armada dipoll, tidak dibaca sekali.
const findAgent = async (agentId) => {
  const agents = (await runtime.request("agents.list", {}).catch(() => ({ agents: [] })))?.agents ?? [];
  return agents.find((a) => a.id === agentId || a.name === name) ?? null;
};
const waitForAgent = async (agentId, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findAgent(agentId);
    if (found) return found;
    await sleep(1_500);
  }
  return null;
};
const deleteWithRetry = async (agentId, tries = 4) => {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await runtime.request("agents.delete", { agentId }, { timeoutMs: 30_000 });
      return { ok: true, attempt: i, removedBindings: r?.removedBindings ?? null, purgeFailed: Boolean(r?.purgeFailed) };
    } catch (err) {
      if (i === tries) return { ok: false, error: String(err.message ?? err).slice(0, 300) };
      await sleep(3_000);
    }
  }
};

try {
  const hello = await runtime.connect();
  report.steps.connect = { ok: true, protocol: hello?.protocol ?? null, scopes: hello?.auth?.scopes ?? [] };
  await runtime.request("sessions.subscribe", {}).then(
    (r) => { report.steps.subscribe = { ok: true, raw: r }; },
    (err) => { report.steps.subscribe = { ok: false, error: String(err.message ?? err) }; },
  );

  // (2) create — inti pertanyaan E1. Dipanggil langsung (bukan lewat
  // createProbeAgent) supaya payload mentahnya — termasuk field `status` —
  // ikut terekam; balisan itu bagian dari bukti.
  try {
    const payload = await runtime.request("agents.create", { name, workspace, model });
    sessionKey = `agent:${payload?.agentId ?? payload?.id ?? name}:poc10-e1:${stamp}`.toLowerCase();
    report.steps.create = { ok: true, agentId: payload?.agentId ?? payload?.id ?? name, raw: payload };
  } catch (err) {
    report.steps.create = { ok: false, error: String(err.message ?? err).slice(0, 400) };
  }

  // (3) verifikasi armada — DIPOLL sampai agen muncul (konsistensi eventual).
  if (report.steps.create.ok) {
    const found = await waitForAgent(report.steps.create.agentId);
    report.steps.list = found
      ? {
          ok: found.workspace === workspace,
          agentId: found.id,
          name: found.name,
          workspace: found.workspace,
          workspaceMatches: found.workspace === workspace,
          model: found.model?.primary ?? null,
        }
      : { ok: false, error: "agen tidak muncul di agents.list dalam 20 dtk setelah create" };
  }

  // (4) dispatch minimal — field hasil terukur (gateway-ws.mjs D14/D20):
  // message/idempotencyKey/agentId/sessionKey/label/deliver:boolean. TANPA
  // thinking — agen memakai defaultnya; spike tidak menguji effort.
  if (report.steps.list?.ok) {
    const methods = hello?.features?.methods ?? [];
    const runMethod = ["agent.run", "agent"].find((m) => methods.includes(m)) ?? "agent.run";
    try {
      const payload = await runtime.request(runMethod, {
        message: "POC-10 E1 connectivity spike. Reply with exactly: E1-OK",
        idempotencyKey: idem,
        agentId: report.steps.create.agentId,
        sessionKey,
        label: "POC10-E1",
        deliver: false,
      });
      report.steps.dispatch = { ok: true, method: runMethod, payload };
    } catch (err) {
      report.steps.dispatch = { ok: false, error: String(err.message ?? err).slice(0, 400) };
    }
  }

  // (5) bukti run: balasan asisten adalah bukti terkuat; describe jalur lambat.
  if (report.steps.dispatch?.ok) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(5_000);
      const describe = await runtime.request("sessions.describe", { key: sessionKey }, { timeoutMs: 30_000 }).then(
        (r) => r,
        (err) => ({ error: String(err.message ?? err).slice(0, 200) }),
      );
      report.steps.describe = { key: sessionKey, raw: JSON.stringify(describe).slice(0, 600) };
      if (replies.some((r) => r.role === "assistant")) break;
    }
    report.steps.runEvidence = {
      assistantReplies: replies.filter((r) => r.role === "assistant"),
      lifecycleEnd,
      sessionEventNames: [...sessionEventNames],
    };
  }

  // (6)+(7) cleanup & kunci nama. Kegagalan recreate dengan nama sama adalah
  // DATA (kunci deletion-cleanup D81), bukan kegagalan E1. Delete memakai
  // retry karena "not found" seketika setelah create adalah artefak konsistensi
  // eventual, bukan kondisi akhir.
  if (!keep && report.steps.create.ok) {
    report.steps.delete = await deleteWithRetry(report.steps.create.agentId);
    await sleep(3_000); // beri waktu pembersihan asinkron gateway sebelum nama diuji
    try {
      const payload = await runtime.request("agents.create", { name, workspace, model });
      report.steps.recreateSameName = {
        ok: true,
        agentId: payload?.agentId ?? payload?.id ?? name,
        raw: payload,
        note: "nama TIDAK terkunci setelah delete",
      };
      await deleteWithRetry(report.steps.recreateSameName.agentId);
    } catch (err) {
      report.steps.recreateSameName = {
        ok: false,
        error: String(err.message ?? err).slice(0, 300),
        note: "kemungkinan kunci deletion-cleanup (D81) — dicatat, bukan kegagalan E1",
      };
    }
    // Pemeriksaan akhir: tidak boleh ada agen spike yang tertinggal. Kalau
    // masih ada, coba sapu sekali lagi lewat jalur yang sama.
    let leftovers = (await findAgent(report.steps.create.agentId)) ? [report.steps.create.agentId] : [];
    report.steps.leftovers = [];
    for (const id of leftovers) {
      await deleteWithRetry(id);
      report.steps.leftovers.push({ id, swept: !(await findAgent(id)) });
    }
  }
} finally {
  await runtime.close().catch(() => null);
}

// Vonis E1 HANYALAH tentang workspace arbitrary: create diterima DAN armada
// menyebut workspace yang persis. Dispatch adalah bukti tambahan bahwa agen di
// workspace asing juga operabel — penting untuk POC-10, bukan syarat E1.
const core = Boolean(report.steps.create?.ok && report.steps.list?.ok);
report.verdict = core ? "PASS" : "FAIL";
report.verdictDetail = core
  ? `agents.create menerima workspace arbitrary; agents.list menyebut workspace yang persis (${workspace})`
  : "gateway menolak atau salah mencatat workspace arbitrary — POC-10 tidak boleh menulis kode provisioning sebelum ini dijawab";
console.log(JSON.stringify(report, null, 2));
process.exit(core ? 0 : 1);
