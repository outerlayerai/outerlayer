/**
 * Auth seam for the org-management API (`/v1/orgs/:orgName/...`).
 *
 * These routes accept ONLY `Authorization: Bearer olk_...` management API
 * keys — never the gateway's own `sk_outerlayer_*` keys or a Supabase user
 * JWT. They therefore run OUTSIDE the shared `authMiddleware` /
 * `permissionMiddleware` wildcard chain (see `isManagementApiPath` and its
 * use in `openapi/index.ts`): an `sk_`/JWT-shaped Authorization header must
 * 401 here exactly like a missing one, and `authMiddleware` has no branch
 * that would do that — it would instead try to verify the value as one of
 * ITS schemes and produce the wrong failure mode (or, worse, misroute a
 * structurally-JWT-shaped bearer into the dashboard's own verifier).
 *
 * Verification is entirely delegated to `@repo/org-management-service`'s
 * `resolveBearerServiceContext` — digest lookup, tenant binding against the
 * URL `orgName`, and creator-permission intersection all happen there. This
 * module only wires the gateway's admin client + pepper into that call and
 * translates the result into a Hono middleware.
 */

import type { Context, Next } from 'hono';
import { resolveBearerServiceContext } from '@repo/org-management-service';
import type { Env } from '../types';
import type { OpenAPIVariables } from '../openapi/middleware';
import { createSystemAdminClient } from './system-client';

/** Every management-API route lives under this prefix. */
export const MANAGEMENT_API_PATH_PREFIX = '/v1/orgs/';

export function isManagementApiPath(pathname: string): boolean {
  return pathname.startsWith(MANAGEMENT_API_PATH_PREFIX);
}

type ManagementContext = Context<{ Bindings: Env; Variables: OpenAPIVariables }>;

/**
 * Per-route guard: verifies the bearer key, binds it to the URL org, checks
 * `required` against the caller's effective permission set, and stashes the
 * resolved context on `c.set('managementAuth', ...)` for the route handler.
 * Fails closed at every step — see `resolveBearerServiceContext` for the
 * 401 (verification) vs 403 (tenant binding / permission) split.
 *
 * `orgName` is read via Hono's own path-param decoding (never string-built
 * into a query) and passed straight to the package, which escapes it before
 * use in its `ilike` tenant lookup — a caller cannot widen the match with
 * `%`/`_` wildcards or use `..`/`/`-shaped segments to address another
 * tenant's org.
 */
export function managementAuthGuard(required: string) {
  return async function guard(c: ManagementContext, next: Next): Promise<Response | void> {
    const orgName = c.req.param('orgName') ?? '';
    const authorizationHeader = c.req.header('Authorization') ?? null;
    const adminClient = createSystemAdminClient(c.env);

    const result = await resolveBearerServiceContext({
      authorizationHeader,
      orgName,
      adminClient,
      pepper: c.env.MANAGEMENT_API_KEY_PEPPER,
    });

    if (!result.ok) {
      return c.json(
        { error: { code: result.status === 401 ? 'unauthorized' : 'forbidden', message: result.message } },
        result.status,
      );
    }

    if (!result.keyPermissions.includes(required)) {
      return c.json(
        {
          error: {
            code: 'forbidden',
            message: `Missing required permission '${required}'`,
            required_permission: required,
          },
        },
        403,
      );
    }

    c.set('managementAuth', { ctx: result.ctx, permissions: result.keyPermissions });
    return next();
  };
}
