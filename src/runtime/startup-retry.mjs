const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_MS = 5_000;

export function startupRetryDelayMs(attempt, { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * Wait for an external dependency without crashing the Bun process merely
 * because Swarm attached its overlay network before the dependency was ready.
 * `attempts=0` means keep waiting; Docker health remains red until boot finishes.
 */
export async function withStartupRetry(label, connect, {
  attempts = Number(process.env.SEMANGGI_STARTUP_CONNECT_ATTEMPTS ?? 0),
  baseMs = Number(process.env.SEMANGGI_STARTUP_RETRY_BASE_MS ?? DEFAULT_BASE_MS),
  maxMs = Number(process.env.SEMANGGI_STARTUP_RETRY_MAX_MS ?? DEFAULT_MAX_MS),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console,
} = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await connect();
    } catch (error) {
      if (attempts > 0 && attempt >= attempts) throw error;
      const delayMs = startupRetryDelayMs(attempt, { baseMs, maxMs });
      log.warn?.("startup.dependency-wait", {
        dependency: label,
        attempt,
        retryInMs: delayMs,
        error: String(error?.message ?? error).slice(0, 240),
      });
      await sleep(delayMs);
    }
  }
}
