import "server-only";

/**
 * Maps `items` through `fn`, holding at most `limit` calls in flight at once,
 * and returns results in input order. A large batch of independent git API
 * calls (remote sha reads, blob creates) run unbounded `Promise.all` into a
 * provider's secondary rate limit; this trades a bit of latency for staying
 * under it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index] as T, index);
    }
  }

  // A `limit` of 0 or below would start zero workers and silently resolve
  // with every slot left `undefined` — at least one worker always runs.
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
