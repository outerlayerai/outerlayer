/**
 * Metrics OpenAPI Routes
 *
 * `GET /v1/metrics/models` — per-model token spend and latency.
 * `GET /v1/metrics/overview` — fleet-wide behavior tiles, current vs prior period.
 * `GET /v1/metrics/compare` — fleet metrics + topic mix across two explicit windows.
 */

import {
  mapClickHouseError,
  toErrorResponse,
  getErrorStatusCode,
  getTopicMixDeltas,
  ServiceUnavailableError,
} from '@repo/observability-service';
import type { AgentFleetOverviewResponse } from '@repo/observability-service';
import {
  ModelStatsQuerySchema,
  ModelStatsResponseSchema,
  FleetOverviewQuerySchema,
  FleetOverviewResponseSchema,
  CompareWindowsQuerySchema,
  CompareWindowsResponseSchema,
} from '@repo/api-schemas';
import type { CompareWindowsQuery } from '@repo/api-schemas';
import { BaseRoute, type AppContext, getService, buildTenantContext, errorResponse, entitlementRequiredResponse, resolveEnvScope } from './_shared';
import { getGatewayChClient } from '../analytics-factory';
import { resolveTopicsScope } from './topics';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

/**
 * `YYYY-MM-DD`, `days` back from today (UTC). Exported so the `get_model_costs`
 * / `get_fleet_overview` MCP tools default their windows identically to these
 * REST routes — one definition of "trailing N days", not two that can drift.
 */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function today(): string {
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

// ---------------------------------------------------------------------------
// GET /v1/metrics/compare
// ---------------------------------------------------------------------------

/**
 * Projects the `{current, prior}` pair shape `getAgentFleetOverview` always
 * computes down to just `current` — a compare-windows call has no use for
 * either window's own trailing-period baseline, only the two explicit
 * windows the caller named. Exported so the `compare_windows` MCP tool
 * builds the identical shape.
 */
export function flattenFleetWindow(overview: AgentFleetOverviewResponse) {
  return {
    sessions: overview.sessions.current,
    toolErrorRate: overview.toolErrorRate.current,
    cleanSessionRate: overview.cleanSessionRate.current,
    handsOnRate: overview.handsOnRate.current,
    activeActors: overview.activeActors.current,
    totalCost: overview.totalCost.current,
    toolDenialRate: overview.toolDenialRate.current,
    autoApprovedRate: overview.autoApprovedRate.current,
    modelMix: overview.modelMix,
  };
}

/**
 * Shared by the REST handler and the `compare_windows` MCP tool. Runs the
 * two fleet-tile reads and the topic-mix read in parallel — independent
 * queries, no data dependency between them.
 */
export async function compareWindows(c: AppContext, query: CompareWindowsQuery) {
  const service = getService(c);
  const ctx = buildTenantContext(c);
  const topicsScope = await resolveTopicsScope(c);
  const chClient = getGatewayChClient(c.env, { tenantId: topicsScope.tenantId, appId: topicsScope.appId });
  if (!chClient) throw new ServiceUnavailableError('ClickHouse host not configured');

  const [overviewA, overviewB, topicMix] = await Promise.all([
    service.getAgentFleetOverview(ctx, { start: query.aFrom, end: query.aTo }),
    service.getAgentFleetOverview(ctx, { start: query.bFrom, end: query.bTo }),
    getTopicMixDeltas(
      chClient,
      topicsScope,
      query.facet,
      { from: query.aFrom, to: query.aTo },
      { from: query.bFrom, to: query.bTo },
      query.limit,
    ),
  ]);

  return {
    windowA: { from: query.aFrom, to: query.aTo, metrics: flattenFleetWindow(overviewA) },
    windowB: { from: query.bFrom, to: query.bTo, metrics: flattenFleetWindow(overviewB) },
    topicMix,
  };
}

export class GetMetricsCompare extends BaseRoute {
  static requiredPermission: GatewayPermission = 'metrics.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Metrics'],
    summary: 'Compare metrics across two windows',
    operationId: 'compare-windows',
    description:
      'Correlational comparison — not causal attribution: returns fleet-behavior tiles and topic-mix facet-row ' +
      'counts for two EXPLICIT, caller-chosen windows (`a`, `b`; UTC calendar dates), side by side. Neither window ' +
      'defaults — this is for "before vs. after a specific change" (e.g. either side of a context sync from ' +
      '`GET /v1/context/changes`), not a rolling comparison.\n\n' +
      '`topicMix` counts are raw facet rows per topic in each window (not deduplicated to root sessions like ' +
      '`/v1/topics`\' `sessionCount`) — use them to judge relative shift and sample size, not as an exact session total.',
    request: {
      query: CompareWindowsQuerySchema,
    },
    responses: {
      200: {
        description: 'Fleet metrics and topic-mix deltas for both windows.',
        content: {
          'application/json': {
            schema: CompareWindowsResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
      402: entitlementRequiredResponse(
        "Tenant tier does not include the 'topics_enabled' feature.",
      ),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const query = data.query as CompareWindowsQuery;

    try {
      const result = await compareWindows(c, query);
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}
