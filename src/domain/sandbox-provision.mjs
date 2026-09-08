// D80 — provisioning sandbox otomatis: lantai per Brain + on-demand admission.
//
// Ini MEMBALIK keputusan lama "PROVISIONING STAYS A SCRIPT" (agent-registry,
// D32/D78) atas permintaan eksplisit operator: task yang parkir karena tidak
// ada agen harus menumbuhkan agennya sendiri, dan Brain boleh meminta lantai
// (minimum) sandbox hidup. Alasan kebalikan tetap memakai fakta yang sama:
// `agents.create` admin-gated dan controller memegang admin (terverifikasi
// D78), jadi yang menghalangi selama ini adalah kebijakan, bukan kemampuan.
// Kebijakan diganti dengan pagar, bukan dihapus:
//
//   1. claude-code TIDAK PERNAH di-provision otomatis — agennya dipaku
//      routing (acpAgent), bukan diciptakan per model (D78 menolak hal sama
//      di jalur operator).
//   2. Batas atas = resources.concurrency_limit untuk (provider, model) —
//      batas yang sama yang dipakai admission untuk konkurensi run, jadi
//      "berapa agen boleh hidup" tidak pernah melebihi "berapa run boleh
//      jalan". Tanpa baris resource, TIDAK ada provisioning: task tetap
//      parkir WAIT_RESOURCE seperti sebelum D80 (operator belum menyatakan
//      model ini boleh punya armada).
//   3. Nama selalu berprefiks sem-auto- supaya asal-usulnya terbaca di
//      inventaris dan armada hygiene (reap-agents mencocokkan ^(sem|semanggi)-).
//   4. Semua kegagalan provisioning kembali sebagai {created:false, why},
//      tidak pernah throw ke pemanggil — provisioning adalah upaya tambahan
//      di atas parkir yang sudah benar, bukan penggantinya.
import { shortId } from "./repositories.mjs";
import { Status } from "./state-machine.mjs";

const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// D65: workspace probe HARUS absolut — kontrak mount menyamakan path host dan
// container, workspace relatif adalah agen yang diam-diam bekerja di mana-mana.
// Konvensi dipelajari dari armada probe hidup (.../workspaces/probe/<provider>);
// akar konvensional hanya untuk armada tanpa probe tersisa untuk ditiru.
export function probeWorkspaceFor(live, provider) {
  const anyProbe = live.find(
    (a) =>
      String(a?.id ?? "").startsWith("sem-workspaces-probe-") &&
      String(a?.workspace ?? "").includes("/workspaces/probe/"),
  );
  if (anyProbe) {
    const parts = String(anyProbe.workspace).replace(/\/+$/, "").split("/");
    parts[parts.length - 1] = slug(provider);
    return parts.join("/");
  }
  const root = process.env.SEMANGGI_PROBE_WORKSPACE_ROOT ??
    "/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces";
  return `${root}/probe/${slug(provider)}`;
}

// Agen hidup untuk sebuah (provider, model) — armada penuh, lintas Brain,
// karena dua Brain provider+model-sama berbagi pool agen yang sama (D79
// menemukan dedupe ini di overview). claude-code selalu kosong: agen harness
// ACP dipaku routing, tidak pernah diciptakan per model.
export function agentsForModel({ provider, model }, liveAgents) {
  if (provider === "claude-code") return [];
  const target = `${provider}/${model}`.toLowerCase();
  return liveAgents.filter((a) => String(a?.model?.primary ?? "").toLowerCase() === target);
}

// Agen yang sedang dipakai task hidup, per agent_ref — aturan yang sama dengan
// kill operator D78: sandbox yang sedang bekerja tidak dipotong. Pindah ke
// modul ini karena pemangkasan lantai (D81) butuh jawaban yang sama, dan dua
// salinan aturan "sibuk" akan berbeda pendapat tepat saat task sedang berjalan.
export async function busyAgentsByRef(repos) {
  const busy = new Map(); // agent_ref -> { taskId, projectId }
  for (const status of [Status.DISPATCHED, Status.RUNNING]) {
    for (const task of await repos.tasks.list({ status, limit: 10_000 })) {
      if (!task.worker_id) continue;
      const worker = await repos.workers.get(task.worker_id);
      if (worker && !busy.has(worker.agent_ref)) {
        busy.set(worker.agent_ref, { taskId: task.id, projectId: task.project_id });
      }
    }
  }
  return busy;
}

const AUTO_PREFIX = "sem-auto-";

export function createSandboxProvision({ brains, runtime, repos, events, log, now = () => Date.now() }) {
  const liveAgents = async () => (await runtime?.listAgents?.().catch(() => [])) ?? [];

  async function capFor(brain) {
    const resource = await repos.resources.get(brain.provider, brain.model);
    // concurrency_limit NOT NULL DEFAULT 1 di schema — baris tanpa batas tidak
    // ada; yang ada hanyalah baris yang belum pernah ada, dan itu parkir biasa.
    return resource ? resource.concurrency_limit : null;
  }

  async function createOne(brain, { name, reason, actor }) {
    const live = await liveAgents();
    const workspace = `${probeWorkspaceFor(live, brain.provider)}-${name}`;
    const model = `${brain.provider}/${brain.model}`;
    const created = await runtime.createProbeAgent({ name, workspace, model });
    await events.append({
      kind: "brain.sandbox-auto-created",
      subjectType: "brain",
      subjectId: brain.id,
      actor,
      payload: { agentId: created.id, name, workspace, model, reason },
    });
    log.info("brain.sandbox-auto-created", { brain: brain.name, agentId: created.id, name, workspace, reason, by: actor });
    return { id: created.id, name, workspace, model };
  }

  /**
   * Jalur on-demand (D80): dipanggil admission saat dispatch gagal karena
   * tidak ada agen untuk kandidat yang sudah dipilih. Membuat SATU agen bila
   * semua pagar lolos; task tetap parkir WAIT_RESOURCE dan percobaan berikut
   * (nextRetryAt pendek) yang memakai agen baru — provisioning tidak pernah
   * men-rewrite hasil admission.
   */
  async function maybeProvisionForBrain({ candidate, reason }) {
    if (typeof runtime?.createProbeAgent !== "function") {
      return { created: false, why: "no-provisioning" };
    }
    const [brain] = (await brains.list({ enabledOnly: true })).filter(
      (b) => b.provider === candidate.provider && b.model === candidate.model,
    );
    if (!brain) return { created: false, why: "no-brain" };
    if (brain.provider === "claude-code") return { created: false, why: "claude-code" };
    const cap = await capFor(brain);
    if (cap == null) return { created: false, why: "no-resource-entry" };
    const live = await liveAgents();
    const current = agentsForModel(brain, live).length;
    if (current >= cap) return { created: false, why: "cap-full", live: current, cap };
    // Nama unik per kejadian: dua task yang parkir bersamaan pada model yang
    // sama adalah dua kebutuhan dua sandbox, dan gateway menganggap nama
    // deterministik sebagai agen yang sama. lower-case seluruhnya — konvensi
    // nama operator D78 slug-kan apa pun, dan armada hygiene membaca prefiks,
    // bukan casing.
    const name = `sem-auto-${slug(brain.name)}-${shortId("SBX")}`.toLowerCase().slice(0, 63);
    try {
      const agent = await createOne(brain, { name, reason, actor: "system" });
      return { created: true, agent, live: current, cap };
    } catch (err) {
      return { created: false, why: "create-failed", error: String(err.message ?? err) };
    }
  }

  /**
   * Rekonsiliasi SATU model (D80 grow + D81 trim). Lantai efektif sebuah
   * model = MAX min_sandboxes brain AKTIF yang memakai model itu — dua brain
   * berbagi pool agen yang sama (D79), jadi memangkas demi lantai brain B
   * akan membocorkan lantai brain A. Di atas lantai: pangkas hanya agen
   * `sem-auto-*` yang IDLE (aturan busy = aturan kill operator D78); agen
   * operator dan probe tidak pernah disentuh — bentuk armada non-otomatis
   * tetap keputusan manusia. Ephemeral mati duluan (sbx- lahir on-demand,
   * lalu slot bernomor besar) supaya inti stabil slot 1..N bertahan dan pass
   * keeper berikutnya tidak menumbuhkan apa pun.
   */
  async function reconcileModel(provider, model, { actor = "keeper", reason = "keeper pass" } = {}) {
    if (typeof runtime?.listAgents !== "function") return { provider, model, skipped: "no-runtime" };
    const enabled = (await brains.list({ enabledOnly: true })).filter(
      (b) => b.provider === provider && b.model === model && b.provider !== "claude-code",
    );
    const floor = enabled.reduce((m, b) => Math.max(m, b.minSandboxes ?? 0), 0);
    const governor = enabled.find((b) => (b.minSandboxes ?? 0) === floor) ?? null;
    const out = { provider, model, floor, live: 0, created: [], killed: [], skippedBusy: [], why: [] };

    const cap = await capFor({ provider, model });
    const live = await liveAgents();
    const fleet = agentsForModel({ provider, model }, live);
    let count = fleet.length;
    out.live = count;

    if (count < floor && typeof runtime.createProbeAgent !== "function") {
      out.why.push("no-provisioning");
      return out;
    }
    if (count < floor && cap == null) {
      out.why.push("no-resource-entry");
      return out;
    }

    if (count < floor) {
      const taken = new Set(live.map((a) => String(a?.name ?? "")));
      const base = slug(governor.name);
      for (let slot = 1; slot <= floor && count < floor; slot++) {
        if (count >= cap) {
          out.why.push("cap-full");
          break;
        }
        const name = `${AUTO_PREFIX}${base}-${slot}`.slice(0, 63);
        if (taken.has(name)) continue;
        try {
          const agent = await createOne(governor, { name, reason, actor });
          live.push({ id: agent.id, name, model: { primary: `${provider}/${model}` } });
          taken.add(name);
          count++;
          out.created.push(name);
        } catch (err) {
          out.why.push(`create-failed:${String(err.message ?? err)}`);
          break;
        }
      }
    }

    if (count > floor && typeof runtime.deleteAgent === "function") {
      const ours = fleet.filter((a) => String(a?.name ?? "").startsWith(AUTO_PREFIX));
      const busy = await busyAgentsByRef(repos);
      // sbx- (on-demand) sebelum slot keeper, nomor slot besar sebelum kecil.
      const rank = (a) => {
        const name = String(a.name);
        const slot = name.match(/-(\d+)$/);
        return (name.includes("-sbx-") ? 1_000_000 : 0) + (slot ? Number(slot[1]) : 0);
      };
      ours.sort((a, b) => rank(b) - rank(a));
      for (const agent of ours) {
        if (count <= floor) break;
        const id = String(agent.id ?? "");
        if (busy.has(id)) {
          out.skippedBusy.push(id);
          continue;
        }
        try {
          await runtime.deleteAgent({ agentId: id });
          count--;
          out.killed.push(id);
          await events.append({
            kind: "brain.sandbox-auto-killed",
            subjectType: "brain",
            // Model tanpa brain aktif (lantai turun lewat disable/hapus)
            // menyebut model sebagai subjek — armada memang milik model (D79).
            subjectId: governor ? governor.id : `${provider}/${model}`,
            actor,
            payload: { agentId: id, name: String(agent.name ?? ""), model: `${provider}/${model}`, reason },
          });
          log.info("brain.sandbox-auto-killed", { agentId: id, name: String(agent.name ?? ""), model: `${provider}/${model}`, floor, by: actor });
        } catch (err) {
          out.why.push(`kill-failed:${String(err.message ?? err)}`);
          break;
        }
      }
      // Agen sibuk di atas lantai tidak error — mereka dipangkas pass
      // berikutnya begitu idle; konvergensi, bukan kegagalan.
      if (out.killed.length === 0 && out.skippedBusy.length > 0) out.why.push("busy-above-floor");
    }

    out.live = count;
    return out;
  }

  /**
   * Pass penuh (keeper D80/D81): setiap model yang punya brain, plus model
   * yang masih menyimpan agen sem-auto — lantai bisa turun ke 0 lewat
   * disable/hapus brain, dan sisa armada otomatisnya harus ikut turun.
   */
  async function reconcileAll({ actor = "keeper" } = {}) {
    const out = { results: [], created: 0, killed: 0 };
    const models = new Map();
    for (const b of await brains.list()) {
      if (b.provider === "claude-code") continue;
      models.set(`${b.provider}/${b.model}`.toLowerCase(), { provider: b.provider, model: b.model });
    }
    const live = await liveAgents();
    for (const a of live) {
      const name = String(a?.name ?? "");
      const primary = String(a?.model?.primary ?? "");
      if (!name.startsWith(AUTO_PREFIX) || !primary.includes("/")) continue;
      const idx = primary.indexOf("/");
      models.set(primary.toLowerCase(), { provider: primary.slice(0, idx), model: primary.slice(idx + 1) });
    }
    for (const { provider, model } of models.values()) {
      const r = await reconcileModel(provider, model, { actor, reason: "keeper pass" });
      if (r.created?.length || r.killed?.length || r.why?.length) out.results.push(r);
      out.created += r.created?.length ?? 0;
      out.killed += r.killed?.length ?? 0;
    }
    return out;
  }

  return { maybeProvisionForBrain, reconcileModel, reconcileAll, probeWorkspaceFor, agentsForModel, busyAgentsByRef: () => busyAgentsByRef(repos) };
}
