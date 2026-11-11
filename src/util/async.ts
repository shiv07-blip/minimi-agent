/** Run async tasks with a concurrency cap — keeps parallel search bursts polite to rate limits. */
export async function pMap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch with timeout + one retry on transient failures. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { timeoutMs = 20_000, retries = 1 }: { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  let lastError: unknown;
  for (let tries = 0; tries <= retries; tries++) {
    try {
      const response = await attempt();
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text().catch(() => '');
        const err = new Error(`Upstream ${response.status}: ${body.slice(0, 200)}`);
        (err as { status?: number }).status = response.status;
        lastError = err;
        if (tries < retries) continue;
        throw err;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (tries >= retries) throw err;
    }
  }
  throw lastError;
}
