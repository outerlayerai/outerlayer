/**
 * ClickHouse Client Interface
 *
 * Minimal ClickHouse query interface that can be satisfied by both
 * @clickhouse/client (Node.js) and @clickhouse/client-web (edge).
 * This abstraction allows the analytics service to work in any runtime.
 */

// ============================================================================
// Query Result Interface
// ============================================================================

/**
 * Result of a ClickHouse query.
 * Both @clickhouse/client and @clickhouse/client-web return objects with a json() method.
 *
 * The type parameter on json<T>() allows callers to specify the expected row shape.
 * This matches the API of both @clickhouse/client and @clickhouse/client-web.
 */
export interface QueryResult {
  json<T = unknown>(): Promise<T[]>;
}

// ============================================================================
// ClickHouse Query Interface
// ============================================================================

/**
 * Minimal ClickHouse query interface.
 * Satisfied by both @clickhouse/client (Node.js) and @clickhouse/client-web (edge).
 *
 * @example
 * ```typescript
 * // Node.js client satisfies this interface
 * import { createClient } from '@clickhouse/client';
 * const client: IClickHouseQuery = createClient({ url: '...' });
 *
 * // Web client also satisfies this interface
 * import { createClient } from '@clickhouse/client-web';
 * const webClient: IClickHouseQuery = createClient({ url: '...' });
 * ```
 */
export interface IClickHouseQuery {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
    clickhouse_settings?: Record<string, unknown>;
  }): Promise<QueryResult>;
}

// ============================================================================
// Row-Policy Tenant Scoping
// ============================================================================

/**
 * The identity a policy-scoped read runs as.
 *
 * `tenantId` feeds the `SQL_tenant_id` setting that EVERY ClickHouse row
 * policy keys on (`tenant_isolation*` — migration 29; the analytics MVs
 * joined the tenant key in migration 31, which rebuilt them with a TenantId
 * column). `appId` additionally feeds `SQL_app_id` — no policy keys on it
 * anymore, but keep passing it whenever the request is app-scoped so a
 * future app-keyed policy can rely on it being present; it must be an app id
 * already validated against the tenant (the gateway's `VerifiedAppId`),
 * never caller-chosen.
 */
export interface ReadScope {
  tenantId: string;
  appId?: string;
}

/**
 * Wrap a ClickHouse client so EVERY query it issues carries the row-policy
 * scope settings. When the underlying connection authenticates as the
 * `analytics_readonly` user, ClickHouse itself then filters each covered
 * table to `TenantId = SQL_tenant_id` — the app-layer WHERE clauses stay as
 * defense in depth, but a forgotten or maliciously altered filter can no
 * longer cross tenants.
 *
 * The scope settings are merged LAST, so no per-call `clickhouse_settings`
 * can override them. Fail-closed: if the wrapped connection is the policy'd
 * user and a query somehow reaches ClickHouse without the setting, the
 * policy's `getSetting('SQL_tenant_id')` throws (UNKNOWN_SETTING) rather
 * than returning unfiltered rows.
 */
export function withReadScope(client: IClickHouseQuery, scope: ReadScope): IClickHouseQuery {
  const scopeSettings: Record<string, string> = { SQL_tenant_id: scope.tenantId };
  if (scope.appId) scopeSettings.SQL_app_id = scope.appId;
  return {
    query(params) {
      return client.query({
        ...params,
        clickhouse_settings: { ...params.clickhouse_settings, ...scopeSettings },
      });
    },
  };
}
