// Structured operational logging.
//
// The controller already keeps an append-only EventLog, which is the audit
// record. This is a different thing: a stream an operator can `docker service
// logs` and follow while something is going wrong, correlatable by eye with the
// gateway's own log lines and the sandbox container's output.
//
// Why both. The EventLog answers "what did the system decide, and when" after
// the fact; it lives in SQLite on NFS and is queried. A log line answers "what
// is happening right now" and survives even when the database is the thing
// misbehaving. During this build, several hours went into diagnosing a misroute
// that a single line naming the chosen agent would have settled immediately —
// that is the concrete argument for this file existing.
//
// FORMAT
//
// One JSON object per line. Human-readable enough to skim, parseable enough to
// grep with `jq`. Every line carries `at`, `evt`, and — where it makes sense —
// `task` and `exec`, which are the two ids that thread through every layer:
//
//   controller  task=TASK-5F2F664B  exec=TASK-5F2F664B#1
//   gateway     runId=TASK-5F2F664B#1        (the idempotencyKey we sent)
//               label=TASK-5F2F664B          (the task id)
//   sandbox     container name + workspace label
//
// So `grep TASK-5F2F664B` across all three layers reconstructs one task's life.
// That correlation is not accidental: the execution id IS the idempotency key
// IS the gateway's runId (D15), and `label` was set to the task id for exactly
// this reason.

const SECRET_RE = /(token|secret|password|api[_-]?key|authorization|cookie|bearer)/i;

/** Same rule as the EventLog: a log line must never become a credential leak. */
export function scrub(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Long opaque strings are usually keys. Truncating keeps them useless while
    // still letting an operator tell two different values apart.
    return value.length > 200 ? `${value.slice(0, 60)}…(${value.length} chars)` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_RE.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

export function createLogger({
  service = "controller",
  write = (line) => process.stdout.write(line + "\n"),
  now = () => Date.now(),
  level = process.env.SEMANGGI_LOG_LEVEL ?? "info",
} = {}) {
  const RANK = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = RANK[level] ?? RANK.info;

  function emit(sev, evt, fields = {}) {
    if ((RANK[sev] ?? RANK.info) < min) return;
    const line = {
      at: new Date(now()).toISOString(),
      svc: service,
      sev,
      evt,
      ...scrub(fields),
    };
    try {
      write(JSON.stringify(line));
    } catch {
      // Logging must never be able to take the process down. A field that will
      // not serialise is worth losing; the run is not.
      write(JSON.stringify({ at: new Date(now()).toISOString(), svc: service, sev: "warn", evt: "log.unserialisable", of: evt }));
    }
  }

  return {
    debug: (evt, f) => emit("debug", evt, f),
    info: (evt, f) => emit("info", evt, f),
    warn: (evt, f) => emit("warn", evt, f),
    error: (evt, f) => emit("error", evt, f),

    /** Child logger that stamps every line with the same correlation fields. */
    child(base = {}) {
      const parent = this;
      return {
        debug: (evt, f) => parent.debug(evt, { ...base, ...f }),
        info: (evt, f) => parent.info(evt, { ...base, ...f }),
        warn: (evt, f) => parent.warn(evt, { ...base, ...f }),
        error: (evt, f) => parent.error(evt, { ...base, ...f }),
        child: (more) => parent.child({ ...base, ...more }),
      };
    },
  };
}

/** A no-op logger, so a component can always assume it has one. */
export const nullLogger = createLogger({ write: () => {} });
