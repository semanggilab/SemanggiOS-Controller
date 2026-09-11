// POC-10 T2 — pool sandbox chat `sem-chat-*`.
//
// Menuruni pagar D80/D81 TANPA menyentuh sandbox-provision.mjs: jalur task
// tidak boleh berubah perilaku karena chat lahir. Yang DICOPLAK vs yang
// SENGAJA BERBEDA:
//
//   Sama (D80):  harness tidak pernah; tanpa baris resources → tolak
//                `no-resource-entry`; kegagalan create kembali sebagai
//                {ok:false, why}, tidak pernah throw ke pemanggil.
//   Beda (§10.3): kapasitas HANYA dari resources.chat_concurrency_limit —
//                concurrency_limit task tidak pernah dibaca di sini. Kuota
//                chat dan kuota task dua kebijakan; menyatukannya kembali
//                membatalkan keputusan operator yang memisahkannya.
//   Beda (§5):    workspace = projects.workspace_path SUNGGUHAN — inilah
//                satu-satunya perbedaan fungsional dari D80 dan alasan
//                POC-10 ada (spike E1/D92 membuktikan gateway menerimanya).
//   Beda (D81):   TIDAK ada keeper/reaper. Prefiks `sem-chat-` memang tidak
//                cocok pemangkasan lantai (AUTO_PREFIX="sem-auto-"), dan
//                pelepasan selalu manual lewat Process Manager D78 — baris
//                di sini dibersihkan malas: pesan berikutnya menemukan agen
//                mati, membuang barisnya, dan memprovisikan ulang (§11).
import { shortId } from "./repositories.mjs";
import { isHarnessProvider } from "./harness.mjs";
import { agentsForModel } from "./sandbox-provision.mjs";

const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const CHAT_AGENT_PREFIX = "sem-chat-";

export function createChatSandbox({ repos, runtime, events, log, now = () => Date.now() }) {
  const liveAgents = async () => (await runtime?.listAgents?.().catch(() => [])) ?? [];

  async function capFor(provider, model) {
    const resource = await repos.resources.get(provider, model);
    // chat_concurrency_limit NOT NULL DEFAULT 1 — baris tanpa batas tidak ada;
    // yang ada hanyalah baris yang belum pernah ada (parkir/tolak biasa).
    return resource ? Number(resource.chat_concurrency_limit ?? 1) : null;
  }

  // Agen chat hidup untuk satu (provider, model) — HANYA sem-chat-*, bukan
  // armada penuh: dua kuota memang dipisah (§10.3), dan menghitung agen task
  // ke arah batas chat menyatukan mereka kembali diam-diam.
  const chatAgentsForModel = (provider, model, live) =>
    agentsForModel({ provider, model }, live).filter((a) => String(a?.name ?? "").startsWith(CHAT_AGENT_PREFIX));

  async function provision({ project, brain, actor = "system", reason }) {
    if (isHarnessProvider(brain.provider)) {
      return { ok: false, why: "acp-harness" };
    }
    if (typeof runtime?.createProbeAgent !== "function") {
      return { ok: false, why: "no-provisioning" };
    }
    const cap = await capFor(brain.provider, brain.model);
    if (cap == null) return { ok: false, why: "no-resource-entry" };
    const live = await liveAgents();
    const current = chatAgentsForModel(brain.provider, brain.model, live).length;
    if (current >= cap) return { ok: false, why: "cap-full", live: current, cap };

    // Workspace = milik project, persis, tanpa akhiran. Ini bukan lupa
    // memakai probeWorkspaceFor: agen chat harus melihat dokumen yang operator
    // lihat, jadi path-nya tidak boleh "direlokasi demi jalan" — lihat
    // penanganan error legacy di bawah.
    const workspace = project.workspace_path;
    let name = `${CHAT_AGENT_PREFIX}${slug(project.name)}-${slug(brain.name)}`.slice(0, 63).toLowerCase();
    let created;
    try {
      created = await runtime.createProbeAgent({ name, workspace, model: `${brain.provider}/${brain.model}` });
    } catch (err) {
      const msg = String(err.message ?? "");
      // Dua kunci keadaan gateway 2026.8 (terukur D81/D92). Variasi nama
      // berakhiran -r<short> untuk keduanya: nama deterministik boleh bergeser
      // (identitas pool tetap baris DB), tapi workspace TIDAK — di sini ia
      // adalah KOSAKATA chat, bukan detail teknis.
      if (/deletion cleanup is still pending/.test(msg) || /already exists/i.test(msg)) {
        name = `${name}-r${shortId("R")}`.slice(0, 63).toLowerCase();
        try {
          created = await runtime.createProbeAgent({ name, workspace, model: `${brain.provider}/${brain.model}` });
        } catch (retryErr) {
          // Satu percobaan ulang saja, dan kegagalannya TIDAK boleh lewat
          // sebagai throw: resolveChatSandbox dipanggil dari jalur pesan —
          // operator mendapat {ok:false, why}, bukan 500.
          log.warn("chat.sandbox-retry-failed", { name, error: String(retryErr.message ?? retryErr).slice(0, 160) });
          return { ok: false, why: "create-failed", error: String(retryErr.message ?? retryErr).slice(0, 200) };
        }
        log.warn("chat.sandbox-renamed", { name, brain: brain.name, hint: "gateway name lock; identity lives in the DB row, not the agent name" });
      } else if (/Legacy workspace setup state/.test(msg)) {
        // BEDA dari D80 dengan sengaja: relokasi path memindahkan agen keluar
        // dari project — chat yang "berhasil" tapi tidak bisa membaca dokumen
        // project adalah kegagalan yang menyamar. Operator memperbaiki
        // workspace-nya (openclaw doctor --fix), provisioning menunggu.
        log.warn("chat.sandbox-legacy-workspace", {
          workspace, project: project.id,
          hint: "openclaw doctor --fix reclaims the stale agent dir; the chat workspace must stay the project's",
        });
        return { ok: false, why: "legacy-workspace-state", error: msg.slice(0, 200) };
      } else {
        return { ok: false, why: "create-failed", error: msg.slice(0, 200) };
      }
    }

    const row = await repos.chatSandboxes.upsert({
      projectId: project.id,
      brainId: brain.id,
      agentId: created.id ?? name,
      provider: brain.provider,
      model: brain.model,
    });
    await events.append({
      kind: "chat.sandbox-provisioned",
      subjectType: "chat_sandbox",
      subjectId: `${project.id}:${brain.id}`,
      actor,
      payload: { agentId: row.agent_id, name, workspace, model: `${brain.provider}/${brain.model}`, reason: reason ?? null },
    });
    log.info("chat.sandbox-provisioned", { project: project.id, brain: brain.name, agentId: row.agent_id, name, workspace });
    return { ok: true, reused: false, agentId: row.agent_id, name, workspace, sandbox: row };
  }

  /**
   * Satu-satunya pintu masuk jalur pesan (T3). Tiga keadaan, urut termurah:
   *
   *   1. baris + agen hidup  → pakai ulang, bump last_used_at. Dua sesi pada
   *      (project, brain) sama berbagi agen ini — masing-masing tetap punya
   *      gateway_session_ref sendiri (§6).
   *   2. baris + agen mati   → buang baris, provision ulang. Agen mati lewat
   *      kill operator (D78) atau drift; keduanya fakta armada, dan pesan
   *      berikutnya harus jalan, bukan gagal (§11).
   *   3. tanpa baris         → provision (dengan seluruh pagar provision()).
   *
   * Catatan D92: agents.list tertinggal beberapa detik di belakang mutasi,
   * jadi "agen hidup" di sini adalah keyakinan saat baca — dispatch ke agen
   * yang baru saja mati gagal di jalur pesan, dan pemanggil T3 yang
   * memprovisikan ulang sekali lagi. Tidak ada parkir: chat tidak punya state
   * machine task untuk diparkirkan.
   */
  async function resolveChatSandbox({ project, brain, actor = "system", reason }) {
    const row = await repos.chatSandboxes.get(project.id, brain.id);
    if (row) {
      const live = await liveAgents();
      const agent = live.find((a) => String(a?.id ?? "") === String(row.agent_id));
      if (agent) {
        const touched = await repos.chatSandboxes.touch(project.id, brain.id);
        return { ok: true, reused: true, agentId: row.agent_id, name: String(agent.name ?? ""), sandbox: touched };
      }
      log.info("chat.sandbox-stale-row", { project: project.id, brain: brain.id, agentId: row.agent_id });
      await repos.chatSandboxes.remove(project.id, brain.id);
    }
    return provision({ project, brain, actor, reason });
  }

  return { resolveChatSandbox, provision, chatAgentsForModel };
}
