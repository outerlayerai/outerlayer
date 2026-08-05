/**
 * Post-processing applied to the raw generated spec before it is written
 * (or diffed in the drift test). Shared between:
 *
 *   - `scripts/generate-openapi.ts`  (writes docs/dashboard-openapi.yaml)
 *   - `__tests__/spec-drift.test.ts` (asserts no drift from the above)
 *
 * Keep these two callers in lock-step — the drift test would false-green
 * otherwise. The helper mutates `spec` in place and returns it.
 *
 * What it injects (mirrors `apps/gateway/src/openapi/index.ts`):
 *   - `components.securitySchemes.SessionCookie`
 *   - Global `security` requirement
 *   - `appId` query parameter on every authenticated operation
 *   - `components.responses.InternalError` + a `default` response on
 *     every operation — per the OpenAPI 3.1 Pet-Store example and the
 *     Microsoft/Zalando API guidelines, 5xx is a wrapper concern and
 *     doesn't belong in per-route schemas.
 *
 * Rationale: these are cross-cutting concerns that don't belong in every
 * per-route Zod schema. Injecting centrally keeps the route files focused
 * on per-operation contracts.
 */

export function applyDashboardSpecPostprocess(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const components = (spec.components ??= {}) as Record<string, unknown>;
  components.securitySchemes = {
    SessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'sb-access-token',
      description:
        'Supabase session cookie set on sign-in. Dashboard-UI-only — machine clients ' +
        'should use the Gateway API (api.agentmark.co) with an API key instead.',
    },
  };
  spec.security = [{ SessionCookie: [] }];

  // Shared 5xx response. Any uncaught throw inside a `withApi` handler
  // collapses to this via `toNextResponse` → `error-envelope.ts`. The
  // body schema is inlined because the generator emits the error shape
  // inline per-operation today (no named `ErrorResponseSchema` component).
  // If we later promote it to a named component, swap the inline schema
  // here for a `$ref`.
  const errorBodySchema = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: {
            type: 'object',
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    },
  };
  const responses = ((components.responses ??= {}) as Record<string, unknown>);
  responses.InternalError = {
    description:
      'Unexpected server error. The client has not malformed the request; ' +
      'the failure is on our side and has been logged. Safe to retry with ' +
      'backoff.',
    content: {
      'application/json': { schema: errorBodySchema },
    },
  };

  const appIdParam = {
    name: 'appId',
    in: 'query',
    required: true,
    schema: { type: 'string' },
    description:
      'Application ID (tenant-scoping). Every authenticated call passes this.',
  };

  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const operation = op as {
        parameters?: unknown[];
        responses?: Record<string, unknown>;
      };

      const params = operation.parameters ?? [];
      const already = params.some(
        (p) =>
          (p as { name?: string; in?: string } | null)?.name === 'appId' &&
          (p as { in?: string }).in === 'query',
      );
      if (!already) operation.parameters = [appIdParam, ...params];

      // Inject `default` response pointing at the shared InternalError.
      // Leaves any explicit 5xx (e.g. 503 ServiceUnavailable declared by
      // the analytics routes) alone — those are *intentional* parts of
      // the contract, unlike the catch-all 500.
      const opResponses = (operation.responses ??= {});
      if (!opResponses.default) {
        opResponses.default = {
          $ref: '#/components/responses/InternalError',
        };
      }
    }
  }

  return spec;
}
