// Live proof that the Slack surface works on the cluster.
//
// Runs INSIDE the controller container, because that is where the two secrets
// live: the service token (to register an operator) and the Slack signing
// secret (to sign requests the way Slack does). Nothing here mocks anything —
// every request goes over real HTTP through the same route Slack will use.
//
//   node scripts/slack-probe.mjs
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const token = readFileSync(process.env.CONTROLLER_TOKEN_FILE, "utf8").trim();
const signing = readFileSync(process.env.SLACK_SIGNING_SECRET_FILE, "utf8").trim();

const SLACK_USER = process.env.PROBE_SLACK_USER ?? "U-PROBE-001";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Signs and posts exactly as Slack does: HMAC over the raw form bytes. */
async function slack(path, fields, { secret = signing, skewSeconds = 0 } = {}) {
  const raw = new URLSearchParams(fields).toString();
  const ts = String(Math.floor(Date.now() / 1000) + skewSeconds);
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`, "utf8").digest("hex")}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    },
    body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const cmd = (text, user = SLACK_USER, opts) =>
  slack("/api/work/slack/command", { text, user_id: user, user_name: "probe" }, opts);

async function main() {
  // --- an operator to act as ------------------------------------------------
  const existing = await api("GET", "/api/work/operators");
  let operator = (existing.body.operators ?? []).find((o) => o.slackUserId === SLACK_USER);
  if (!operator) {
    const created = await api("POST", "/api/work/operators", {
      name: "Slack Probe",
      slackUserId: SLACK_USER,
      role: "operator",
    });
    operator = created.body.operator;
  }
  check("operator registered with a Slack id", Boolean(operator?.id), operator?.id);

  // --- the signature is load-bearing ---------------------------------------
  const forged = await cmd("queue", SLACK_USER, { secret: "definitely-not-the-signing-secret" });
  check("a wrongly signed request is refused", forged.status === 401, `status ${forged.status}`);

  const replayed = await cmd("queue", SLACK_USER, { skewSeconds: -60 * 30 });
  check("a stale timestamp is refused", replayed.status === 401, `status ${replayed.status}`);

  const good = await cmd("queue");
  check("a correctly signed request is served", good.status === 200, `status ${good.status}`);

  // --- identity -------------------------------------------------------------
  const stranger = await cmd("task something expensive", "U-NOT-REGISTERED");
  check(
    "an unregistered Slack user is refused despite a valid signature",
    stranger.status === 200 && /not registered/i.test(stranger.body.text ?? ""),
    stranger.body.text?.slice(0, 60),
  );

  // --- create ---------------------------------------------------------------
  const created = await cmd("task PROBE-SLACK tulis satu kalimat lalu berhenti");
  const taskId = /`(TASK-[A-Z0-9]+)`/.exec(created.body.text ?? "")?.[1];
  check("a task is created from Slack", Boolean(taskId), created.body.text?.slice(0, 80));
  check("the reply names the operator, not the app", /Slack Probe/.test(created.body.text ?? ""));

  if (taskId) {
    const fresh = await api("GET", `/api/work/tasks/${taskId}`);
    check(
      "the task got a worker, so it can actually move",
      Boolean(fresh.body.task?.workerId),
      `${fresh.body.task?.status} worker=${fresh.body.task?.workerId ?? "none"}`,
    );
  }

  if (!taskId) {
    console.log(`\n${failures} failure(s)`);
    process.exit(failures ? 1 : 0);
  }

  // --- stop asks first ------------------------------------------------------
  const asked = await cmd(`stop ${taskId}`);
  check("stop asks for confirmation first", /Reply `yes`/.test(asked.body.text ?? ""), asked.body.text?.slice(0, 80));
  const before = await api("GET", `/api/work/tasks/${taskId}`);
  check(
    "nothing changed while the question was outstanding",
    before.body.task?.status !== "BLOCKED",
    before.body.task?.status,
  );

  const stopped = await cmd("yes");
  check("confirming stops it", /Stopped/.test(stopped.body.text ?? ""), stopped.body.text?.slice(0, 100));
  const after = await api("GET", `/api/work/tasks/${taskId}`);
  check("the task is BLOCKED, not CANCELLED", after.body.task?.status === "BLOCKED", after.body.task?.status);

  // --- model, then run again ------------------------------------------------
  const bogus = await cmd(`model ${taskId} gpt-9000`);
  check(
    "an unknown model is refused with the real choices",
    /no catalog entry/i.test(bogus.body.text ?? "") && /Available:/.test(bogus.body.text ?? ""),
    bogus.body.text?.slice(0, 90),
  );

  const changed = await cmd(`model ${taskId} glm-5.1-on`);
  check("the model is changed", /glm-5\.1/.test(changed.body.text ?? ""), changed.body.text?.slice(0, 90));

  const ran = await cmd(`run ${taskId}`);
  check("it runs again", /Running/.test(ran.body.text ?? ""), ran.body.text?.slice(0, 80));

  // Give the scheduler a pass or two to pick it up.
  await new Promise((r) => setTimeout(r, 8000));
  const final = await api("GET", `/api/work/tasks/${taskId}`);
  check(
    "the task left BLOCKED after the re-run",
    final.body.task?.status !== "BLOCKED",
    `${final.body.task?.status} on ${JSON.stringify(final.body.task?.modelPolicy ?? {})}`,
  );

  console.log(`\n${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});
