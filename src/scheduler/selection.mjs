// Candidate ordering — POC-4 §5.2.
//
// Not a pure priority queue: a busy P1 project must not starve a weight-1
// project forever (P4-04). Ordering is therefore weighted fair queueing across
// projects, with priority applied *within* a project, and one deliberate
// exception: P0 Emergency preempts fairness entirely.

export const EXPEDITE_BOOST_LEVELS = 2;

/** Priority after any live expedite boost. Lower number = more urgent. */
export function effectivePriority(task, now) {
  const expedited = task.expedite_until != null && task.expedite_until > now;
  return expedited ? Math.max(0, task.priority - EXPEDITE_BOOST_LEVELS) : task.priority;
}

/** True while the boost is live; used by the API to report expedite state. */
export function isExpedited(task, now) {
  return task.expedite_until != null && task.expedite_until > now;
}

const byUrgency = (now) => (a, b) => {
  const pa = effectivePriority(a, now);
  const pb = effectivePriority(b, now);
  if (pa !== pb) return pa - pb;
  // A boost that lands on a tie would otherwise be invisible, and an operator
  // who expedites a task expects it to move. Live expedites break ties.
  const ea = isExpedited(a, now) ? 0 : 1;
  const eb = isExpedited(b, now) ? 0 : 1;
  if (ea !== eb) return ea - eb;
  return a.created_at - b.created_at; // FIFO within equal urgency
};

/**
 * Order queued tasks for admission.
 *
 * @param tasks        candidate tasks (already filtered to admissible statuses)
 * @param projects     Map<projectId, {weight}>
 * @param dispatchCounts Map<projectId, number> — dispatches so far in the
 *                     fairness window. Persisted counters, not in-memory, so
 *                     fairness survives a controller restart (P4-11).
 */
export function orderCandidates(tasks, { projects, dispatchCounts = new Map(), now = Date.now() } = {}) {
  if (tasks.length === 0) return [];

  const urgent = byUrgency(now);
  const emergency = tasks.filter((t) => effectivePriority(t, now) === 0).sort(urgent);
  const rest = tasks.filter((t) => effectivePriority(t, now) !== 0);

  const queues = new Map();
  for (const task of rest) {
    if (!queues.has(task.project_id)) queues.set(task.project_id, []);
    queues.get(task.project_id).push(task);
  }
  for (const q of queues.values()) q.sort(urgent);

  // Virtual-finish-time WFQ: the next project served is the one whose next
  // dispatch would land earliest on the weighted timeline. A project with
  // weight 5 is served ~5x as often as weight 1, and weight 1 is always served
  // eventually because its virtual time stops advancing while it waits.
  const counters = new Map();
  for (const projectId of queues.keys()) counters.set(projectId, dispatchCounts.get(projectId) ?? 0);

  const ordered = [];
  while (queues.size > 0) {
    let bestProject = null;
    let bestVirtual = Infinity;
    for (const projectId of queues.keys()) {
      const weight = Math.max(1, projects.get(projectId)?.weight ?? 1);
      const virtual = (counters.get(projectId) + 1) / weight;
      if (
        virtual < bestVirtual ||
        // Deterministic tie-break so ordering is reproducible in tests and logs.
        (virtual === bestVirtual && String(projectId) < String(bestProject))
      ) {
        bestVirtual = virtual;
        bestProject = projectId;
      }
    }
    const queue = queues.get(bestProject);
    ordered.push(queue.shift());
    counters.set(bestProject, counters.get(bestProject) + 1);
    if (queue.length === 0) queues.delete(bestProject);
  }

  return [...emergency, ...ordered];
}
