/**
 * Analytics Service
 *
 * Re-exports the AnalyticsService from the shared package and provides
 * dashboard-specific factory functions that use the local ClickHouse client,
 * MockAnalyticsService, and environment-aware configuration.
 */

// AnalyticsService and createAnalyticsService are consumed by this module's factory functions.
// QUERY_TIMEOUT_SETTINGS and buildFilterWhereClause moved to @repo/observability-service --
// import directly from that package.
export { AnalyticsService, createAnalyticsService } from '@repo/observability-service';

// Dashboard-specific factory functions that use the local ClickHouse client
import { AnalyticsService } from '@repo/observability-service';
import type { IClickHouseQuery } from '@repo/observability-service';
import type { IAnalyticsService } from './types';
import type { TenantContext } from './tenant-context';
import { createTenantReadClient } from './client';
import { MockAnalyticsService } from './mock-service';
import { analyticsLogger } from './logger';

/**
 * Checks whether ClickHouse should be used in this environment.
 *
 * Returns false when:
 * - CLICKHOUSE_HOST env var is not set
 * - Running on a Vercel preview branch (VERCEL_ENV=preview) where
 *   ClickHouse is not provisioned, even if the env var is set
 */
export function isClickHouseConfigured(): boolean {
  if (process.env.VERCEL_ENV === 'preview') return false;
  return !!process.env.CLICKHOUSE_HOST;
}

/**
 * Builds an analytics service for a single request whose ClickHouse reads run
 * under the row-policy read client (`createTenantReadClient`) scoped to the
 * caller's verified tenant and app. ClickHouse itself then enforces
 * `TenantId = SQL_tenant_id` on every covered table (clickhouse migration 29)
 * and fails closed when the read user is provisioned — the writer-identity
 * singleton is deliberately NOT used for tenant-scoped reads, which would have
 * no policy backstop. The service is per-request (not a shared singleton) so
 * one request's tenant scope can never serve another's.
 *
 * When ClickHouse is not configured (Vercel preview branches, or
 * `CLICKHOUSE_HOST` unset outside preview), returns a `MockAnalyticsService`
 * so dashboards render without a real connection — matching the previous
 * behaviour of the removed singleton.
 *
 * @param ctx - Verified TenantContext (tenant + membership-checked app).
 */
export function getAnalyticsService(ctx: TenantContext): IAnalyticsService {
  // Preview deployments never have ClickHouse provisioned — use mock for demo UI.
  if (process.env.VERCEL_ENV === 'preview') {
    return new MockAnalyticsService();
  }
  if (!process.env.CLICKHOUSE_HOST) {
    // CLICKHOUSE_HOST missing outside a preview environment. Expected on CI / local dev;
    // unexpected in production — log at error so Sentry captures potential misconfiguration.
    analyticsLogger.error('[analytics] CLICKHOUSE_HOST is not set — falling back to MockAnalyticsService. Set CLICKHOUSE_HOST in non-preview environments.', 'not-configured', 'system');
    return new MockAnalyticsService();
  }
  const client = createTenantReadClient({ tenantId: ctx.tenantId, appId: ctx.appId });
  if (!client) {
    return new MockAnalyticsService();
  }
  return new AnalyticsService(client as unknown as IClickHouseQuery);
}
