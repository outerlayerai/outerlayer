/**
 * `withApi` — the canonical wrapper for dashboard API routes.
 *
 * A route using this wrapper declares one schema object and one handler,
 * and gets:
 *
 *   1. Session auth + tenant verification                 (withAnalyticsAuth)
 *   2. Zod input validation on body / query / params      (manual today)
 *   3. Auto-registration in the OpenAPI spec              (net-new)
 *   4. Canonical error envelope on every non-2xx path     (5 shapes → 1)
 *   5. Structured logging of failures                     (manual today)
 *
 * Shape ergonomics are modelled on the gateway's `BaseRoute` (chanfana) but
 * adapted to Next's file-based routing — no class inheritance, handler is a
 * plain async function. The schema/response contract is intentionally close
 * enough that a reader familiar with the gateway can skim a dashboard route
 * without re-learning the pattern.
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { z, type ZodType } from 'zod';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import {
  AnalyticsError,
  ValidationError,
  ForbiddenError,
} from '@repo/observability-service';
import { ErrorResponseSchema } from '@repo/api-schemas';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { getRequestTenantId } from '@/lib/tenant/request-tenant';
import {
  verifyAppAccess,
  type TenantContext,
} from '@/lib/analytics/tenant-context';
import { EntitlementService } from '@/lib/system/entitlement-service';
import { analyticsLogger } from '@/lib/analytics/logger';
import { dashboardApiRegistry } from './registry';
import { toNextResponse } from './error-envelope';
import type { DashboardErrorCode } from './error-codes';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ApiRouteSchema<
  TBody extends ZodType | undefined = undefined,
  TQuery extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
> {
  /** HTTP method. */
  method: HttpMethod;
  /**
   * OpenAPI-format path (e.g. `/api/dashboards/{dashboardId}`).
   * Next.js file routing uses `[dashboardId]`; we use braces here so the spec
   * renders correctly. The wrapper doesn't parse this — it's for documentation
   * only; actual params come from Next's route context.
   */
  path: string;
  tags: string[];
  summary: string;
  operationId: string;
  description?: string;
  request?: {
    body?: TBody;
    query?: TQuery;
    params?: TParams;
  };
  /**
   * Response schemas keyed by status code. The 2xx schema is used to document
   * the success shape; 4xx/5xx default to `ErrorResponseSchema` (the canonical
   * `{ error: { code, message } }` envelope) unless a schema is provided.
   */
  responses: Record<
    number,
    {
      description: string;
      schema?: ZodType;
    }
  >;
  /**
   * When the handler throws `NotFoundError`, remap to this resource-specific
   * code. Without this, all NotFound errors collapse to `internal_error` —
   * which is wrong for 404s but safe (better than leaking a stack).
   */
  remapNotFound?: DashboardErrorCode;
  /**
   * When the handler throws `ValidationError` whose message contains
   * "already exists", remap to this resource-specific conflict code (409).
   */
  remapConflict?: DashboardErrorCode;
  /**
   * When the handler throws `ValidationError` whose message matches a cap
   * phrase ("Maximum of .. reached"), remap to this limit-exceeded code (429).
   */
  remapLimit?: DashboardErrorCode;
  /** If true (default), the wrapper runs session auth before the handler. */
  authRequired?: boolean;
}

type Inferred<T> = T extends ZodType ? z.infer<T> : undefined;

export interface ApiHandlerArgs<TBody, TQuery, TParams> {
  request: Request;
  /** Verified tenant context. `null` only on explicitly public routes. */
  context: TenantContext;
  input: {
    body: TBody;
    query: TQuery;
    params: TParams;
  };
}

/**
 * Handler return shape. Either:
 *   - A plain object → wrapped as `NextResponse.json(value, { status: 200 })`
 *   - A `Response` → returned as-is (use for 201, 204, streaming, etc.)
 *
 * Errors must be thrown, not returned — the wrapper's error handling only
 * runs on the throw path. Throwing a known analytics-service error class
 * (ValidationError, NotFoundError, ForbiddenError, etc.) yields the right
 * status + code automatically.
 */
export type ApiHandler<TBody, TQuery, TParams> = (
  args: ApiHandlerArgs<TBody, TQuery, TParams>,
) => Promise<Response | unknown>;

// ---------------------------------------------------------------------------
// withApi — the wrapper itself
// ---------------------------------------------------------------------------

export function withApi<
  TBody extends ZodType | undefined = undefined,
  TQuery extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
>(
  schema: ApiRouteSchema<TBody, TQuery, TParams>,
  handler: ApiHandler<Inferred<TBody>, Inferred<TQuery>, Inferred<TParams>>,
) {
  registerRoute(schema);

  return async function nextHandler(
    request: Request,
    ctx?: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    try {
      const context =
        schema.authRequired === false
          ? (null as unknown as TenantContext)
          : await authenticateRequest(request);

      const input = await validateInput(request, ctx, schema);

      const result = await handler({
        request,
        context,
        input: input as ApiHandlerArgs<
          Inferred<TBody>,
          Inferred<TQuery>,
          Inferred<TParams>
        >['input'],
      });

      if (result instanceof Response) return result;
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      analyticsLogger.error(
        `${schema.method.toUpperCase()} ${schema.path}`,
        error,
      );
      return toNextResponse(error, {
        remapNotFound: schema.remapNotFound,
        remapConflict: schema.remapConflict,
        remapLimit: schema.remapLimit,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Auth — lifted from `withAnalyticsAuth` so the behaviour stays identical.
// If and when we move to route-level permission declarations (the gateway's
// `requiredPermission` static), that logic goes here.
// ---------------------------------------------------------------------------

async function authenticateRequest(
  request: Request,
): Promise<TenantContext> {
  // The client is scoped to the URL-derived request tenant.
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new AnalyticsError('Not authenticated', 'unauthorized', 401);
  }

  const tenantId = requestTenantId;
  if (!tenantId) {
    throw new ForbiddenError('No tenant associated with user');
  }

  const url = new URL(request.url);
  const appId = url.searchParams.get('appId');
  if (!appId) {
    throw new ValidationError('appId query parameter is required');
  }

  const adminDb = createSupabaseAdminClient();
  const entitlementService = new EntitlementService({ db: adminDb });
  const dataRetentionDays = await entitlementService.getLimit(
    tenantId,
    'data_retention_days',
  );

  return verifyAppAccess(supabase, user.id, tenantId, appId, dataRetentionDays);
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

async function validateInput(
  request: Request,
  ctx: { params: Promise<Record<string, string>> } | undefined,
  schema: ApiRouteSchema<ZodType | undefined, ZodType | undefined, ZodType | undefined>,
): Promise<{ body: unknown; query: unknown; params: unknown }> {
  let body: unknown;
  let query: unknown;
  let params: unknown;

  if (schema.request?.body) {
    const raw = await request
      .json()
      .catch(() => {
        throw new AnalyticsError(
          'Malformed JSON body',
          'invalid_request_body',
          400,
        );
      });
    body = schema.request.body.parse(raw);
  }

  if (schema.request?.query) {
    const url = new URL(request.url);
    const queryObj = Object.fromEntries(url.searchParams.entries());
    query = schema.request.query.parse(queryObj);
  }

  if (schema.request?.params) {
    const raw = ctx ? await ctx.params : {};
    params = schema.request.params.parse(raw);
  }

  return { body, query, params };
}

// ---------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------

function registerRoute(schema: ApiRouteSchema<any, any, any>): void {
  const config: RouteConfig = {
    method: schema.method,
    path: schema.path,
    tags: schema.tags,
    summary: schema.summary,
    operationId: schema.operationId,
    ...(schema.description ? { description: schema.description } : {}),
    request: {
      ...(schema.request?.params ? { params: schema.request.params } : {}),
      ...(schema.request?.query ? { query: schema.request.query } : {}),
      ...(schema.request?.body
        ? {
            body: {
              content: {
                'application/json': { schema: schema.request.body },
              },
            },
          }
        : {}),
    },
    responses: Object.fromEntries(
      Object.entries(schema.responses).map(([status, resp]) => {
        const code = Number(status);
        const schemaForCode =
          resp.schema ?? (code >= 400 ? ErrorResponseSchema : undefined);
        return [
          code,
          {
            description: resp.description,
            ...(schemaForCode
              ? {
                  content: {
                    'application/json': { schema: schemaForCode },
                  },
                }
              : {}),
          },
        ];
      }),
    ),
  };

  dashboardApiRegistry.registerPath(config);
}
