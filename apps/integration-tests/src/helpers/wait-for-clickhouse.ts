import { queryClickHouse, executeClickHouse } from '../../clickhouse/setup-clickhouse';

interface WaitForClickHouseDataOptions {
  /** ClickHouse SQL query to execute */
  query: string;
  /** Condition function — return true when data is ready */
  condition: (rows: any[]) => boolean;
  /** Maximum time to wait in milliseconds (default: 25_000 — must stay under Jest's 30s testTimeout) */
  timeoutMs?: number;
  /** Initial polling interval in milliseconds (default: 100) */
  intervalMs?: number;
  /** Multiplier for exponential backoff (default: 1.5) */
  backoffMultiplier?: number;
}

/**
 * Polls ClickHouse until the given condition is met, with exponential backoff.
 * Replaces hardcoded setTimeout delays with deterministic data-readiness checks.
 *
 * @throws Error if timeout is reached before condition is satisfied
 */
export async function waitForClickHouseData({
  query,
  condition,
  timeoutMs = 25_000,
  intervalMs = 100,
  backoffMultiplier = 1.5,
}: WaitForClickHouseDataOptions): Promise<any[]> {
  const start = Date.now();
  let currentInterval = intervalMs;

  while (Date.now() - start < timeoutMs) {
    const rows = await queryClickHouse(query);
    if (condition(rows)) {
      return rows;
    }
    await new Promise(resolve => setTimeout(resolve, currentInterval));
    currentInterval = Math.min(currentInterval * backoffMultiplier, 2000);
  }

  throw new Error(
    `waitForClickHouseData timed out after ${timeoutMs}ms. Query: ${query}`
  );
}

/**
 * Flushes ClickHouse async insert queue and waits until data is queryable.
 */
export async function flushAndWaitForClickHouse(
  query: string,
  condition: (rows: any[]) => boolean,
  timeoutMs = 25_000,
): Promise<any[]> {
  await executeClickHouse('SYSTEM FLUSH ASYNC INSERT QUEUE');
  return waitForClickHouseData({ query, condition, timeoutMs });
}
