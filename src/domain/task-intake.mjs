// POC-12 task intake is deliberately deterministic. It decides whether a
// request benefits from visible child tasks; it does not pretend to understand
// the request well enough to invent semantic steps. The existing structural
// decompose.mjs remains the one source of phase definitions.

export const PlanMode = Object.freeze({
  DIRECT: "DIRECT_EXECUTION",
  LIGHTWEIGHT: "LIGHTWEIGHT_PLAN",
  FULL: "FULL_WORKPLAN",
});

const MODES = new Set(Object.values(PlanMode));

export function analyzeTaskIntake({ title = "", description = "", planMode = null } = {}) {
  if (planMode !== null && planMode !== undefined && !MODES.has(planMode)) {
    throw new Error(`planMode must be one of ${[...MODES].join("/")}`);
  }

  const text = `${title}\n${description}`.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const signals = [];
  let score = 0;
  const add = (points, reason) => { score += points; signals.push(reason); };

  if (words >= 80) add(2, "long-request");
  else if (words >= 35) add(1, "medium-request");
  if (/\n\s*(?:[-*]|\d+[.)])\s+/.test(text)) add(2, "explicit-list");
  if (/\b(?:then|after|before|dependency|depends|blocked by|setelah|sebelum|bergantung)\b/i.test(text)) add(2, "dependency-language");
  if (/\b(?:parallel|concurrent|simultaneous|paralel|bersamaan)\b/i.test(text)) add(2, "parallel-work");
  if (/\b(?:api|database|schema|backend|frontend|ui|migration|deploy|security|test|build)\b/gi.test(text)) {
    const areas = new Set((text.match(/\b(?:api|database|schema|backend|frontend|ui|migration|deploy|security|test|build)\b/gi) ?? []).map((s) => s.toLowerCase()));
    if (areas.size >= 3) add(2, "cross-area");
    else if (areas.size >= 2) add(1, "multi-area");
  }
  if (/\b(?:and|also|plus|serta|dan juga|sekaligus)\b/i.test(text)) add(1, "multiple-actions");

  const inferred = score >= 6 ? PlanMode.FULL : score >= 3 ? PlanMode.LIGHTWEIGHT : PlanMode.DIRECT;
  const mode = planMode ?? inferred;
  return {
    planMode: mode,
    complexityScore: score,
    shouldDecompose: mode !== PlanMode.DIRECT,
    reason: planMode ? `operator:${planMode}` : (signals.join(",") || "single-bounded-action"),
  };
}

export function progressForChildren(children = []) {
  const total = children.length;
  const complete = children.filter((t) => t.status === "COMPLETE").length;
  const blocked = children.filter((t) => ["BLOCKED", "FAILED", "WAIT_HUMAN"].includes(t.status)).length;
  const active = children.filter((t) => ["QUEUED", "DISPATCHED", "RUNNING", "RESUMABLE"].includes(t.status)).length;
  const state = total === 0
    ? "EMPTY"
    : complete === total
      ? "COMPLETE"
      : blocked > 0
        ? "NEEDS_ATTENTION"
        : complete > 0 || active > 0
          ? "IN_PROGRESS"
          : "WAITING";
  return {
    state,
    total,
    complete,
    blocked,
    active,
    percent: total === 0 ? 0 : Math.round((complete / total) * 100),
  };
}
