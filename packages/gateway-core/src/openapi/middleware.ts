import type { Context, Next } from 'hono';
import type { Env, UserMeta } from '../types';
import type { GatewayContext } from '../runtime';
import { createVerifiedAppId, type VerifiedAppId } from '@repo/observability-service';
import type { ManagementApiKeyServiceContext } from '@repo/org-management-service';
import { buildUserMetaCacheKey } from '../lib/verify-key';
import { extractBearerToken, resolveBearerUser } from '../lib/verify-bearer';
import { initCache } from '../utils';
import { memory } from '../cache-store';

/**
 * The resolved management-API-key auth for one `/v1/orgs/*` request, set by
 * `managementAuthGuard` (`../lib/management-auth.ts`) before the route
 * handler runs. Declared here (not in `lib/management-auth.ts`) so
 * `OpenAPIVariables` can reference it without an import cycle back through
 * this file.
 */
export interface ManagementAuthContext {
  ctx: ManagementApiKeyServiceContext;
  /** The creator's live permission set, already intersected with the key's own grant. */
  permissions: readonly string[];
}

/** How the caller authenticated. Used by downstream helpers that pick the
 * right Supabase client (gateway-role for api-key, authenticated-role for
 * bearer). See `openapi/routes/_shared.ts::getScopedSupabase`. */
export type AuthMode = 'apikey' | 'bearer';

/**
 * Authenticated user context with a properly branded appId.
 * Set by auth middleware, accessible via c.get('user') in route handlers.
 */
export type AuthenticatedUser = Omit<UserMeta, 'appId'> & {
  readonly appId: VerifiedAppId;
  readonly authMode: AuthMode;
  /**
   * The raw Supabase user JWT, forwarded so handlers can build an
   * authenticated-role Supabase client that inherits the user's RLS.
   * Present when `authMode === 'bearer'`, undefined for api-key auth.
   */
  readonly userJwt?: string;
};

/**
 * Context variables set by auth middleware on each request.
 * Accessible via c.get('user') in route handlers.
 */
export type OpenAPIVariables = {
  user: AuthenticatedUser;
  /** The injected runtime adapters (connections, ingest, cache, billing, logging).
   * Set by the gtx middleware before auth; read via `c.get('gtx')`. */
  gtx: GatewayContext;
  /** Set only on `/v1/orgs/*` routes by `managementAuthGuard`; absent everywhere else. */
  managementAuth: ManagementAuthContext;
};

/**
 * Hono middleware that authenticates a request via one of two paths:
 *
 *   1. **Bearer (user JWT)** — `Authorization: Bearer <supabase-jwt>`.
 *      Verified with `SUPABASE_JWT_SECRET`, validated against the
 *      `X-Outerlayer-App-Id`'s tenant, and forwarded to handlers so
 *      downstream Supabase calls inherit the user's RLS (authenticated
 *      role). See `lib/verify-bearer.ts` for the full decision tree.
 *
 *   2. **API key** — any other `Authorization` value. Verified via the
 *      existing `verifyKey` function with userMeta caching. Produces a
 *      `UserMeta` with `gateway_permissions` claims that downstream
 *      handlers use to mint a gateway-role JWT.
 *
 * Both paths land at the same `c.var.user` shape; the `authMode` field
 * tells helpers which Supabase client to use. Route-level
 * `requiredPermission` checks happen in the per-route BaseRoute wrapper
 * (api-key path via `checkPermission`, bearer path via an
 * `app_authorize()` RPC in the same wrapper — see the BaseRoute
 * execute override).
 */
/**
 * Routes that operate at the tenant level and do NOT require an
 * `X-Outerlayer-App-Id` header — there's no relevant app context yet
 * (POST /v1/apps first-create) or the operation lists across the tenant
 * (GET /v1/apps).
 *
 * The bearer auth path skips the app row lookup for these routes; the
 * route handler reads `user.tenantId` and RLS enforces tenant isolation.
 *
 * Other /v1/apps/:appId routes (GET / PATCH / DELETE / GET .../git)
 * still require the header — they operate on a specific app and the
 * header is the tenant-resolution mechanism. The handler then
 * cross-checks the URL appId against `user.tenantId` via the
 * apps-service tenant filter.
 */
const TENANT_SCOPED_V1_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/apps',
  'GET /v1/apps',
]);

function isTenantScopedRoute(c: Context): boolean {
  // We're called from `app.use('/v1/*', authMiddleware)` — at that layer
  // `c.req.routePath` resolves to the wildcard `/v1/*`, NOT the registered
  // pattern of whichever per-route handler will run later (chanfana only
  // substitutes the concrete pattern once Hono dispatches to a specific
  // route, which is after this middleware). So allowlisting against
  // `routePath` was always false in practice.
  //
  // `c.req.path` is the actual URL pathname for the in-flight request
  // (no query string), which is what the allowlist actually wants.
  // Strip a trailing slash so `POST /v1/apps/` matches the same key as
  // `POST /v1/apps`.
  const path = c.req.path.replace(/\/$/, '');
  return TENANT_SCOPED_V1_ROUTES.has(`${c.req.method} ${path}`);
}

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const appId = c.req.header('X-Outerlayer-App-Id');
  // Optional explicit request tenant (bearer path only). When present it
  // overrides the JWT's session-global tenant claim; `resolveBearerUser`
  // validates it against the caller's active memberships and fails closed
  // on a tenant they don't belong to. Absent ⇒ the claim serves, as today.
  const requestTenantId = c.req.header('X-Tenant-Id');
  const tenantScoped = isTenantScopedRoute(c);

  if (!authHeader) {
    return c.json({ error: { code: 'unauthorized', message: 'Missing auth header' } }, 401);
  }

  // Bearer path — check first so a valid JWT is never routed through the
  // API-key verifier.
  //
  // `extractBearerToken` returns null for anything that isn't a structurally
  // valid (3-segment) JWT, so raw API keys naturally fall through to the
  // API-key path below. Bearer extraction must stay unconditional so that
  // every real JWT reaches `resolveBearerUser`, the only path that
  // cross-checks the app's tenant against the caller's and permission-checks
  // them via the bearer-path `app_authorize()` RPC. Conditioning this call
  // on anything would let a JWT skip both checks.
  const bearerToken = extractBearerToken(authHeader);

  // Tenant-scoped + bearer auth: the X-Outerlayer-App-Id header is
  // OPTIONAL (no app yet on first-create). Tenant-scoped + api-key auth
  // still requires the header — current api keys are bound to a
  // specific app (api_key.app_id NOT NULL) so they always have one to
  // send. Headless onboarding without an existing api key is GAP-0005C.
  const headerOptional = tenantScoped && bearerToken !== null;
  if (!appId && !headerOptional) {
    return c.json({ error: { code: 'unauthorized', message: 'Missing app id' } }, 401);
  }


  if (bearerToken) {
    // For tenant-scoped routes pass `appId: null` so resolveBearerUser
    // skips the app row lookup, which the first-create flow needs: there
    // is no app row to look up yet.
    const result = await resolveBearerUser({
      env: c.env,
      token: bearerToken,
      appId: tenantScoped ? null : appId ?? null,
      requestTenantId,
    });
    if (!result.ok) {
      return c.json(
        { error: { code: 'unauthorized', message: result.message } },
        result.status as 401 | 500,
      );
    }
    // Audit-log every successful authentication. Constitution IX.
    // Emitted in structured form so log platforms can query by authMode
    // ("who hit /v1/* via bearer last week"). Permission denials emit
    // their own log line from permissionMiddleware.
    console.info('[auth] authenticated', {
      authMode: 'bearer',
      tenantId: result.user.tenantId,
      appId: result.user.appId,
      sub: result.user.gatewayUserId,
    });
    c.set('user', {
      ...result.user,
      appId: createVerifiedAppId(result.user.appId),
      authMode: 'bearer',
      userJwt: result.userJwt,
    });
    return next();
  }

  // API-key path.
  // `appId` is guaranteed non-null here: `headerOptional` is true only
  // when `bearerToken !== null` (i.e. bearer auth), and bearer auth
  // returned above. So by the time we reach the api-key path, the
  // `!appId && !headerOptional` guard has already rejected requests
  // without an app id.
  const apiKeyAppId = appId!;
  const gtx = c.get('gtx');
  const cache = initCache(gtx.cacheL2Store, gtx.execCtx, memory);

  // The API-key → identity resolution is the runtime-specific auth seam: Unkey on
  // hosted, Supabase app-row lookup on node self-host. The composition root
  // injects which; the bearer/JWT path already returned above, unchanged.
  const result = await gtx.auth.resolveApiKey({
    authHeader,
    appId: apiKeyAppId,
    env: c.env,
    cache,
    cacheKey: await buildUserMetaCacheKey(apiKeyAppId, authHeader),
  });

  if (!result.ok) {
    return c.json(
      { error: { code: result.code, message: result.message } },
      result.status as 401 | 500 | 502,
    );
  }

  console.info('[auth] authenticated', {
    authMode: 'apikey',
    tenantId: result.user.tenantId,
    appId: result.user.appId,
    sub: result.user.gatewayUserId,
  });
  c.set('user', {
    ...result.user,
    appId: createVerifiedAppId(result.user.appId),
    authMode: 'apikey',
  });
  return next();
}
