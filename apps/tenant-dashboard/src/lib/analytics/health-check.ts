/**
 * Analytics Health Check (shared)
 *
 * Executes the ClickHouse connectivity probe and renders the JSON response
 * shared by the two PUBLIC analytics uptime endpoints:
 *
 *   - GET /api/analytics        — BetterStack uptime-monitor target
 *   - GET /api/analytics/health — dashboard-internal health aggregation
 *
 * Both are excluded from the analytics auth middleware (see `proxy.ts`
 * matcher), so this probe never sees tenant data — it only confirms the
 * analytics backend is reachable. Returns 200 when ClickHouse answers the
 * probe query, 503 otherwise.
 */

import { NextResponse } from 'next/server';
import { getDefaultClient } from './client';
import { HEALTH_CHECK_QUERY } from './queries';
import { analyticsLogger, createTimer } from './logger';
import type { HealthResponse } from './types';

export async function analyticsHealthResponse(): Promise<NextResponse> {
  const timer = createTimer();
  const timestamp = new Date().toISOString();

  try {
    const client = getDefaultClient();

    if (!client) {
      const response: HealthResponse = {
        status: 'unhealthy',
        timestamp,
        dependencies: {
          clickhouse: {
            status: 'down',
            latencyMs: 0,
            error: 'ClickHouse not configured. Set CLICKHOUSE_HOST to enable analytics.',
          },
        },
      };
      return NextResponse.json(response, { status: 503 });
    }

    // Execute simple health check query
    await client.query({
      query: HEALTH_CHECK_QUERY,
      format: 'JSONEachRow',
    });

    const latencyMs = timer.elapsed();

    // Log health check
    analyticsLogger.health('healthy', latencyMs);

    const response: HealthResponse = {
      status: 'healthy',
      timestamp,
      dependencies: {
        clickhouse: {
          status: 'up',
          latencyMs,
        },
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    const latencyMs = timer.elapsed();
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Log unhealthy status
    analyticsLogger.health('unhealthy', latencyMs, errorMessage);

    const response: HealthResponse = {
      status: 'unhealthy',
      timestamp,
      dependencies: {
        clickhouse: {
          status: 'down',
          latencyMs,
          error: errorMessage,
        },
      },
    };

    return NextResponse.json(response, { status: 503 });
  }
}
