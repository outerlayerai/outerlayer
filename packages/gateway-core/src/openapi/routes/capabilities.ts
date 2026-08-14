/**
 * Capabilities OpenAPI Route
 *
 * Returns a map of cloud endpoint availability.
 */

import { z, BaseRoute, type AppContext } from './_shared';
import { getRegisteredRoutePaths } from '../../lib/permissions';
import { requestOrigin } from '../../lib/oauth-metadata';

// ---------------------------------------------------------------------------
// GET /v1/capabilities
// ---------------------------------------------------------------------------

// Capability keys whose truth is derived from the route registry: a
// capability is available iff at least one route under its prefix is
// registered. `traces` and `datasets` have no serving routes and stay
// hardcoded false below rather than deriving from an empty prefix.
const CAPABILITY_ROUTE_PREFIXES = {
  spans: '/v1/spans',
  sessions: '/v1/sessions',
  scores: '/v1/scores',
  metrics: '/v1/metrics',
  topics: '/v1/topics',
} as const;

function hasRegisteredRoute(prefix: string): boolean {
  return getRegisteredRoutePaths().some(
    (path) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function deriveRouteCapabilities(): Record<keyof typeof CAPABILITY_ROUTE_PREFIXES, boolean> {
  const entries = Object.entries(CAPABILITY_ROUTE_PREFIXES) as Array<
    [keyof typeof CAPABILITY_ROUTE_PREFIXES, string]
  >;
  return Object.fromEntries(
    entries.map(([key, prefix]) => [key, hasRegisteredRoute(prefix)]),
  ) as Record<keyof typeof CAPABILITY_ROUTE_PREFIXES, boolean>;
}

export class GetCapabilities extends BaseRoute {
  schema = {
    tags: ['Capabilities'],
    summary: 'Get capabilities',
    operationId: 'get-capabilities',
    description: 'Returns a map of available API endpoints for the current target (cloud or local). Use this to discover which features are supported before calling other endpoints.\n\nThis endpoint does not require authentication.',
    security: [],
    responses: {
      200: {
        description: 'Server capabilities.',
        content: {
          'application/json': {
            schema: z.object({
              target: z.literal('cloud'),
              url: z.string(),
              endpoints: z.object({
                traces: z.boolean(),
                spans: z.boolean(),
                sessions: z.boolean(),
                scores: z.boolean(),
                score_analytics: z.boolean(),
                metrics: z.boolean(),
                experiments: z.boolean(),
                datasets: z.boolean(),
                prompts: z.boolean(),
                runs: z.boolean(),
                topics: z.boolean(),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const baseUrl = requestOrigin(c.req);
    const derived = deriveRouteCapabilities();

    return c.json({
      target: 'cloud' as const,
      url: baseUrl,
      endpoints: {
        traces: false,
        spans: derived.spans,
        sessions: derived.sessions,
        scores: derived.scores,
        score_analytics: true,
        metrics: derived.metrics,
        experiments: false,
        datasets: false,
        prompts: false,
        runs: false,
        topics: derived.topics,
      },
    });
  }
}
