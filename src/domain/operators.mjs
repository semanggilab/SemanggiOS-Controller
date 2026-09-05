// Who is acting, and under whose name it gets recorded.
//
// The controller started with one shared bearer token. That is fine for a
// service calling a service, and wrong the moment a person makes a decision:
// approvals record `decided_by` (P4-08), and a shared token makes every human
// the same anonymous caller. An audit trail that cannot name anyone is not an
// audit trail.
//
// So: one token per operator, stored hashed. Authentication only ever compares
// hashes, so nothing needs to read a token back, and a leaked database hands
// over no working credentials.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const hashToken = (token) => createHash("sha256").update(String(token), "utf8").digest("hex");

/** A fresh operator token. Returned once, at creation, and never recoverable. */
export const mintToken = () => `sop_${randomBytes(24).toString("base64url")}`;

/**
 * Constant-time comparison of two hex digests.
 *
 * A plain `===` on a secret-derived value leaks length and prefix through
 * timing. The hashes are fixed-length here so the comparison is safe to do
 * directly, but doing it properly costs nothing and survives future edits.
 */
export function digestsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function createOperators(store, { now = () => Date.now(), shortId } = {}) {
  const api = {
    /** @returns {{operator, token}} — the token is visible exactly once. */
    async create({ name, slackUserId = null, role = "operator" }) {
      if (!name) throw new Error("an operator needs a name: decisions are recorded against it");
      if (!["operator", "admin", "readonly"].includes(role)) throw new Error(`unknown role "${role}"`);
      const token = mintToken();
      const id = shortId ? shortId("OP") : `OP-${randomBytes(4).toString("hex").toUpperCase()}`;
      await store.run(
        `INSERT INTO operators (id, name, token_sha256, slack_user_id, role, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [id, name, hashToken(token), slackUserId, role, now()],
      );
      return { operator: await api.get(id), token };
    },

    get: (id) => store.get(`SELECT * FROM operators WHERE id = ?`, [id]),
    list: () => store.all(`SELECT id, name, slack_user_id, role, active, created_at, last_seen_at FROM operators ORDER BY name`),

    /** Resolves a bearer token to an operator, or null. Inactive never resolves. */
    async byToken(token) {
      if (!token) return null;
      const row = await store.get(`SELECT * FROM operators WHERE token_sha256 = ? AND active = 1`, [
        hashToken(token),
      ]);
      if (!row) return null;
      if (!digestsMatch(row.token_sha256, hashToken(token))) return null;
      await store.run(`UPDATE operators SET last_seen_at = ? WHERE id = ?`, [now(), row.id]);
      return row;
    },

    /**
     * Resolves a Slack user id to an operator.
     *
     * Deliberately NOT "create on first sight": anyone in the workspace could
     * then grant themselves an operator identity by pressing a button. An
     * operator has to be registered first, by someone who already has admin.
     */
    async bySlackUser(slackUserId) {
      if (!slackUserId) return null;
      return store.get(`SELECT * FROM operators WHERE slack_user_id = ? AND active = 1`, [slackUserId]);
    },

    async deactivate(id, { actor = "admin" } = {}) {
      await store.run(`UPDATE operators SET active = 0 WHERE id = ?`, [id]);
      void actor;
      return api.get(id);
    },

    /** Rotates a token in place; the old one stops working immediately. */
    async rotate(id) {
      const token = mintToken();
      const res = await store.run(`UPDATE operators SET token_sha256 = ? WHERE id = ?`, [hashToken(token), id]);
      if (!res?.changes) throw new Error(`unknown operator ${id}`);
      return { operator: await api.get(id), token };
    },
  };
  return api;
}
