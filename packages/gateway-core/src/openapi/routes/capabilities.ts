/**
 * Capabilities OpenAPI Route
 *
 * Returns a static map of cloud endpoint availability.
 */

import { z, BaseRoute, type AppContext } from './_shared';

// ---------------------------------------------------------------------------
// GET /v1/capabilities
// ---------------------------------------------------------------------------

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
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    return c.json({
      target: 'cloud' as const,
      url: baseUrl,
      endpoints: {
        traces: true,
        spans: false,       // Top-level span search not yet implemented; use /traces/:traceId/spans
        sessions: true,
        scores: true,
        score_analytics: true,
        metrics: true,
        experiments: false,
        datasets: true,
        prompts: false,
        runs: false,
      },
    });
  }
}
