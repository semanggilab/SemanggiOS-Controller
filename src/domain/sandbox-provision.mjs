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
   * Jalur keeper (D80): menjaga lantai min_sandboxes untuk setiap Brain yang
   * aktif. Slot deterministik (`sem-auto-<brain>-<n>`) membuat pass berikutnya
   * menghitung ulang dari nama yang sama — kegagalan setengah jalan konvergen,
   * tidak menumpuk. Agen operator/probe yang sudah hidup untuk model itu
   * DIHITUNG ke arah lantai: lantai adalah jumlah agen, bukan jumlah agen
   * buatan keeper.
   */
  async function enforceMinimums({ actor = "keeper" } = {}) {
    if (typeof runtime?.createProbeAgent !== "function") {
      return { created: 0, perBrain: [] };
    }
    const out = { created: 0, perBrain: [] };
    const live = await liveAgents();
    for (const brain of await brains.list({ enabledOnly: true })) {
      if (!(brain.minSandboxes > 0) || brain.provider === "claude-code") continue;
      const cap = await capFor(brain);
      if (cap == null) {
        out.perBrain.push({ brain: brain.name, why: "no-resource-entry" });
        continue;
      }
      let current = agentsForModel(brain, live).length;
      if (current >= brain.minSandboxes) continue;
      const taken = new Set(live.map((a) => String(a?.name ?? "")));
      for (let slot = 1; slot <= brain.minSandboxes && current < brain.minSandboxes; slot++) {
        if (current >= cap) {
          out.perBrain.push({ brain: brain.name, why: "cap-full", live: current, cap });
          break;
        }
        const name = `sem-auto-${slug(brain.name)}-${slot}`.slice(0, 63);
        if (taken.has(name)) continue;
        try {
          const agent = await createOne(brain, { name, reason: "keeper minimum", actor });
          live.push({ id: agent.id, name, model: { primary: `${brain.provider}/${brain.model}` } });
          taken.add(name);
          current++;
          out.created++;
        } catch (err) {
          out.perBrain.push({ brain: brain.name, why: "create-failed", error: String(err.message ?? err) });
          break;
        }
      }
    }
    return out;
  }

  return { maybeProvisionForBrain, enforceMinimums, probeWorkspaceFor, agentsForModel };
}
