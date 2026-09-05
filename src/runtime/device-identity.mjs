// Device identity for the Gateway handshake.
//
// A shared token gets the controller `role: operator` with **no scopes**, so
// dispatch is refused with `missing scope: operator.write` (POC-4 D13). Scopes
// come from a paired device, which is the same mechanism AgentOS uses.
//
// Contract read from the OpenClaw source and matched byte-for-byte, because the
// gateway compares the signed payload exactly:
//   packages/gateway-client/src/device-auth.ts  → buildDeviceAuthPayloadV3
//   src/infra/device-identity.ts                → deviceId = sha256(rawPubKey) hex
//   src/infra/ed25519-signature.ts              → Ed25519, base64url signature
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Raw 32-byte Ed25519 public key as base64url, extracted from a PEM/DER key. */
function rawPublicKeyBase64Url(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  // SPKI for Ed25519 is a fixed 12-byte header followed by the raw key.
  return b64url(der.subarray(der.length - 32));
}

/**
 * Loads the persisted identity or creates one.
 *
 * The key lives on the controller's NFS volume so the device stays the same
 * across restarts and redeploys — a new key each boot would mean a new pairing
 * request each boot, and an operator approving the same service forever.
 */
export function loadOrCreateDeviceIdentity(path) {
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    if (stored.privateKeyPem && stored.publicKeyPem) return hydrate(stored);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity = {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  // 0600: this key is the controller's operator credential.
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return hydrate(identity);
}

function hydrate(stored) {
  const publicKeyRaw = rawPublicKeyBase64Url(stored.publicKeyPem);
  const deviceId = createHash("sha256").update(Buffer.from(publicKeyRaw, "base64url")).digest("hex");
  return { ...stored, publicKeyRaw, deviceId };
}

/**
 * Builds the exact string the gateway will re-derive and verify.
 * Field order and the `|` separator are part of the contract; a mismatch reads
 * as a bad signature rather than a format error, so it must not drift.
 */
export function buildDeviceAuthPayloadV3({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes = [],
  signedAtMs,
  token = null,
  nonce,
  platform = "",
  deviceFamily = "",
}) {
  const normalize = (v) => String(v ?? "").trim().toLowerCase();
  return [
    "v3",
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(signedAtMs),
    token ?? "",
    nonce,
    normalize(platform),
    normalize(deviceFamily),
  ].join("|");
}

/** The `device` block for connect params. Requires the challenge nonce. */
export function buildDeviceBlock({ identity, clientId, clientMode, role, scopes, token, nonce, platform }) {
  if (!nonce) throw new Error("device auth needs the connect.challenge nonce");
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs,
    token,
    nonce,
    platform,
  });
  const signature = b64url(sign(null, Buffer.from(payload, "utf8"), createPrivateKey(identity.privateKeyPem)));
  return { id: identity.deviceId, publicKey: identity.publicKeyRaw, signature, signedAt: signedAtMs, nonce };
}
