/**
 * PR OpenAPI Routes
 *
 * `GET /v1/prs/outcomes` — session→PR attribution merged with cost, for the
 * app's dominant repo.
 */

import { mapClickHouseError, toErrorResponse, getErrorStatusCode } from '@repo/observability-service';
import { PrOutcomesResponseSchema } from '@repo/api-schemas';
import { BaseRoute, type AppContext, getService, buildTenantContext, errorResponse } from './_shared';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

/** Shared by the REST handler and the `get_pr_outcomes` MCP tool. */
export async function prOutcomes(c: AppContext) {
  const service = getService(c);
  const ctx = buildTenantContext(c);
  const [attribution, costAttribution] = await Promise.all([
    service.getAgentPrAttribution(ctx),
    service.getAgentPrCostAttribution(ctx),
  ]);

  // Cost rows key by the same (repo, branch, prNumber) group the
  // attribution items use — a group with no positive-cost session (or
  // absent from the cost read entirely) reads costUsd: 0, never undefined.
  const costByKey = new Map(
    costAttribution.items.map((item) => [`${item.repo}\n${item.branch}\n${item.prNumber}`, item.costUsd]),
  );

  return {
    branches: attribution.branches,
    prNumbers: attribution.prNumbers,
    steeredPrNumbers: attribution.steeredPrNumbers,
    items: attribution.items.map((item) => ({
      ...item,
      costUsd: costByKey.get(`${item.repo}\n${item.branch}\n${item.prNumber}`) ?? 0,
    })),
  };
}

export class GetPrOutcomes extends BaseRoute {
  static requiredPermission: GatewayPermission = 'metrics.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['PRs'],
    summary: 'Get session→PR attribution merged with cost',
    operationId: 'get-pr-outcomes',
    description:
      'How many sessions produced PRs, which branches/PR numbers they attribute to, which needed mid-session ' +
      'human steering, and what each attributed (repo, branch, PR number) group cost — for the app\'s dominant ' +
      'repo. Deliberately NOT date-windowed: a PR\'s session set and cost include work that predates its merge. ' +
      'Does not include merged/reverted/CI-green outcome rates — those require a Postgres join this attribution ' +
      'set does not carry a trace id to make.',
    responses: {
      200: {
        description: 'Session→PR attribution merged with per-group cost.',
        content: {
          'application/json': {
            schema: PrOutcomesResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    try {
      const result = await prOutcomes(c);
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}
