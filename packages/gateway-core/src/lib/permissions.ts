/**
 * Gateway permission system for scoped API keys.
 *
 * Defines granular permissions, role-based permission sets, and the
 * lookup that backs the Hono permission middleware.
 *
 * Route permissions are declared on each `OpenAPIRoute` subclass as a
 * `static requiredPermission` field and registered via the `register()`
 * helper in `openapi/index.ts`. That helper calls `setRoutePermission()`
 * below to populate the lookup map. Middleware reads the map using
 * `c.req.routePath` — Hono's already-matched route pattern — so we never
 * re-parse paths or maintain a second router.
 */

import type { Context, Next } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { Database } from '../db';
import type { OpenAPIVariables } from '../openapi/middleware';
import { checkBearerPermission } from './verify-bearer';

// ---------------------------------------------------------------------------
// Permission type
// ---------------------------------------------------------------------------

/**
 * The `app_permission` SQL enum — generated from the Supabase schema via
 * `yarn codegen:db`. Never import this directly; use `GatewayPermission`.
 */
type AppPermission = Database['public']['Enums']['app_permission'];

/**
 * Permissions the gateway exposes on its /v1/* surface.
 *
 * Each value is a member of the `app_permission` SQL enum
 * (`apps/tenant-dashboard/supabase/schemas/01-types.sql`). The `satisfies`
 * constraint on GATEWAY_PERMISSIONS enforces this at compile time —
 * add a string here that isn't in the enum and TypeScript errors immediately.
 *
 * Source-of-truth chain:
 *   01-types.sql (SQL enum)
 *   → supabase gen types → apps/gateway/src/db.ts
 *   → AppPermission (above)
 *   → GATEWAY_PERMISSIONS satisfies ReadonlyArray<AppPermission>
 *   → GatewayPermission (this type)
 *
 * To add a new permission: add the value to 01-types.sql + a migration,
 * run `yarn codegen:db`, then add it here. CI will reject the PR if
 * db.ts drifts from the schema.
 */

// ---------------------------------------------------------------------------
// All permissions (canonical list)
// ---------------------------------------------------------------------------

// `satisfies` validates every entry against AppPermission at compile time.
// If a value isn't in the SQL enum, TypeScript errors here — never at runtime.
export const GATEWAY_PERMISSIONS = [
  'trace.write',   // ingest spans/traces from SDKs or the CLI forwarder
  'trace.read',
  'score.write',
  'score.read',
  'score.delete',
  'span.read',
  'session.read',
  'metrics.read',
  // Controls actor identity visibility on session reads for machine keys:
  // a key without this permission still lists sessions, but actor names
  // are anonymized and `actorId` filters are rejected.
  'agents.sessions.team.read',
  // API key management. Names mirror the SQL enum
  // (`api_key.read|insert|delete`) — the OpenAPI doc-level aliases
  // `api_key.create` / `api_key.revoke` map to `insert` / `delete` here.
  'api_key.read',
  'api_key.insert',
  'api_key.delete',
  // Environments. All 4 env permissions are gateway-facing because both
  // CLI (API key auth) and dashboard (bearer JWT auth) hit the same
  // `/v1/environments/*` routes.
  'environment.read',
  'environment.insert',
  'environment.update',
  'environment.delete',
  // App CRUD — the public /v1/apps/* surface. A headless agent with these
  // four permissions can provision a Cloud app without the dashboard,
  // which is the prerequisite for the rest of the headless onboarding
  // flow (deploys, api keys, etc. all hang off an app row).
  'app.read',
  'app.insert',
  'app.update',
  'app.delete',
  // Cloud workers: the /v1/workers/* surface — launch runs and
  // persistent sessions (insert), read status/outcome/threads (read).
  'worker_run.read',
  'worker_run.insert',
] as const satisfies ReadonlyArray<AppPermission>;

export type GatewayPermission = (typeof GATEWAY_PERMISSIONS)[number];
export const GatewayPermissionSchema = z.enum(GATEWAY_PERMISSIONS);

// ---------------------------------------------------------------------------
// Role-based permission sets
// ---------------------------------------------------------------------------

export const ROLE_PERMISSION_SETS: Record<string, readonly GatewayPermission[]> = {
  // 'sdk' is intentionally NOT extended with environment.* — production
  // ingest does not need env introspection or mutation, and keeping these
  // off means a leaked SDK key can write telemetry but cannot read, alter,
  // or destroy a tenant's environments.
  'sdk': ['trace.write', 'score.write'],
  'read-only': [
    'trace.read',
    'span.read',
    'session.read',
    'score.read',
    'metrics.read',
    // Read-only role gains environment.read.
    'environment.read',
    'app.read',
  ],
  // Full-access includes all env permissions via the GATEWAY_PERMISSIONS spread.
  'full-access': [...GATEWAY_PERMISSIONS],
} as const;

// ---------------------------------------------------------------------------
// Route → permission registry
// ---------------------------------------------------------------------------

type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';

const routePermissions = new Map<string, GatewayPermission>();

function buildKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Register the required permission for a route. Called once per route at
 * app startup by the `register()` helper in `openapi/index.ts`.
 *
 * Throws if the same (method, path) is registered twice — a duplicate
 * registration almost certainly means a copy-paste bug that would silently
 * overwrite a permission at runtime.
 */
export function setRoutePermission(
  method: HttpMethod,
  path: string,
  permission: GatewayPermission,
): void {
  const key = buildKey(method, path);
  if (routePermissions.has(key)) {
    throw new Error(`Route ${key} already has a permission registered`);
  }
  routePermissions.set(key, permission);
}

/**
 * Look up the permission registered for a (method, path) pair. `path`
 * should be the registered route pattern (e.g. `/v1/traces/:traceId`),
 * which is what Hono exposes as `c.req.routePath`.
 *
 * Returns `null` when the route has no registered permission (health
 * checks, public endpoints, unmapped routes).
 */
export function getRoutePermission(
  method: string,
  path: string,
): GatewayPermission | null {
  return routePermissions.get(buildKey(method, path)) ?? null;
}

/**
 * Test-only: clear the registry. Production code must never call this;
 * it exists so tests can assert registration behavior in isolation.
 */
export function _resetRoutePermissions(): void {
  routePermissions.clear();
}

/**
 * All route path patterns currently registered via `setRoutePermission()`
 * (one entry per (method, path) pair — a path with multiple methods
 * appears once per method). Backs capability derivation
 * (`routes/capabilities.ts`): a capability is available iff at least one
 * registered path falls under its prefix. Callers must invoke this at
 * request time, not module-eval time — the registry only reflects
 * registrations that have already run.
 */
export function getRegisteredRoutePaths(): readonly string[] {
  return Array.from(routePermissions.keys(), (key) => key.slice(key.indexOf(' ') + 1));
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `required` is present in the caller's permission list.
 */
export function checkPermission(
  userPermissions: string[],
  required: GatewayPermission,
): boolean {
  return userPermissions.includes(required);
}

// ---------------------------------------------------------------------------
// Hono permission middleware
// ---------------------------------------------------------------------------

/**
 * Core permission enforcement — dispatches on `user.authMode` with an
 * EXPLICIT required permission (not a registry lookup). Used by
 * `enforcePermission` (per-route guard inside `registerAuthenticatedRoute`)
 * and also by `permissionMiddleware` (legacy wildcard fallback).
 *
 * Returns a 403 Response on failure, calls `next()` on success.
 */
async function checkPermissionOrDeny(
  c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
  next: Next,
  required: GatewayPermission,
  logContext: Record<string, unknown>,
): Promise<Response | void> {
  const user = c.get('user');
  if (!user) return next();

  if (user.authMode === 'bearer') {
    if (!user.userJwt) {
      console.error('[permissions] bearer user context is missing userJwt', logContext);
      return c.json({
        error: {
          message: `Forbidden: missing required permission '${required}'`,
          code: 'PERMISSION_DENIED',
          required_permission: required,
        },
      }, 403);
    }
    const authorized = await checkBearerPermission({
      env: c.env,
      userJwt: user.userJwt,
      permission: required,
      appId: user.appId,
      requestTenantId: user.tenantId,
    });
    if (!authorized) {
      console.warn('[permissions] bearer denied by app_authorize', { ...logContext, required });
      return c.json({
        error: {
          message: `Forbidden: missing required permission '${required}'`,
          code: 'PERMISSION_DENIED',
          required_permission: required,
        },
      }, 403);
    }
    return next();
  }

  // API-key path.
  if (!checkPermission(user.permissions ?? [], required)) {
    console.warn('[permissions] denied', { ...logContext, required });
    return c.json({
      error: {
        code: 'forbidden',
        message: `Forbidden: missing required permission '${required}'`,
        required_permission: required,
      },
    }, 403);
  }
  return next();
}

/**
 * Per-route permission guard for chanfana-registered routes.
 *
 * Called from `registerAuthenticatedRoute` with the explicit required
 * permission. Runs AFTER Hono has matched the specific route pattern
 * so it has the real route path in context — unlike the wildcard
 * `app.use('/v1/*')` handler where `c.req.routePath` is still `/v1/*`
 * and a registry lookup would return null for every route.
 *
 * This is the authoritative enforcement path for all /v1/* API routes.
 */
export function enforcePermission(required: GatewayPermission) {
  // Named so route-registration tests can identify this handler in
  // `openApiApp.routes[].handler.name` and verify ordering relative to
  // `entitlementGuard` for tier-gated routes. Distinct from the
  // top-level `permissionMiddleware` (the /v1/* wildcard fallback) by
  // design — no accidental shadowing concerns since each is reached
  // via its own export.
  return function permissionGuard(
    c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
    next: Next,
  ) {
    return checkPermissionOrDeny(c, next, required, {
      method: c.req.method,
      routePath: c.req.path,
      tenantId: c.get('user')?.tenantId,
      appId: c.get('user')?.appId,
    });
  };
}

/**
 * Wildcard permission middleware — kept as a fallback for any route NOT
 * registered through `registerAuthenticatedRoute` (e.g. public routes,
 * legacy handlers). For chanfana routes the per-route `enforcePermission`
 * guard runs first; this middleware is effectively a no-op for them since
 * `getRoutePermission` returns null when `c.req.routePath` is `/v1/*`.
 */
export async function permissionMiddleware(
  c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
  next: Next,
): Promise<Response | void> {
  const user = c.get('user');
  if (!user) return next();

  const method = c.req.method;
  // Use c.req.path (actual URL path) rather than the deprecated c.req.routePath.
  // In the wildcard app.use('/v1/*') context this is the concrete request path
  // (e.g. '/v1/traces') which is what the registry was indexed on. For chanfana
  // routes with path params the lookup still returns null — enforcePermission()
  // on the specific route handles those. This middleware is only a fallback.
  const reqPath = c.req.path;
  const required = getRoutePermission(method, reqPath);

  if (!required) {
    return next();
  }

  return checkPermissionOrDeny(c, next, required, { method, reqPath, tenantId: user.tenantId, appId: user.appId });
}
