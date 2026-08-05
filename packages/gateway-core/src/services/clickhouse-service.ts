import { createClient, type ClickHouseClient } from "@clickhouse/client-web";
import type { ClickHouseRow } from "./span-converter";

/**
 * Request timeout (ms) for ClickHouse operations.
 *
 * The client defaults to 30s when no timeout is set. On the insert path that
 * pairs with `wait_for_async_insert: 1` (see `insertTraces`), a slow/degraded
 * ClickHouse blocks the call until the async buffer flushes — so without a cap
 * each failing attempt hangs for the full 30s before the queue consumer can
 * fail it and retry. That turns a brief ClickHouse hiccup into multi-minute
 * trace-ingestion lag. Capping it lets attempts fail fast so the
 * retry + circuit-breaker machinery takes over. 10s leaves ample headroom for a
 * healthy async flush (sub-second to low single digits) while bounding the bad
 * case. Mirrors the explicit `request_timeout` already set on the health-check
 * client (`health.ts`).
 */
export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Options for trace insertion
 */
export interface InsertTracesOptions {
  /**
   * Deduplication token for idempotent inserts.
   * If provided, ClickHouse will deduplicate inserts with the same token.
   * Token should be deterministic (e.g., hash of request content).
   */
  deduplicationToken?: string;
}

/**
 * Interface for ClickHouse database operations
 */
export interface IClickHouseService {
  /**
   * Insert rows into the otel_traces table
   * @param rows - The rows to insert
   * @param options - Optional settings including deduplication token
   */
  insertTraces(rows: ClickHouseRow[], options?: InsertTracesOptions): Promise<void>;

  /**
   * Execute a query and return results
   */
  query<T>(query: string, params?: Record<string, unknown>): Promise<T[]>;
}

/**
 * Configuration for ClickHouse service
 */
export interface ClickHouseServiceConfig {
  host: string;
  /** Write identity (`analytics_writer`); omit to fall back to `default`. */
  username?: string;
  password: string;
  /**
   * Request timeout in ms. Defaults to {@link CLICKHOUSE_REQUEST_TIMEOUT_MS}.
   * Overridable mainly for tests.
   */
  requestTimeoutMs?: number;
}

/**
 * Real ClickHouse service implementation
 */
export class ClickHouseService implements IClickHouseService {
  private client: ClickHouseClient;

  constructor(config: ClickHouseServiceConfig) {
    this.client = createClient({
      url: config.host,
      ...(config.username ? { username: config.username } : {}),
      password: config.password,
      request_timeout: config.requestTimeoutMs ?? CLICKHOUSE_REQUEST_TIMEOUT_MS,
    });
  }

  async insertTraces(rows: ClickHouseRow[], options?: InsertTracesOptions): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    // Build clickhouse settings with optional deduplication token
    const clickhouse_settings: Record<string, string | number | boolean | undefined> = {
      // Use async inserts with server-side batching for performance.
      // wait_for_async_insert: 1 ensures durability - insert only returns after data is persisted.
      // This is critical for queue-based ingestion where we need confirmation before ack.
      // More info: https://clickhouse.com/blog/clickhouse-release-24-02#adaptive-asynchronous-inserts
      async_insert: 1,
      wait_for_async_insert: 1,
    };

    // Add deduplication token if provided for idempotent inserts
    // This prevents duplicate rows when the same request is retried
    if (options?.deduplicationToken) {
      clickhouse_settings.insert_deduplication_token = options.deduplicationToken;
    }

    await this.client.insert({
      clickhouse_settings,
      table: "otel_traces",
      values: rows,
      format: "JSONEachRow",
    });
  }

  async query<T>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await this.client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });
    return result.json<T>();
  }
}

/**
 * Create a ClickHouse service from config
 */
export function createClickHouseService(config: ClickHouseServiceConfig): IClickHouseService {
  return new ClickHouseService(config);
}
