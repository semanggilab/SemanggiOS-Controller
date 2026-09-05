// Proving a request really came from Slack.
//
// This is load-bearing, not ceremony. The operator decision was that Slack may
// create, stop and re-plan tasks — so the endpoint that accepts Slack traffic
// can start and stop real work. Without signature verification, anyone who can
// reach that URL can impersonate any operator and do all of it. The identity
// model (one token per operator) would be decorative.
//
// Slack's scheme, implemented from the documented contract:
//
//   basestring = "v0:" + X-Slack-Request-Timestamp + ":" + <raw body>
//   expected   = "v0=" + hex(HMAC_SHA256(signing_secret, basestring))
//   compare to X-Slack-Signature in constant time
//
// Two details that are easy to get wrong and both matter:
//
//   * The RAW body must be hashed — the exact bytes Slack sent. Parsing the
//     form and re-encoding it changes the bytes and every signature fails.
//   * The timestamp window is a replay defence, not a formality. A captured
//     request stays valid forever without it, and "approve" is a request worth
//     replaying.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5;

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 *
 * Never throws: a malformed header is a failed verification, not a crash. An
 * exception here would turn a hostile request into an outage.
 */
export function verifySlackRequest({
  signingSecret,
  signature,
  timestamp,
  rawBody,
  now = () => Date.now(),
  windowSeconds = SLACK_REPLAY_WINDOW_SECONDS,
}) {
  if (!signingSecret) return { ok: false, reason: "no signing secret configured" };
  if (!signature || !timestamp) return { ok: false, reason: "missing signature headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "timestamp is not a number" };

  // Absolute skew: a request from the future is as suspicious as an old one.
  const ageSeconds = Math.abs(Math.floor(now() / 1000) - ts);
  if (ageSeconds > windowSeconds) {
    return { ok: false, reason: `timestamp is ${ageSeconds}s away, outside the ${windowSeconds}s window` };
  }

  const base = `v0:${timestamp}:${rawBody ?? ""}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base, "utf8").digest("hex")}`;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  // Length differs → definitely not a match, and timingSafeEqual would throw.
  if (a.length !== b.length) return { ok: false, reason: "signature mismatch" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };

  return { ok: true };
}

/** Slack posts commands as urlencoded form data; interactions nest JSON inside it. */
export function parseSlackBody(rawBody, contentType = "") {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawBody || "{}");
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(rawBody ?? "");
  const out = Object.fromEntries(params.entries());
  // Block Kit interactions arrive as a JSON string in a `payload` field.
  if (out.payload) {
    try {
      return { ...out, payload: JSON.parse(out.payload) };
    } catch {
      return out;
    }
  }
  return out;
}
