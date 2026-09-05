// Slack request verification.
//
// Load-bearing, not ceremony: Slack may create and stop real work, so anyone
// who can reach this endpoint without a signature check can impersonate any
// operator and do all of it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySlackRequest, parseSlackBody, SLACK_REPLAY_WINDOW_SECONDS } from "../../src/interface/slack-verify.mjs";

const SECRET = "s3cr3t-signing";
const sign = (rawBody, ts, secret = SECRET) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`, "utf8").digest("hex")}`;

test("a genuine Slack request verifies", () => {
  const now = () => 1_700_000_000_000;
  const ts = String(Math.floor(now() / 1000));
  const raw = "command=%2Fsemanggi&text=status";
  assert.deepEqual(
    verifySlackRequest({ signingSecret: SECRET, signature: sign(raw, ts), timestamp: ts, rawBody: raw, now }),
    { ok: true },
  );
});

test("a tampered body fails even with a valid-looking signature", () => {
  const now = () => 1_700_000_000_000;
  const ts = String(Math.floor(now() / 1000));
  const signed = sign("text=status", ts);
  const res = verifySlackRequest({
    signingSecret: SECRET, signature: signed, timestamp: ts,
    rawBody: "text=stop%20TASK-1", now,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /mismatch/);
});

test("a request signed with the wrong secret fails", () => {
  const now = () => 1_700_000_000_000;
  const ts = String(Math.floor(now() / 1000));
  const raw = "text=status";
  const res = verifySlackRequest({
    signingSecret: SECRET, signature: sign(raw, ts, "attacker-secret"), timestamp: ts, rawBody: raw, now,
  });
  assert.equal(res.ok, false);
});

test("a captured request cannot be replayed later", () => {
  // Without the window a captured "approve" stays valid forever — and that is
  // exactly the request worth replaying.
  const signedAt = 1_700_000_000_000;
  const ts = String(Math.floor(signedAt / 1000));
  const raw = "text=approve%20TASK-1";
  const signature = sign(raw, ts);

  assert.equal(
    verifySlackRequest({ signingSecret: SECRET, signature, timestamp: ts, rawBody: raw, now: () => signedAt }).ok,
    true,
  );
  const later = signedAt + (SLACK_REPLAY_WINDOW_SECONDS + 60) * 1000;
  const replayed = verifySlackRequest({ signingSecret: SECRET, signature, timestamp: ts, rawBody: raw, now: () => later });
  assert.equal(replayed.ok, false);
  assert.match(replayed.reason, /outside the/);
});

test("a timestamp from the future is refused too", () => {
  const now = () => 1_700_000_000_000;
  const future = String(Math.floor(now() / 1000) + 3600);
  const raw = "text=status";
  const res = verifySlackRequest({ signingSecret: SECRET, signature: sign(raw, future), timestamp: future, rawBody: raw, now });
  assert.equal(res.ok, false);
});

test("missing configuration or headers fails closed, and never throws", () => {
  // A hostile request must not be able to turn into an outage.
  assert.equal(verifySlackRequest({ signingSecret: null, signature: "x", timestamp: "1", rawBody: "" }).ok, false);
  assert.equal(verifySlackRequest({ signingSecret: SECRET, rawBody: "" }).ok, false);
  assert.equal(verifySlackRequest({ signingSecret: SECRET, signature: "v0=zz", timestamp: "abc", rawBody: "" }).ok, false);
  assert.doesNotThrow(() => verifySlackRequest({ signingSecret: SECRET, signature: "short", timestamp: "1", rawBody: "" }));
});

test("form commands and Block Kit interactions both parse", () => {
  const cmd = parseSlackBody("command=%2Fsemanggi&text=status+TASK-1&user_id=U123", "application/x-www-form-urlencoded");
  assert.equal(cmd.text, "status TASK-1");
  assert.equal(cmd.user_id, "U123");

  const interaction = parseSlackBody(
    `payload=${encodeURIComponent(JSON.stringify({ user: { id: "U9" }, actions: [{ action_id: "approve", value: "AP-1" }] }))}`,
    "application/x-www-form-urlencoded",
  );
  assert.equal(interaction.payload.user.id, "U9");
  assert.equal(interaction.payload.actions[0].action_id, "approve");
});
