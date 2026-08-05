/**
 * Analytics API Root — public uptime endpoint.
 *
 * GET /api/analytics
 *
 * The BetterStack uptime monitor probes the bare `/api/analytics` path. There
 * was no handler at this segment (only nested routes like `/metrics`,
 * `/traces`, `/health`), so the request fell through to the auth middleware,
 * which answers unauthenticated callers with `401 UNAUTHORIZED`. The monitor
 * read that 401 as an analytics-API outage even while ClickHouse was healthy.
 *
 * This mirrors `/api/analytics/health` so the monitored URL reflects real
 * ClickHouse connectivity: 200 when reachable, 503 when down. It is excluded
 * from the analytics auth middleware (see the `proxy.ts` matcher) and requires
 * no authentication — the probe only touches the health-check query, never
 * tenant data.
 */

import { analyticsHealthResponse } from '@/lib/analytics/health-check';

export async function GET() {
  return analyticsHealthResponse();
}
