/**
 * ClickHouse Client Factory
 *
 * Provides a factory function for creating ClickHouse clients,
 * enabling dependency injection for testing while maintaining
 * a default instance for production use.
 */

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { parseEnvBoolean } from '@repo/adapter-config';
import {
  CLICKHOUSE_HOST,
  CLICKHOUSE_PASSWORD,
  CLICKHOUSE_READ_USER,
  CLICKHOUSE_READ_PASSWORD,
  CLICKHOUSE_ALLOW_UNSCOPED_READS,
} from '../../config-global.server';

/**
 * Read NODE_ENV at call time, not module load. The analytics client is
 * imported by tests that set it per-case, and a module-level capture would
 * freeze whichever value happened to be present at import.
 */
const isProduction = () => process.env.NODE_ENV === 'production';

const unscopedReadsAllowed = () =>
  parseEnvBoolean(CLICKHOUSE_ALLOW_UNSCOPED_READS) === true;

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration options for creating a ClickHouse client.
 */
export interface ClickHouseConfig {
  /** ClickHouse server URL (HTTP interface) */
  url?: string;
  /** Password for authentication */
  password?: string;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Database name (default: 'default') */
  database?: string;
}

/**
 * Default query settings applied to all queries.
 * These can be overridden per-query.
 */
export const DEFAULT_QUERY_SETTINGS: Record<string, string | number | boolean> = {
  /** Maximum query execution time in seconds */
  max_execution_time: 30,
  /** Maximum memory usage per query (1GB) */
  max_memory_usage: 1_000_000_000,
  /** Maximum rows to scan per query (10M) */
  max_rows_to_read: 10_000_000,
  /**
   * Spill oversized GROUP BY / ORDER BY state to disk at half the per-query
   * memory budget: a heavy aggregation finishes slowly instead of dying at
   * the cap — and can't ride a small deployment into its server-wide memory
   * ceiling, where it takes unrelated queries down with it.
   */
  max_bytes_before_external_group_by: 500_000_000,
  max_bytes_before_external_sort: 500_000_000,
};

// ============================================================================
// Transient-failure retry (shared)
// ============================================================================

/**
 * Error signatures worth ONE retry: the analytics store shedding load —
 * memory pressure, timeouts, dropped connections — where a second attempt a
 * moment later usually lands on a recovered server. Query bugs (syntax,
 * unknown columns, access) never match and fail fast.
 */
const TRANSIENT_CLICKHOUSE_ERROR =
  /MEMORY_LIMIT_EXCEEDED|Code:\s*241|TIMEOUT_EXCEEDED|Code:\s*159|TOO_MANY_SIMULTANEOUS_QUERIES|Code:\s*202|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i;

/** Pause before the single retry — long enough for a memory spike or merge burst to pass. */
const TRANSIENT_RETRY_DELAY_MS = 1_500;

/**
 * Wraps a client so reads (`query`) survive ONE transient failure instead of
 * bubbling a 500 out of whichever endpoint happened to run first — every
 * CH-backed route gets this in one place, not per-feature. Only `query`
 * retries: SELECTs are idempotent; `insert`/`command`/`exec` pass through
 * untouched (re-running a write is the caller's decision).
 */
function withTransientRetry(client: ClickHouseClient): ClickHouseClient {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== 'query') {
        // Bind pass-through methods to the REAL client — its internals may
        // depend on `this` being the underlying instance, not the proxy.
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
      return async (...args: Parameters<ClickHouseClient['query']>) => {
        try {
          return await target.query(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!TRANSIENT_CLICKHOUSE_ERROR.test(message)) throw error;
          console.warn(
            `[analytics] transient ClickHouse error, retrying once: ${message.slice(0, 160)}`,
          );
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
          return target.query(...args);
        }
      };
    },
  }) as ClickHouseClient;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ClickHouse client instance.
 *
 * Use this factory for:
 * - Testing with custom configuration
 * - Creating isolated clients for specific use cases
 * - Injecting dependencies into services
 *
 * @param config - Optional configuration overrides
 * @returns A new ClickHouseClient instance
 *
 * @example
 * ```typescript
 * // Production - uses environment variables
 * const client = createClickHouseClient();
 *
 * // Testing - custom URL
 * const testClient = createClickHouseClient({
 *   url: 'http://localhost:8123',
 *   password: 'test_password',
 * });
 * ```
 */
export function createClickHouseClient(config?: ClickHouseConfig): ClickHouseClient | null {
  const url = config?.url ?? CLICKHOUSE_HOST;
  const password = config?.password ?? CLICKHOUSE_PASSWORD;

  if (!url) {
    console.warn('ClickHouse not configured — analytics features will be unavailable. Set CLICKHOUSE_HOST to enable.');
    return null;
  }

  return withTransientRetry(
    createClient({
      url,
      password: password || undefined,
      database: config?.database ?? 'default',
      request_timeout: config?.requestTimeout ?? 30000,
      clickhouse_settings: {
        ...DEFAULT_QUERY_SETTINGS,
      },
    }),
  );
}

// ============================================================================
// Tenant-Scoped Read Client (row-policy isolation)
// ============================================================================

/** Identity for a policy-scoped read. Values MUST come from the request's
 * resolved auth context (session → tenant, membership-checked app), never
 * from request input. (Not exported: `import/no-unused-modules` is enforced —
 * export it when a consumer needs the name; call sites pass literals.) */
interface TenantReadScope {
  tenantId: string;
  /** Set when the read is app-scoped; feeds `SQL_app_id` for the two
   * analytics MVs whose policies key on AppId (no TenantId column). */
  appId?: string;
}

let _warnedUnscopedIdentity = false;

/**
 * Create a ClickHouse client whose EVERY query carries the row-policy scope
 * settings (`SQL_tenant_id`, and `SQL_app_id` when app-scoped) and — when
 * `CLICKHOUSE_READ_USER` is configured — authenticates as the
 * `analytics_reader` user, so ClickHouse itself enforces
 * `TenantId = SQL_tenant_id` on every covered table (clickhouse migration
 * 29). App-layer WHERE clauses stay as defense in depth; a forgotten or
 * maliciously altered filter can no longer cross tenants.
 *
 * Without `CLICKHOUSE_READ_USER` (bare self-host, local dev before
 * `yarn clickhouse:read-user:dev`) the client falls back to the writer
 * identity: the settings are still sent (harmless) but the policy layer is
 * inert — warned once per process so the downgrade is visible.
 *
 * Use for TENANT-scoped API routes. Platform-admin and cron surfaces that
 * legitimately read across tenants keep `createClickHouseClient()` /
 * `getDefaultClient()` (the writer identity) — that split is deliberate: a
 * platform read under a tenant policy would silently return one tenant's rows.
 */
export function createTenantReadClient(scope: TenantReadScope): ClickHouseClient | null {
  if (!CLICKHOUSE_HOST) {
    console.warn('ClickHouse not configured — analytics features will be unavailable. Set CLICKHOUSE_HOST to enable.');
    return null;
  }

  if (!CLICKHOUSE_READ_USER) {
    // Fail closed in production. Reading as the writer identity means no row
    // policy applies, so a forgotten or altered app-layer WHERE crosses
    // tenants silently. An analytics endpoint that errors is recoverable; one
    // that serves another tenant's rows is not.
    if (isProduction() && !unscopedReadsAllowed()) {
      throw new Error(
        'CLICKHOUSE_READ_USER is not set. Tenant-scoped ClickHouse reads would run as the ' +
          'writer identity, which no row policy covers, leaving tenant isolation to app-layer ' +
          'WHERE clauses alone. Provision the read user (see clickhouse/ensure-read-user.mjs) ' +
          'and set CLICKHOUSE_READ_USER / CLICKHOUSE_READ_PASSWORD. Self-hosters who accept ' +
          'app-layer-only isolation can set CLICKHOUSE_ALLOW_UNSCOPED_READS=true.',
      );
    }
    if (!_warnedUnscopedIdentity) {
      _warnedUnscopedIdentity = true;
      console.warn(
        '[analytics] CLICKHOUSE_READ_USER unset — tenant reads run as the writer identity; ' +
          'row-policy tenant isolation is NOT enforced by ClickHouse on this deployment. ' +
          'Run `yarn clickhouse:read-user:dev` to match production.',
      );
    }
  }

  // Client-level clickhouse_settings are sent with every query issued through
  // this client, so the scope cannot be dropped by an individual call site.
  const scopeSettings: Record<string, string> = { SQL_tenant_id: scope.tenantId };
  if (scope.appId) scopeSettings.SQL_app_id = scope.appId;

  return withTransientRetry(
    createClient({
      url: CLICKHOUSE_HOST,
      username: CLICKHOUSE_READ_USER || undefined,
      password: (CLICKHOUSE_READ_USER ? CLICKHOUSE_READ_PASSWORD : CLICKHOUSE_PASSWORD) || undefined,
      database: 'default',
      request_timeout: 30000,
      clickhouse_settings: {
        ...DEFAULT_QUERY_SETTINGS,
        ...scopeSettings,
      },
    }),
  );
}

// ============================================================================
// Default Instance (Lazy Singleton)
// ============================================================================

/**
 * Lazily-initialized default client instance.
 * Use getDefaultClient() to access.
 */
let _defaultClient: ClickHouseClient | null = null;

/**
 * Gets the default ClickHouse client instance.
 *
 * Uses lazy initialization to avoid creating a client during module load.
 * The client is created on first access using environment variables.
 *
 * For production use where DI is not needed.
 *
 * @returns The default ClickHouseClient instance
 *
 * @example
 * ```typescript
 * // In production code
 * const client = getDefaultClient();
 * const result = await client.query({ query: 'SELECT 1' });
 * ```
 */
export function getDefaultClient(): ClickHouseClient | null {
  if (!_defaultClient) {
    _defaultClient = createClickHouseClient();
  }
  return _defaultClient;
}

/**
 * Resets the default client instance.
 *
 * **For testing only.** Use this to clear the cached client
 * between tests to ensure a fresh instance.
 *
 * @example
 * ```typescript
 * // In test teardown
 * afterEach(() => {
 *   resetDefaultClient();
 * });
 * ```
 */
export function resetDefaultClient(): void {
  if (_defaultClient) {
    // Close the existing client connection
    _defaultClient.close().catch(() => {
      // Ignore close errors during reset
    });
  }
  _defaultClient = null;
}

// ============================================================================
// Re-export Types
// ============================================================================

export type { ClickHouseClient };
