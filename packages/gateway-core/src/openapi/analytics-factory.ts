import { AnalyticsService, createAnalyticsService, withReadScope } from '@repo/observability-service';
import type { IClickHouseQuery, QueryResult, ReadScope } from '@repo/observability-service';
import { createClient } from '@clickhouse/client-web';
import { clickHouseWriteAuth } from '../stores/clickhouse/write-identity';
import { parseEnvBoolean } from '@repo/adapter-config';

/**
 * Adapts @clickhouse/client-web to the IClickHouseQuery interface.
 *
 * The web client has stricter types (DataFormat enum, typed ClickHouseSettings)
 * than our generic interface. The adapter bridges this at the boundary rather
 * than leaking web-client types into the shared analytics-service package.
 */
function createClickHouseAdapter(host: string, password: string, username?: string): IClickHouseQuery {
  const client = createClient({ url: host, password, ...(username ? { username } : {}) });
  return {
    async query(params): Promise<QueryResult> {
      const result = await client.query({
        query: params.query,
        query_params: params.query_params,
        // IClickHouseQuery accepts string; web client requires DataFormat enum.
        // 'JSONEachRow' is always valid — this is a safe narrowing, not a widening cast.
        format: (params.format ?? 'JSONEachRow') as 'JSONEachRow',
        clickhouse_settings: params.clickhouse_settings as Record<string, string | number | boolean> | undefined,
      });
      return {
        async json<T = unknown>(): Promise<T[]> {
          // Web client's json() returns T[] | Record<string,T> | ResponseJSON<T>.
          // With JSONEachRow format, it always returns T[].
          const data = await result.json();
          return data as T[];
        },
      };
    },
  };
}

interface AnalyticsEnv {
  CLICKHOUSE_HOST?: string;
  CLICKHOUSE_PASSWORD?: string;
  /**
   * Credentials for the `analytics_reader` user (role `analytics_readonly`,
   * migration 29). When set, every analytics read runs under the ClickHouse
   * row policies — tenant isolation enforced by the database, not just the
   * app-layer WHERE clauses. When unset (bare self-host, local dev before
   * `yarn clickhouse:read-user:dev`), reads fall back to the writer identity
   * and the policy layer is inert. That fallback is refused outright when
   * NODE_ENV is production, unless CLICKHOUSE_ALLOW_UNSCOPED_READS says
   * otherwise; elsewhere it warns once per isolate.
   */
  CLICKHOUSE_READ_USER?: string;
  CLICKHOUSE_READ_PASSWORD?: string;
  /** Self-host escape hatch for the production guard below. Opt-in. */
  CLICKHOUSE_ALLOW_UNSCOPED_READS?: string;
  NODE_ENV?: string;
  /**
   * Write identity (`analytics_writer`, migration 47). Only consulted on the
   * no-read-user fallback below, so the unscoped downgrade still authenticates
   * as the least-privilege writer rather than the `default` superuser.
   */
  CLICKHOUSE_WRITE_USER?: string;
  CLICKHOUSE_WRITE_PASSWORD?: string;
}

/**
 * Module-level singleton BASE adapter (one HTTP client per isolate). In CF
 * Workers this is shared across requests within an isolate. If ClickHouse
 * credentials rotate, the isolate must be recycled (new deployment) to pick up
 * the new password. This is acceptable since credential rotation triggers a
 * deploy.
 */
let _baseAdapter: IClickHouseQuery | null = null;
let _warnedUnscopedIdentity = false;

/**
 * Per-request analytics service, scoped to the authenticated tenant (and
 * verified app, when the request carries one). The underlying HTTP client is
 * a shared singleton; the scoping wrapper + service facade are cheap
 * per-request objects. `scope.tenantId`/`scope.appId` MUST come from the auth
 * middleware (`c.get('user')`) — never from request input.
 */
export function getGatewayAnalyticsService(env: AnalyticsEnv, scope: ReadScope): AnalyticsService | null {
  if (!env.CLICKHOUSE_HOST) return null;
  if (!_baseAdapter) {
    if (env.CLICKHOUSE_READ_USER) {
      _baseAdapter = createClickHouseAdapter(
        env.CLICKHOUSE_HOST,
        env.CLICKHOUSE_READ_PASSWORD || '',
        env.CLICKHOUSE_READ_USER,
      );
    } else {
      // Fail closed in production. Without the read user no row policy applies,
      // so tenant isolation rests entirely on app-layer WHERE clauses.
      if (env.NODE_ENV === 'production' && parseEnvBoolean(env.CLICKHOUSE_ALLOW_UNSCOPED_READS) !== true) {
        throw new Error(
          'CLICKHOUSE_READ_USER is not set. Analytics reads would run as the writer identity, ' +
            'which no row policy covers, leaving tenant isolation to app-layer WHERE clauses ' +
            'alone. Provision the read user and set CLICKHOUSE_READ_USER / ' +
            'CLICKHOUSE_READ_PASSWORD, or set CLICKHOUSE_ALLOW_UNSCOPED_READS=true to accept it.',
        );
      }
      if (!_warnedUnscopedIdentity) {
        _warnedUnscopedIdentity = true;
        console.warn(
          '[analytics] CLICKHOUSE_READ_USER unset — reads run as the writer identity; ' +
            'row-policy tenant isolation is NOT enforced by ClickHouse on this deployment.',
        );
      }
      const writeAuth = clickHouseWriteAuth(env);
      _baseAdapter = createClickHouseAdapter(
        env.CLICKHOUSE_HOST,
        writeAuth.password,
        'username' in writeAuth ? writeAuth.username : undefined,
      );
    }
  }
  return createAnalyticsService(withReadScope(_baseAdapter, scope));
}

export function resetGatewayAnalyticsService(): void {
  _baseAdapter = null;
  _warnedUnscopedIdentity = false;
}
