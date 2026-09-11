// Composition root. Everything the controller needs is wired here so tests can
// build the same object graph with a fake runtime and an in-memory database.
import { openStore } from "./db/index.mjs";
import { createEventLog } from "./domain/events.mjs";
import { createRepositories } from "./domain/repositories.mjs";
import { RoutingPolicy } from "./scheduler/routing.mjs";
import { createAdmission } from "./scheduler/admission.mjs";
import { createScheduler } from "./scheduler/scheduler.mjs";
import { nullLogger } from "./domain/logger.mjs";
import { createOperators } from "./domain/operators.mjs";
import { createBrains, brainsFromRoutingConfig, Level } from "./domain/brains.mjs";
import { createSandboxProvision } from "./domain/sandbox-provision.mjs";
import { createChatSandbox } from "./domain/chat-sandbox.mjs";
import { createQuotaRecovery } from "./domain/quota-recovery.mjs";
import { createBrainMap, DEFAULT_BRAIN_MAP } from "./domain/brain-map.mjs";
import { createThinkingLevels } from "./domain/thinking-levels.mjs";
import { createGatewayModelsCache } from "./domain/gateway-models.mjs";
import { shortId } from "./domain/repositories.mjs";

export async function createController({
  storeLocation = ":memory:",
  databaseDriver = "sqlite",
  databaseUri = null,
  sharedState = null,
  routing = {},
  // Resource catalogue (POC-4 §4). Seeding is idempotent and never clobbers a
  // live availability signal: a 429 recorded at runtime is more current than a
  // config file, so a restart must not reset a quota-exhausted model to
  // AVAILABLE and start dispatching into a wall.
  resources = [],
  runtime,
  config = {},
  now = () => Date.now(),
  log = nullLogger,
} = {}) {
  const store = await openStore({ driver: databaseDriver, uri: databaseUri, location: storeLocation });
  const events = createEventLog(store, { now });
  const repos = createRepositories(store, events, { now, log: log.child({ component: "repo" }) });
  const operators = createOperators(store, { now });
  const brains = createBrains(store, { now, shortId });
  const brainMap = createBrainMap(store, { now });
  const thinkingLevels = createThinkingLevels(store, { now });
  const gatewayModels = createGatewayModelsCache(store, { now });
  const policy = new RoutingPolicy(routing);

  for (const r of resources) {
    const existing = await repos.resources.get(r.provider, r.model);
    if (existing) continue;
    await repos.resources.upsert(r);
  }

  // Katalog routing di berkas adalah benih untuk tabel Brain, bukan
  // penggantinya. Disemai sekali; sesudah itu operator yang memiliki isinya
  // lewat halaman konfigurasi, dan berkas tidak lagi menimpanya. Kalau berkas
  // tetap menang, setiap penyuntingan operator akan hilang pada restart
  // berikutnya tanpa jejak.
  const seeded = await brains.list();
  if (seeded.length === 0) {
    for (const seed of brainsFromRoutingConfig(routing)) {
      try {
        await brains.create(seed);
      } catch (err) {
        log.warn("brain.seed-failed", { brain: seed.name, error: String(err.message).slice(0, 160) });
      }
    }
    log.info("brain.seeded", { count: (await brains.list()).length, source: "routing config" });
  }

  // Versioned, explicit Brain policy rollout. Existing installations do not
  // reseed from files, so a normal restart preserves operator edits. A new
  // policy version is different: it is a deliberate deployment migration and
  // is applied exactly once, with an append-only event as its durable marker.
  const brainPolicyVersion = String(routing.brainPolicyVersion ?? "").trim();
  if (brainPolicyVersion) {
    const applied = await store.get(
      `SELECT seq FROM event_log WHERE kind = ? AND subject_type = ? AND subject_id = ? LIMIT 1`,
      ["brain.policy-applied", "config", brainPolicyVersion],
    );
    if (!applied) {
      for (const seed of brainsFromRoutingConfig(routing)) {
        const existing = await brains.get(seed.name);
        if (!existing) {
          await brains.create(seed);
          continue;
        }
        if (existing.provider !== seed.provider || existing.model !== seed.model) {
          throw new Error(
            `Brain policy ${brainPolicyVersion}: ${seed.name} already points to ` +
              `${existing.provider}/${existing.model}, expected ${seed.provider}/${seed.model}`,
          );
        }
        await brains.update(existing.id, {
          thinking: seed.thinking,
          effortMode: seed.effortMode,
          effortEvidence: seed.effortEvidence,
          mode: seed.mode,
          acpAgent: seed.acpAgent,
          level: seed.level,
          enabled: true,
        });
      }

      const mapPolicy = routing.brainMapPolicy ?? {};
      let cells = 0;
      for (const [template, roles] of Object.entries(DEFAULT_BRAIN_MAP)) {
        for (const role of Object.keys(roles)) {
          for (const level of [Level.LOW, Level.NORMAL, Level.CRITICAL]) {
            const names = mapPolicy[level]?.[role] ?? mapPolicy[level]?.default;
            if (!Array.isArray(names) || names.length === 0) continue;
            const ids = [];
            for (const name of names) {
              const brain = await brains.get(name);
              if (!brain) throw new Error(`Brain policy ${brainPolicyVersion}: unknown mapped Brain ${name}`);
              ids.push(brain.id);
            }
            await brainMap.set(
              { template, role, level, brainIds: ids, actor: `policy:${brainPolicyVersion}` },
              { brains },
            );
            cells += 1;
          }
        }
      }
      await events.append({
        kind: "brain.policy-applied",
        subjectType: "config",
        subjectId: brainPolicyVersion,
        actor: "deployment",
        payload: { cells },
      });
      log.info("brain.policy-applied", { version: brainPolicyVersion, cells });
    }
  }

  // Katalog thinking levels: diseed HANYA saat tabelnya kosong (D66). Selama
  // bertahun-tahun ini sync penuh tiap boot — arah kepemilikannya file > DB —
  // yang benar selama file adalah satu-satunya penulis. Sekarang bukan:
  // probe menulis langsung ke DB (endpoint probe), dan operator menyuntingnya
  // lewat halaman Model Map. Boot-refresh pada keadaan itu berarti setiap
  // suntingan operator dan hasil probe hilang diam-diam pada restart berikutnya
  // — kelas kesalahan yang sama dengan yang dicegah seeding brains di atas.
  // Berkas tetap menjadi seed instalasi baru; import eksplisit tetap tersedia
  // lewat POST /api/work/gateway/thinking-levels/refresh.
  if ((await thinkingLevels.list()).length === 0) {
    try {
      const synced = await thinkingLevels.refresh();
      log.info("thinking-levels.seeded", synced);
    } catch (err) {
      log.warn("thinking-levels.seed-failed", { error: String(err.message).slice(0, 160) });
    }
  }

  // D42: admission resolves Brain names from the brains table (seeded above),
  // so it is wired after seeding, with the catalog as fallback.
  // D80: provisioning otomatis dibangun di sini — on-demand admission dan
  // keeper main.mjs berbagi SATU objek supaya pagarnya (claude-code, baris
  // resource, concurrency_limit) tidak bisa berbeda pendapat antar pemanggil.
  const sandboxProvision = createSandboxProvision({
    repos,
    brains,
    runtime,
    events,
    now,
    log: log.child({ component: "sandbox-provision" }),
  });
  // POC-10 T2: pool sandbox chat. Objek terpisah dari sandboxProvision dengan
  // sengaja — dua pool, dua batas (§10.3), dan jalur task tidak boleh bisa
  // melihat (apalagi memangkas) armada chat lewat modulnya sendiri.
  const chatSandbox = createChatSandbox({
    repos,
    runtime,
    events,
    now,
    log: log.child({ component: "chat-sandbox" }),
  });
  const admission = createAdmission({ repos, events, policy, brains, runtime, sandboxProvision, config, now, log: log.child({ component: "admission" }) });
  // D84: probe pemulihan kuota — satu run minimal per model ter-exhaust per
  // pass, mengukur "bisa digunakan" alih-alih menebak jangkar waktunya.
  const quotaRecovery = createQuotaRecovery({
    repos,
    runtime,
    sharedState,
    config,
    now,
    log: log.child({ component: "quota-recovery" }),
  });
  // D71: gateway hooks the watchdog needs (abortRun/describeSession). A holder
  // rather than direct functions because the session-event sink that owns the
  // describe→verdict mapping is built AFTER the controller (it needs
  // controller.repos); main.mjs binds it here once both exist.
  const gatewayHooks = {};
  const scheduler = createScheduler({
    admission,
    repos,
    // D75: the watchdog's dead-run verdict writes an audit event, same as the
    // sink and reconciler paths — one budget, one trail.
    events,
    config: { log: log.child({ component: "scheduler" }), gatewayHooks, sharedState, ...config },
    now,
  });

  // `resources` (seed resources.json) ikut dikembalikan: DELETE model-map
  // (D67) harus tahu baris mana yang akan di-seed ulang pada boot berikutnya —
  // menghapus baris yang masih ada di seed adalah penghapusan yang tidak
  // pernah terjadi.
  return { store, sharedState, events, repos, operators, brains, brainMap, thinkingLevels, gatewayModels, policy, admission, scheduler, gatewayHooks, sandboxProvision, chatSandbox, quotaRecovery, config, now, log, runtime, seedResources: resources };
}
