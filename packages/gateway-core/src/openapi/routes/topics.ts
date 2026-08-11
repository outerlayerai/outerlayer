/**
 * Topics OpenAPI Route
 *
 * `GET /v1/topics` — the active topic map for the caller's environment,
 * live-refreshed session counts, snapshot-computed outcome metrics.
 */

import { mapClickHouseError, toErrorResponse, getErrorStatusCode, ServiceUnavailableError } from '@repo/observability-service';
import { TopicsQuerySchema, TopicsResponseSchema } from '@repo/api-schemas';
import type { TopicsScope } from '@repo/observability-service';
import { BaseRoute, type AppContext, errorResponse, resolveEnvScope, getScopedSupabase } from './_shared';
import { getGatewayTopicsService } from '../analytics-factory';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

/**
 * Resolve the single environment a topics read scopes to.
 *
 * `resolveEnvScope` returns a single pinned environment for an env-bound
 * API key, but topics reads (unlike spans/scores) have no multi-environment
 * query path — `TopicsScope` carries exactly one `environment` name. A
 * kind-scoped key (multiple candidate environments) or an unbound key
 * (bearer auth, or a key with no environment binding) falls back to the
 * app's default environment, same as an unbound dashboard view.
 */
export async function resolveTopicsScope(c: AppContext): Promise<TopicsScope> {
  const user = c.get('user');
  const envScope = await resolveEnvScope(c);
  if (envScope?.environment) {
    return {
      tenantId: user.tenantId,
      appId: user.appId,
      environment: envScope.environment.name,
      environmentIsDefault: envScope.environment.isDefault,
    };
  }

  const supabase = await getScopedSupabase(c);
  const { data, error } = await supabase
    .from('environment')
    .select('name')
    .eq('tenant_id', user.tenantId)
    .eq('app_id', user.appId)
    .eq('is_default', true)
    .maybeSingle();
  if (error) {
    throw new Error(`default environment lookup failed: ${error.message}`);
  }
  return {
    tenantId: user.tenantId,
    appId: user.appId,
    environment: data?.name ?? '',
    environmentIsDefault: true,
  };
}

export class GetTopics extends BaseRoute {
  static requiredPermission: GatewayPermission = 'metrics.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Topics'],
    summary: 'Get topics',
    operationId: 'get-topics',
    description:
      'Returns the active topic map for one facet (task, issues, or steering) — clusters of agent sessions sized by session count.\n\n' +
      '`sessionCount`, `share`, and `trend` are LIVE — they include sessions the enrichment cron classified after the map was generated. ' +
      '`avgLatencyMs`, `avgCostUsd`, and `errorRate` are snapshots computed at generation time (as of `generatedAt`) over the sampled member traces — they do not move as new sessions are classified.\n\n' +
      '`trendDays` buckets are UTC.',
    request: {
      query: TopicsQuerySchema,
    },
    responses: {
      200: {
        description: 'The active topic map for the requested facet.',
        content: {
          'application/json': {
            schema: TopicsResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const query = data.query;

    try {
      const scope = await resolveTopicsScope(c);
      const service = getGatewayTopicsService(c.env, {
        tenantId: scope.tenantId,
        appId: scope.appId,
      });
      if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');

      const result = await service.listTopics(scope, query.facet, query.limit);
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}
