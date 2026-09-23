// EventLog — append-only audit trail (POC-4 §4, P4-01).
//
// Every decision the scheduler makes is written here, including the boring ones
// ("task parked on quota"), because the empirical routing report in §12.4 is
// derived from this table and a decision that was never recorded cannot be
// evaluated later.

export const EventKind = Object.freeze({
  TASK_CREATED: "task.created",
  TASK_STATUS: "task.status",
  TASK_CANCELLED: "task.cancelled",
  TASK_EXPEDITED: "task.expedited",
  TASK_DELETED: "task.deleted",
  REVISION_CREATED: "revision.created",
  CHECKPOINT_CREATED: "checkpoint.created",
  TASK_DECOMPOSED: "task.decomposed",
  DISPATCH_DECISION: "dispatch.decision",
  DISPATCH_SENT: "dispatch.sent",
  DISPATCH_FAILED: "dispatch.failed",
  EXECUTION_STATUS: "execution.status",
  QUOTA_DECISION: "quota.decision",
  RESOURCE_AVAILABILITY: "resource.availability",
  // D66: operator writes through the Model Map page. Availability signals are
  // the scheduler's own findings about the world; these two are the operator's
  // decisions about policy — the audit trail must be able to tell them apart.
  RESOURCE_POLICY: "resource.policy",
  THINKING_LEVELS_UPDATED: "thinking-levels.updated",
  LEASE_ACQUIRED: "lease.acquired",
  LEASE_RELEASED: "lease.released",
  LEASE_RECLAIMED: "lease.reclaimed",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_DECIDED: "approval.decided",
  // POC-10: audit chat. Tidak ada `chat.sandbox-released` — pelepasan sandbox
  // chat selalu manual lewat Process Manager (D78) dan kill sudah tercatat di
  // sana; mengauditnya dua kali di dua tempat adalah dua jejak yang bisa
  // saling bertengkar soal urutan.
  CHAT_SESSION_CREATED: "chat.session-created",
  CHAT_MESSAGE_SENT: "chat.message-sent",
  CHAT_SANDBOX_PROVISIONED: "chat.sandbox-provisioned",
});

// Payloads are audit data, not a place to stash credentials. Anything matching
// these names is redacted before it reaches the table, so a careless caller
// cannot turn the audit log into a secret leak (P4-13).
const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie)/i;

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function createEventLog(store, { now = () => Date.now() } = {}) {
  return {
    async append({ kind, subjectType, subjectId, actor = "controller", payload = {} }) {
      if (!kind) throw new Error("event kind is required");
      await store.run(
        `INSERT INTO event_log (at, kind, subject_type, subject_id, actor, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [now(), kind, subjectType, String(subjectId), actor, JSON.stringify(redact(payload))],
      );
    },

    async list({ subjectType, subjectId, kind, limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (subjectType) (where.push("subject_type = ?"), params.push(subjectType));
      if (subjectId) (where.push("subject_id = ?"), params.push(String(subjectId)));
      if (kind) (where.push("kind = ?"), params.push(kind));
      const sql = `SELECT * FROM event_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY seq ASC LIMIT ?`;
      const rows = await store.all(sql, [...params, limit]);
      return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
  };
}
