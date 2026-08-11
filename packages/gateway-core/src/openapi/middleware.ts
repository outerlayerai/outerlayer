import type { Context, Next } from 'hono';
import type { Env, UserMeta } from '../types';
import type { GatewayContext } from '../runtime';
import { createVerifiedAppId, type VerifiedAppId } from '@repo/observability-service';
import { buildUserMetaCacheKey } from '../lib/verify-key';
import { extractBearerToken, resolveBearerUser } from '../lib/verify-bearer';
import { initCache } from '../utils';
import { memory } from '../cache-store';
import {
  buildOAuthProtectedResourceMetadataUrl,
  buildAppScopedOAuthProtectedResourceMetadataUrl,
} from '../lib/oauth-metadata';

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

/**
 * The MCP mount path. Keyed off the path string, not a route registration,
 * because `/v1/mcp` isn't a chanfana route — it's mounted separately and
 * this middleware runs before that mount exists in the request chain. API
 * keys are bound to exactly one app, so the key row is the authority here;
 * see `headerOptional` below.
 */
const MCP_ROUTE_PATH = '/v1/mcp';

function isMcpRoute(c: Context): boolean {
  const path = c.req.path.replace(/\/$/, '');
  return path === MCP_ROUTE_PATH;
}

/**
 * Per-app MCP mount for OAuth-connected clients (claude.ai/ChatGPT custom
 * connectors) that paste a single URL and cannot send a custom
 * `X-Outerlayer-App-Id` header — the app id travels in the path instead.
 * Bearer-only: API keys already have `/v1/mcp` with header-or-derive
 * resolution; this mount exists specifically for the case that has no
 * header to derive from or supply.
 */
const APP_SCOPED_MCP_ROUTE_RE = /^\/v1\/apps\/([^/]+)\/mcp$/;

/** Returns the `{appId}` path segment when the request targets the
 * per-app MCP mount, or null otherwise. */
function extractAppScopedMcpAppId(c: Context): string | null {
  const path = c.req.path.replace(/\/$/, '');
  const match = APP_SCOPED_MCP_ROUTE_RE.exec(path);
  return match ? (match[1] as string) : null;
}

/**
 * `c.json` for an auth failure, adding the RFC 9728 `WWW-Authenticate`
 * challenge on MCP-route 401s so an unauthenticated client can discover
 * protected-resource metadata (and, from there, the authorization server)
 * without out-of-band configuration. Every other case — non-MCP routes,
 * non-401 statuses — calls `c.json` with exactly the two arguments it
 * always took, unchanged.
 *
 * The per-app mount (`appScopedMcpAppId` set) advertises ITS OWN metadata
 * document (`resource` = this app's mount, not the bare `/v1/mcp`) — a
 * client that already resolved the bare mount's metadata and validates the
 * audience strictly must not be pointed back at a `resource` value it never
 * connected to.
 */
function jsonAuthError(
  c: Context,
  body: unknown,
  status: 401 | 500 | 502,
  mcpRoute: boolean,
  appScopedMcpAppId: string | null = null,
): Response {
  if (!mcpRoute || status !== 401) return c.json(body, status);
  const origin = new URL(c.req.url).origin;
  const resourceMetadataUrl =
    appScopedMcpAppId !== null
      ? buildAppScopedOAuthProtectedResourceMetadataUrl(origin, appScopedMcpAppId)
      : buildOAuthProtectedResourceMetadataUrl(origin);
  return c.json(body, status, {
    'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
  });
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
  const appScopedMcpAppId = extractAppScopedMcpAppId(c);
  const mcpRoute = isMcpRoute(c) || appScopedMcpAppId !== null;

  if (!authHeader) {
    return jsonAuthError(
      c,
      { error: { code: 'unauthorized', message: 'Missing auth header' } },
      401,
      mcpRoute,
      appScopedMcpAppId,
    );
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
  //
  // `/v1/mcp` + api-key auth: the header is ALSO optional. A key is bound
  // to exactly one app, so the resolver can derive it from the key row
  // instead — this is what lets single-bearer-token clients (no custom
  // header support) authenticate. Bearer-JWT auth on `/v1/mcp` keeps
  // requiring the header: JWTs are tenant-scoped, not app-bound, so there
  // is nothing on the token to derive an app from.
  //
  // `/v1/apps/:appId/mcp` + bearer auth: the header is optional too — the
  // app id is the path segment itself. This mount is bearer-only (see the
  // API-key rejection below); a key resolving the same way it does on
  // `/v1/mcp` would make two mounts do the same derivation two ways.
  if (appScopedMcpAppId !== null && bearerToken === null) {
    // API keys already have /v1/mcp (header-or-derive resolution above);
    // this mount exists for bearer/OAuth clients that have no header to
    // send. Accepting an API key here too would give the same credential
    // two different app-resolution paths for no benefit. Checked before
    // the generic "missing app id" guard below so a caller gets this
    // specific diagnostic instead of a misleading header complaint.
    return jsonAuthError(
      c,
      {
        error: {
          code: 'unauthorized',
          message: 'This endpoint requires a user or OAuth bearer token; API keys use /v1/mcp.',
        },
      },
      401,
      mcpRoute,
      appScopedMcpAppId,
    );
  }

  const headerOptional =
    (tenantScoped && bearerToken !== null) ||
    (isMcpRoute(c) && bearerToken === null) ||
    (appScopedMcpAppId !== null && bearerToken !== null);
  if (!appId && !headerOptional) {
    return jsonAuthError(
      c,
      { error: { code: 'unauthorized', message: 'Missing app id' } },
      401,
      mcpRoute,
      appScopedMcpAppId,
    );
  }

  if (bearerToken) {
    // For tenant-scoped routes pass `appId: null` so resolveBearerUser
    // skips the app row lookup, which the first-create flow needs: there
    // is no app row to look up yet. For the per-app MCP mount, the path
    // segment IS the app id — it overrides any (irrelevant) header.
    const effectiveAppId =
      appScopedMcpAppId !== null ? appScopedMcpAppId : tenantScoped ? null : appId ?? null;
    const result = await resolveBearerUser({
      env: c.env,
      token: bearerToken,
      appId: effectiveAppId,
      requestTenantId,
      // Connector (OAuth) tokens carry a `client_id` claim. They're full
      // user sessions everywhere else on the bearer surface — Supabase
      // does not enforce scopes — so this confinement is the security
      // seam: only MCP paths accept one. See verify-bearer.ts.
      allowConnectorToken: mcpRoute,
      // Only the per-app mount has callers with no tenant-bearing header
      // or claim to send (single-bearer-token connector clients) and an
      // app id that's already authoritative (path segment, not a header).
      // Plain /v1/mcp and every REST route keep requiring a header/claim.
      appScopedTenantFallback: appScopedMcpAppId !== null,
    });
    if (!result.ok) {
      return jsonAuthError(
        c,
        { error: { code: 'unauthorized', message: result.message } },
        result.status as 401 | 500,
        mcpRoute,
        appScopedMcpAppId,
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
  // `appId` is non-null here except on `/v1/mcp`, the one route where
  // `headerOptional` can be true for an api-key caller (`bearerToken ===
  // null`, checked above) — everywhere else the `!appId && !headerOptional`
  // guard has already rejected requests without an app id.
  const apiKeyAppId = appId ?? null;
  const gtx = c.get('gtx');
  const cache = initCache(gtx.cacheL2Store, gtx.execCtx, memory);

  // The API-key → identity resolution is the runtime-specific auth seam: Unkey on
  // hosted, Supabase app-row lookup on node self-host. The composition root
  // injects which; the bearer/JWT path already returned above, unchanged.
  //
  // With a header, the cache key is known upfront and resolveApiKey does its
  // own cache read/write internally, as before. Without one (derive mode),
  // there's no appId to build a cache key from until AFTER resolution, so
  // the lookup is skipped and the cache is populated afterward, keyed on the
  // resolved app id — a header-bearing request from the same key later hits
  // that entry; the cache key is never built from a null.
  const result = apiKeyAppId !== null
    ? await gtx.auth.resolveApiKey({
        authHeader,
        appId: apiKeyAppId,
        env: c.env,
        cache,
        cacheKey: await buildUserMetaCacheKey(apiKeyAppId, authHeader),
      })
    : await gtx.auth.resolveApiKey({ authHeader, appId: null, env: c.env });

  if (result.ok && apiKeyAppId === null) {
    const derivedCacheKey = await buildUserMetaCacheKey(result.user.appId, authHeader);
    await cache.userMeta.set(derivedCacheKey, result.user);
  }

  if (!result.ok) {
    return jsonAuthError(
      c,
      { error: { code: result.code, message: result.message } },
      result.status as 401 | 500 | 502,
      mcpRoute,
      appScopedMcpAppId,
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
