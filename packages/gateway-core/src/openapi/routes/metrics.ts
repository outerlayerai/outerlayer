/**
 * Metrics OpenAPI Routes
 *
 * `GET /v1/metrics/models` — per-model token spend and latency.
 * `GET /v1/metrics/overview` — fleet-wide behavior tiles, current vs prior period.
 */

import { mapClickHouseError, toErrorResponse, getErrorStatusCode } from '@repo/observability-service';
import {
  ModelStatsQuerySchema,
  ModelStatsResponseSchema,
  FleetOverviewQuerySchema,
  FleetOverviewResponseSchema,
} from '@repo/api-schemas';
import { BaseRoute, type AppContext, getService, buildTenantContext, errorResponse, resolveEnvScope } from './_shared';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

/** `YYYY-MM-DD`, `days` back from today (UTC). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /v1/metrics/models
// ---------------------------------------------------------------------------

export class GetModelStats extends BaseRoute {
  static requiredPermission: GatewayPermission = 'metrics.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Metrics'],
    summary: 'Get per-model stats',
    operationId: 'get-model-stats',
    description:
      'Returns metered token spend, request counts, and latency per model for the authenticated application, ' +
      'over `from`..`to` (UTC calendar dates, default trailing 7 days).\n\n' +
      'Cost is metered LLM spend for this app only — it excludes seat/subscription costs.',
    request: {
      query: ModelStatsQuerySchema,
    },
    responses: {
      200: {
        description: 'Per-model stats for the requested window.',
        content: {
          'application/json': {
            schema: ModelStatsResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const query = data.query;
    const ctx = buildTenantContext(c);

    try {
      const service = getService(c);
      const envScope = await resolveEnvScope(c);
      const result = await service.getModelStats(
        ctx,
        { start: query.from ?? daysAgo(7), end: query.to ?? today() },
        query.limit,
        undefined,
        envScope,
      );
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

// ---------------------------------------------------------------------------
// GET /v1/metrics/overview
// ---------------------------------------------------------------------------

export class GetFleetOverview extends BaseRoute {
  static requiredPermission: GatewayPermission = 'metrics.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Metrics'],
    summary: 'Get fleet overview',
    operationId: 'get-fleet-overview',
    description:
      'Returns fleet-wide agent behavior tiles (sessions, tool-error rate, hands-on rate, spend, and more) for `from`..`to` ' +
      '(UTC calendar dates, default trailing 30 days), each as a `{ current, prior }` pair against the equal-length preceding period. ' +
      'Call twice with explicit windows to compare before/after a change.',
    request: {
      query: FleetOverviewQuerySchema,
    },
    responses: {
      200: {
        description: 'Fleet overview tiles for the requested window.',
        content: {
          'application/json': {
            schema: FleetOverviewResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const query = data.query;
    const ctx = buildTenantContext(c);

    try {
      const service = getService(c);
      const result = await service.getAgentFleetOverview(ctx, {
        start: query.from ?? daysAgo(30),
        end: query.to ?? today(),
      });
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}
