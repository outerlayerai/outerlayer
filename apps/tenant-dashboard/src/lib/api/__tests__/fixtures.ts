/**
 * Test fixtures for withApi-based route tests.
 *
 * The canonical way to unit-test a route that wears `withApi`:
 *
 *   vi.mock('@/lib/api/with-api', () => buildWithApiMock({
 *     userId: 'u1', tenantId: 't1', appId: 'a1',
 *   }));
 *
 * The returned mock short-circuits authentication (no Supabase calls), runs
 * schema validation via Zod, invokes the handler with the supplied
 * TenantContext, and routes thrown errors through the real
 * `toNextResponse()` so error-envelope assertions exercise production code.
 */

import type { ZodType } from 'zod';
import type {
  ApiRouteSchema,
  ApiHandler,
  ApiHandlerArgs,
} from '@/lib/api/with-api';

/**
 * Optional error injector — when the getter returns a non-null Error,
 * the mock short-circuits before the handler and surfaces the error
 * through the canonical envelope. Lets integration tests exercise
 * "ForbiddenError / ValidationError at the wrapper boundary" without
 * wiring Supabase mocks end-to-end.
 */
type AuthErrorGetter = () => Error | null;

// Loose Zod parameterisation — the test mock calls `schema.request.*.parse`
// dynamically, so we don't care about the concrete inferred types here. The
// exported type aliases let consumers see "this mock targets the real
// withApi surface", not some parallel shape.
type AnyRouteSchema = ApiRouteSchema<
  ZodType | undefined,
  ZodType | undefined,
  ZodType | undefined
>;
type AnyHandler = ApiHandler<unknown, unknown, unknown>;
type AnyHandlerArgs = ApiHandlerArgs<unknown, unknown, unknown>;

/**
 * Loose context type — the real `TenantContext.appId` is branded as
 * `VerifiedAppId` for production safety. Test fixtures don't need the
 * brand (and refusing the mock for that reason adds no runtime safety).
 */
interface MockTenantContext {
  userId: string;
  tenantId: string;
  appId: string;
  dataRetentionDays: number;
}

/**
 * Every schema handed to the mocked `withApi`, in registration order. Route
 * tests assert their route's OpenAPI metadata (tags/summary/responses) against
 * this — the real `withApi` registers the same object into the dashboard spec,
 * so pinning it here pins what the docs pipeline publishes.
 */
export const capturedRouteSchemas: AnyRouteSchema[] = [];

export function buildWithApiMock(
  context: MockTenantContext,
  authErrorGetter: AuthErrorGetter = () => null,
) {
  return {
    withApi: (schema: AnyRouteSchema, handler: AnyHandler) => {
      capturedRouteSchemas.push(schema);
      return async (
        request: Request,
        ctx?: { params: Promise<Record<string, string>> },
      ) => {
        const { NextResponse } = await import('next/server');
        const { toNextResponse } = await import('@/lib/api/error-envelope');

        const authError = authErrorGetter();
        if (authError) {
          return toNextResponse(authError, {
            remapNotFound: schema.remapNotFound,
            remapConflict: schema.remapConflict,
            remapLimit: schema.remapLimit,
          });
        }

        const resolvedParams = ctx ? await ctx.params : {};
        const url = new URL(request.url);
        const rawQuery = Object.fromEntries(url.searchParams.entries());
        let rawBody: unknown;
        try {
          rawBody = await request.clone().json();
        } catch {
          rawBody = undefined;
        }

        try {
          const body = schema.request?.body
            ? schema.request.body.parse(rawBody)
            : rawBody;
          const query = schema.request?.query
            ? schema.request.query.parse(rawQuery)
            : rawQuery;
          const params = schema.request?.params
            ? schema.request.params.parse(resolvedParams)
            : resolvedParams;

          const args: AnyHandlerArgs = {
            request,
            context: context as unknown as import('@/lib/analytics/tenant-context').TenantContext,
            input: { body, query, params },
          };
          const result = await handler(args);

          // Handlers may return either a plain value (wrap as 200) or a
          // NextResponse-like object (pass through — e.g. explicit 201/204).
          // We detect the latter by the shape the test's `next/server` mock
          // produces: `{status, json: fn}` or real `Response`.
          if (result instanceof Response) return result;
          if (
            result &&
            typeof result === 'object' &&
            'status' in (result as Record<string, unknown>) &&
            typeof (result as { json?: unknown }).json === 'function'
          ) {
            return result;
          }
          return NextResponse.json(result, { status: 200 });
        } catch (error) {
          return toNextResponse(error, {
            remapNotFound: schema.remapNotFound,
            remapConflict: schema.remapConflict,
            remapLimit: schema.remapLimit,
          });
        }
      };
    },
  };
}
