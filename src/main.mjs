// Service entrypoint.
//
// Fails fast and loudly on missing configuration rather than starting in a
// half-configured state: a controller that boots without a routing policy or a
// token would look healthy while silently refusing to schedule anything.
import { readFileSync } from "node:fs";
import { createController } from "./app.mjs";
import { createApi } from "./api/server.mjs";
import { createGatewayRuntime } from "./runtime/gateway-ws.mjs";
import { createAgentOSRuntime } from "./runtime/agentos.mjs";
import { createReconciler } from "./runtime/reconciler.mjs";
import { createSessionEventSink } from "./runtime/session-events.mjs";
import { applyRuntimeFailure } from "./domain/retry.mjs";
import { cleanUploads } from "./domain/workspace-files.mjs";
import { createSlackSurface } from "./interface/slack.mjs";
import { createSlackApp } from "./interface/slack-app.mjs";
import { WakeReason } from "./scheduler/scheduler.mjs";
import { createLogger } from "./domain/logger.mjs";
import { createSharedState } from "./runtime/shared-state.mjs";

function readSecret(path, label) {
  if (!path) throw new Error(`${label} path is not configured`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${label} at ${path} is empty`);
  return value;
}

function readJson(path, label) {
  if (!path) throw new Error(`${label} path is not configured`);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const log = createLogger({ service: "controller" });
  const port = Number(process.env.PORT ?? 8080);
  const token = readSecret(process.env.CONTROLLER_TOKEN_FILE, "semanggi_controller_token");
  const routing = readJson(process.env.SEMANGGI_ROUTING_CONFIG, "routing policy");
  // Optional: without it the controller schedules nothing until resources are
  // POSTed, which is a valid but easily confusing way to run.
  const resources = process.env.SEMANGGI_RESOURCES_CONFIG
    ? readJson(process.env.SEMANGGI_RESOURCES_CONFIG, "resource catalogue").resources ?? []
    : [];
  const databaseDriver = process.env.DATABASE_DRIVER ?? "sqlite";
  let databaseUri = process.env.DATABASE_URI ?? process.env.SEMANGGI_DB ??
    "/opt/semanggi/volumes/shared/service/semanggios/controller/controller.db";
  if (databaseDriver === "postgres" && process.env.DATABASE_PASSWORD_FILE) {
    const parsed = new URL(databaseUri);
    parsed.password = readSecret(process.env.DATABASE_PASSWORD_FILE, "postgres password");
    databaseUri = parsed.toString();
  }
  const stateDriver = process.env.STATE_DRIVER ?? (databaseDriver === "postgres" ? "redis" : "memory");
  // Password Redis, sama polanya dengan Postgres di atas: rahasia datang dari
  // berkas secret, bukan dari URI di stack.
  //
  // Stack SUDAH memasang REDIS_PASSWORD_FILE sejak awal; yang hilang justru
  // baris ini, dan ketiadaannya tidak terlihat selama redis mengizinkan koneksi
  // tanpa auth. Saat redis-prod mulai menuntut AUTH (2026-09-09 07:53 UTC,
  // setelah service-nya dijadwalkan ulang), controller kehilangan lock bersama
  // di tengah pass scheduler dan mati berulang — kegagalan yang jauh dari
  // sebabnya. Menyertakan password membuat kontraknya sama di kedua sisi.
  let redisUri = process.env.REDIS_URI ?? process.env.REDIS_URL ?? null;
  if (stateDriver === "redis" && redisUri && process.env.REDIS_PASSWORD_FILE) {
    const parsed = new URL(redisUri);
    parsed.password = readSecret(process.env.REDIS_PASSWORD_FILE, "redis password");
    redisUri = parsed.toString();
  }
  const sharedState = await createSharedState({
    driver: stateDriver,
    uri: redisUri,
    prefix: process.env.REDIS_PREFIX ?? "semanggi",
  });

  // Dispatch goes over the Gateway WebSocket. The AgentOS HTTP write path is
  // closed to us: it refuses writes from any client whose socket peer is not
  // loopback, and spoofing that check is not an acceptable foundation for a
  // control plane (POC-4 D12). Spec §7.2 permits either transport.
  // Declared before the runtime so the event hook can reach it; assigned once
  // the controller exists. Events that arrive before then are dropped, which is
  // correct — there is nothing yet to apply them to, and the reconciler covers
  // that window.
  let sessionEvents = null;

  const runtime = createGatewayRuntime({
    url: process.env.SEMANGGI_GATEWAY_URL ?? "ws://openclaw-gateway:18789",
    token: readSecret(process.env.SEMANGGI_GATEWAY_TOKEN_FILE, "openclaw_gateway_token"),
    version: process.env.SEMANGGI_VERSION ?? "0.1.0",
    onEvent: (name, payload) => void sessionEvents?.handle(name, payload),
    log: log.child({ component: "gateway" }),
  });

  // AgentOS stays in the picture for reads only: its safe methods work
  // cross-service and /api/snapshot carries the revision that tells the
  // reconciler when something moved.
  const agentos = process.env.AGENTOS_URL
    ? createAgentOSRuntime({
        upstreamHost: new URL(process.env.AGENTOS_URL).hostname,
        upstreamPort: Number(new URL(process.env.AGENTOS_URL).port || 3000),
        username: process.env.AGENTOS_INITIAL_ADMIN_USERNAME ?? "admin",
        password: process.env.AGENTOS_ADMIN_PASSWORD_FILE
          ? readSecret(process.env.AGENTOS_ADMIN_PASSWORD_FILE, "agentos admin password")
          : undefined,
        apiToken: process.env.AGENTOS_TOKEN_FILE
          ? readSecret(process.env.AGENTOS_TOKEN_FILE, "agentos_api_token")
          : undefined,
      })
    : null;

  const controller = await createController({
    log,
    resources,
    storeLocation: databaseUri,
    databaseDriver,
    databaseUri,
    sharedState,
    routing,
    runtime,
    config: {
      // D20: berapa lama eksekusi boleh diam sebelum direklamasi.
      dispatchTimeoutMs: Number(process.env.SEMANGGI_DISPATCH_TIMEOUT_MS ?? 30 * 60 * 1000),
      log: log.child({ component: "scheduler" }),
      maxRunning: Number(process.env.SEMANGGI_MAX_RUNNING ?? 8),
      leaseTtlMs: Number(process.env.SEMANGGI_LEASE_TTL_MS ?? 15 * 60 * 1000),
      watchdogMs: Number(process.env.SEMANGGI_WATCHDOG_MS ?? 30_000),
      // D75: anggaran auto-retry run yang mati abnormal (domain/retry.mjs) —
      // satu anggaran untuk watchdog, sink, dan reconciler.
      runtimeRetryLimit: Number(process.env.SEMANGGI_RUNTIME_RETRY_LIMIT ?? 2),
      runtimeRetryWindowMs: Number(process.env.SEMANGGI_RUNTIME_RETRY_WINDOW_MS ?? 6 * 60 * 60 * 1000),
      runtimeRetryBaseMs: Number(process.env.SEMANGGI_RUNTIME_RETRY_BASE_MS ?? 30_000),
      runtimeRetryMaxMs: Number(process.env.SEMANGGI_RUNTIME_RETRY_MAX_MS ?? 15 * 60 * 1000),
      // D82: jeda sebelum end-frame non-bersih boleh memfinalisasi eksekusi.
      // Gateway 2026.8.2 mengirim end(length) prematur lalu koreksi end(stop)
      // ~400ms kemudian; tanpa jeda ini, koreksinya selalu terlambat.
      endGraceMs: Number(process.env.SEMANGGI_END_GRACE_MS ?? 1500),
    },
  });

  controller.slack = createSlackSurface(controller, {
    defaultProjectId: process.env.SEMANGGI_DEFAULT_PROJECT ?? null,
  });
  // The Slack-specific surface: signed requests, per-operator attribution,
  // confirmation on anything destructive. Kept separate from `controller.slack`
  // above, which stays transport-agnostic for curl and the operator UI.
  controller.slackApp = createSlackApp(controller, {
    defaultProjectId: process.env.SEMANGGI_DEFAULT_PROJECT ?? null,
    log: log.child({ component: "slack" }),
  });
  if (!process.env.SLACK_SIGNING_SECRET_FILE && !process.env.SLACK_SIGNING_SECRET) {
    // Not fatal — the rest of the controller works — but the Slack endpoints
    // will refuse every request, and silently returning 401s to a channel
    // nobody is watching is a worse failure than saying so at boot.
    log.warn("slack.no-signing-secret", {
      why: "no SLACK_SIGNING_SECRET_FILE or SLACK_SIGNING_SECRET, so /api/work/slack/* will reject every request",
    });
  }
  // D15: the only source on this gateway version that reports a run finishing.
  sessionEvents = createSessionEventSink({
    repos: controller.repos,
    events: controller.events,
    runtime,
    scheduler: controller.scheduler,
    // D51: the late-error quota branch reads each model's reset schedule
    // from the brains table to decide wait-one-window vs block.
    brains: controller.brains,
    // D75: shared retry budget with the watchdog and the reconciler.
    config: controller.config,
    log: log.child({ component: "session-events" }),
  });

  // D71/D72: the watchdog's gateway verification (abort-before-park,
  // describe-truth) and the reconciler's describe reader both bind here —
  // after the sink exists, because the sink owns the describe→verdict mapping.
  controller.gatewayHooks.abortRun = (p) => runtime.abortRun(p);
  controller.gatewayHooks.describeSession = (p) => runtime.describeSession(p);

  const reconciler = createReconciler({
    repos: controller.repos,
    events: controller.events,
    runtime,
    applyDescribe: (execution, session) => sessionEvents.applyDescribe(execution, session),
    // D75: the fast recovery path — describe terminal under a still-live
    // claim requeues NOW, not after the watchdog's 30-minute silence.
    applyFailure: async (execution, task, session) =>
      applyRuntimeFailure(
        { repos: controller.repos, events: controller.events, config: controller.config, log, now: controller.now },
        {
          task,
          execution,
          cause: `gateway session: ${session?.status ?? "unknown"}`,
          source: "reconciler",
        },
      ),
    config: { blockedScanWindowMs: Number(process.env.SEMANGGI_BLOCKED_SCAN_MS ?? 24 * 60 * 60 * 1000) },
    log: log.child({ component: "reconciler" }),
  });

  // The heartbeat that keeps a live run's lease alive rides on the scheduler
  // pass, so the TTL must comfortably outlast the interval between passes.
  // Getting this backwards is what let a long run lose its workspace mid-flight.
  if (controller.config.leaseTtlMs <= controller.config.watchdogMs * 3) {
    log.warn("config.lease-ttl-tight", {
      leaseTtlMs: controller.config.leaseTtlMs,
      watchdogMs: controller.config.watchdogMs,
      why: "a live run renews its lease once per scheduler pass; a TTL this close to the interval risks expiry mid-run",
    });
  }

  // Preferred as a file, like every other secret here: an env var is visible in
  // `docker service inspect` to anyone who can reach the daemon, and this one
  // is what stands between the internet and a control plane that can stop work.
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET_FILE
    ? readSecret(process.env.SLACK_SIGNING_SECRET_FILE, "slack_signing_secret")
    : (process.env.SLACK_SIGNING_SECRET ?? null);

  const api = createApi(controller, { token, slackSigningSecret });
  const server = api.createServer();
  server.listen(port, "::", () => console.log(`semanggi-work-controller listening on ${port}`));

  // Verify the dispatch path at startup rather than discovering a version skew
  // on the first real task. A failure here is logged, not fatal: the API and
  // the queue stay usable so an operator can see why nothing is dispatching.
  runtime
    .health()
    .then((h) =>
      console.log(
        h.ok
          ? `gateway reachable (protocol ${h.protocol}, ${h.methods ?? "?"} methods)`
          : `gateway NOT reachable: ${h.error}`,
      ),
    )
    .catch((err) => console.error(`gateway health check failed: ${err.message}`));

  // Subscribe, and keep re-subscribing: the gateway forgets the subscription
  // when the socket drops, and a controller that subscribed only once at boot
  // would look healthy while receiving nothing. Failure is logged, not fatal —
  // the snapshot reconciler still covers completion, just more slowly.
  const subscribe = () =>
    sessionEvents
      .start()
      .catch((err) => console.error(`[session-events] subscribe failed: ${err.message}`));
  void subscribe();
  const resubscribeTimer = setInterval(subscribe, Number(process.env.SEMANGGI_RESUBSCRIBE_MS ?? 60_000));
  resubscribeTimer.unref?.();

  controller.scheduler.start();
  const singleton = (name, ttlMs, fn) => controller.sharedState
    ? controller.sharedState.withLock(`job:${name}`, ttlMs, fn)
    : fn();

  // D72: reconciliation runs on a plain timer. The pass is self-gating — one
  // describe per task whose latest execution is unfinalized and carries a
  // session key — so there is nothing to save by gating it on the AgentOS
  // snapshot revision: that revision never moves for gateway-direct runs,
  // which is exactly the case the reconciler exists for. (The old
  // revision-gated call sites passed no readStatus at all, so the pass had
  // neither a trigger that fired nor a source to read — a no-op wearing the
  // name of a safety net.)
  const reconcileTimer = setInterval(() => {
    void (async () => {
      try {
        const out = await singleton("reconcile", 60_000, () => reconciler.reconcileOnce());
        if (!out) return;
        if (out.settled.length > 0 || out.stragglers.length > 0 || out.recovered.length > 0) {
          await controller.scheduler.notify(WakeReason.TASK_FINISHED);
        }
      } catch (err) {
        console.error(`reconcile pass failed: ${err.message}`);
      }
    })();
  }, Number(process.env.SEMANGGI_RECONCILE_MS ?? 20_000));
  reconcileTimer.unref?.();

  // D76/D77: penyapu lampiran — staging tmp/uploads/ DAN salinan per-task
  // deliverables/<task>/tmp/uploads/. Agen diinstruksikan menghapus segera
  // setelah memuatnya, tapi instruksi bukan jaminan — TTL inilah yang
  // deterministik. Satu jam sekali cukup: TTL-nya 24 jam, beberapa menit
  // kelebihan umur tidak mengubah apa pun.
  const uploadTtlMs = Number(process.env.SEMANGGI_UPLOAD_TTL_MS ?? 24 * 60 * 60 * 1000);
  const uploadSweep = async () => {
    try {
      await singleton("upload-sweep", 15 * 60_000, async () => {
        for (const project of await controller.repos.projects.list()) {
          if (!project.workspace_path) continue;
          const removed = await cleanUploads(project.workspace_path, uploadTtlMs);
          if (removed.length > 0) {
            log.info("uploads.swept", { project: project.id, removed: removed.length, paths: removed.slice(0, 5) });
          }
        }
      });
    } catch (err) {
      console.error(`upload sweep failed: ${err.message}`);
    }
  };
  const uploadTimer = setInterval(() => void uploadSweep(), 60 * 60 * 1000);
  uploadTimer.unref?.();
  void uploadSweep();

  // D80/D81: keeper lantai sandbox — tiap brain aktif dengan min_sandboxes
  // dijaga armadanya DUA ARAH: ditumbuhkan sampai lantai (dibatasi
  // concurrency_limit resource), dipangkas ke lantai bila berlebih (hanya
  // agen sem-auto-* yang idle — aturan busy sama dengan kill operator D78).
  // Timer polos, bukan event-driven: lantai adalah keadaan yang diinginkan,
  // dan keadaan yang diinginkan dicek ulang secara berkala — sama seperti
  // reconciler D72, yang juga tidak menunggu diundang. Perubahan lantai via
  // API juga memicu rekonsiliasi LANGSUNG (server.mjs); keeper menutup celah
  // di antara itu. Matikan dengan SEMANGGI_SANDBOX_KEEPER=0.
  const sandboxKeeperMs = Number(process.env.SEMANGGI_SANDBOX_KEEPER_MS ?? 60_000);
  let sandboxKeeperTimer = null;
  if (controller.sandboxProvision && sandboxKeeperMs > 0 && process.env.SEMANGGI_SANDBOX_KEEPER !== "0") {
    sandboxKeeperTimer = setInterval(() => {
      void singleton("sandbox-keeper", Math.max(sandboxKeeperMs * 3, 180_000), () =>
        controller.sandboxProvision.reconcileAll({ actor: "keeper" }))
        .then((out) => {
          if (out.created > 0 || out.killed > 0) {
            log.info("sandbox-keeper.reconciled", { created: out.created, killed: out.killed, results: out.results });
          }
        })
        .catch((err) => log.warn("sandbox-keeper.failed", { error: String(err.message ?? err) }));
    }, sandboxKeeperMs);
    sandboxKeeperTimer.unref?.();
  }

  // D84: probe pemulihan kuota — baris QUOTA_EXHAUSTED adalah TEBAKAN tentang
  // kapan provider pulih; satu run minimal per model per pass mengukur
  // kenyataannya dan melepas baris begitu model benar-benar bisa dipakai
  // (terukur 2026-09-08: glm-5.2 pulih jauh sebelum jangkar 5 jamnya).
  // Pemulihan memicu QUOTA_RESET supaya task yang parkir di WAIT_QUOTA
  // langsung dievaluasi ulang. Matikan dengan SEMANGGI_QUOTA_PROBE=0.
  const quotaProbeMs = Number(process.env.SEMANGGI_QUOTA_PROBE_MS ?? 10 * 60_000);
  let quotaProbeTimer = null;
  if (controller.quotaRecovery && quotaProbeMs > 0 && process.env.SEMANGGI_QUOTA_PROBE !== "0") {
    quotaProbeTimer = setInterval(() => {
      void singleton("quota-probe", Math.max(quotaProbeMs * 2, 180_000), () => controller.quotaRecovery.run())
        .then((out) => {
          if (!out) return;
          if (out.recovered.length > 0) {
            log.info("quota-probe.recovered", { models: out.recovered });
            return controller.scheduler.notify(WakeReason.QUOTA_RESET);
          }
        })
        .catch((err) => log.warn("quota-probe.failed", { error: String(err.message ?? err) }));
    }, quotaProbeMs);
    quotaProbeTimer.unref?.();
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcileTimer);
    clearInterval(resubscribeTimer);
    clearInterval(uploadTimer);
    if (sandboxKeeperTimer) clearInterval(sandboxKeeperTimer);
    if (quotaProbeTimer) clearInterval(quotaProbeTimer);
    controller.scheduler.stop();
    await Promise.allSettled([runtime.close?.(), agentos?.close?.()]);
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([controller.store.close?.(), controller.sharedState?.close?.()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Race terukur (2026-09-09): task swarm menembak main() di milidetik
// pertama container, sebelum datapath overlay (DNS/VXLAN) siap — koneksi
// pertama ke pgproxy/redis-prod/openclaw-gateway bisa "Connection closed"
// dan membunuh proses, crash-loop 0/2 padahal exec manual selalu selamat.
// Boot kini dicoba ulang; kegagalan konektivitas adalah kondisi start,
// bukan bug aplikasi.
const BOOT_ATTEMPTS = Number(process.env.SEMANGGI_BOOT_ATTEMPTS ?? 8);
const BOOT_RETRY_MS = Number(process.env.SEMANGGI_BOOT_RETRY_MS ?? 3_000);
(async () => {
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      await main();
      return;
    } catch (err) {
      console.error(`startup failed (attempt ${attempt}/${BOOT_ATTEMPTS}): ${err.message}`);
      if (attempt === BOOT_ATTEMPTS) {
        console.error(err);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_MS));
    }
  }
})();
