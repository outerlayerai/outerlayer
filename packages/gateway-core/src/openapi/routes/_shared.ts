/**
 * Shared utilities for OpenAPI route handlers.
 *
 * Re-exports Zod and provides common helpers for route handlers.
 */

import { z } from 'zod';
import { InputValidationException, OpenAPIRoute } from 'chanfana';
import type { Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../types';
import type { Database } from '../../db';
import type { OpenAPIVariables } from '../middleware';
import { getGatewayAnalyticsService } from '../analytics-factory';
import { ServiceUnavailableError } from '@repo/observability-service';
import type { AnalyticsService, TenantContext, EnvironmentQueryScope } from '@repo/observability-service';
import { createTenantScopedClient } from '../../supabase';
import {
  ErrorEnvelopeSchema,
  type ErrorEnvelope,
} from '@repo/api-schemas';
import { createAuthenticatedClient } from '../../lib/authenticated-client';
import { resolveEnvironmentFromApiKey } from '../../lib/environment-resolver';
import { createSystemAdminClient, asServiceClient, listAppEnvironments } from '../../lib/system-client';
import { envTargetOf } from '@repo/env-kind';

export { z, OpenAPIRoute as BaseRoute };

// Re-export the canonical envelope schema and type so route files can
// reference the single source of truth without importing directly from
// @repo/api-schemas.
export { ErrorEnvelopeSchema, type ErrorEnvelope };

/**
 * Safely parse a JSON request body.
 *
 * Wraps `c.req.json()` — which throws a native `SyntaxError` on malformed
 * or empty payloads — into an `InputValidationException` so the
 * gateway-wide `app.onError` handler emits the canonical
 * `{ error: { code, message } }` body at 400 instead of leaking a 500
 * Hono-default response.
 *
 * Without this wrapper, the Schemathesis fuzz run surfaced every empty-
 * body or truncated-JSON POST as a 500 `internal_error` — because the
 * handler's raw `await c.req.json()` threw `SyntaxError`, which is not
 * an `ApiException`, so it fell through `app.onError` to the 5xx branch.
 */
export async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InputValidationException('Request body is not valid JSON.', ['body']);
  }
}

/**
 * Canonical error response schema for OpenAPI route declarations —
 * what every 4xx/5xx response body looks like, across the whole gateway
 * AND the OSS CLI dev server.
 *
 * Matches the runtime shape emitted by `structuredError()`:
 *   { error: { code, message, ...extras } }
 *
 * Chanfana's built-in input-validation errors are normalized to this
 * shape in `apps/gateway/src/openapi/index.ts` via `raiseOnError: true`
 * + `app.onError()` — so every 4xx the gateway emits (handler-returned
 * or framework-returned) produces the same body structure.
 *
 * This is a thin wrapper over the shared `ErrorEnvelopeSchema` in
 * `@repo/api-schemas` so the gateway's OpenAPI spec and the OSS CLI
 * point at the exact same canonical shape. Single source of truth.
 *
 * Note: Chanfana's codegen inspects the schema via `.shape` and may
 * choke on `.loose()` passthrough, so we rebuild a strict declarative
 * schema here for the spec — the runtime invariant is still checked
 * against `ErrorEnvelopeSchema` in tests.
 */
export const OpenApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/**
 * Canonical error-response helper for OpenAPI route schemas.
 *
 * Usage:
 *   responses: {
 *     200: { description: ..., content: { 'application/json': { schema: ... } } },
 *     401: errorResponse('Missing or invalid API key.'),
 *     404: errorResponse('Trace not found.'),
 *   }
 */
export function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': { schema: OpenApiErrorResponseSchema },
    },
  };
}

/**
 * 402 `entitlement_required` response schema.
 *
 * The base envelope is `{ error: { code, message } }`. Tier-gated routes
 * extend `error` with:
 *   - `entitlement` (always) — the feature key the agent can branch on
 *     to prompt a tier upgrade
 *   - `limit` / `current` (numeric quotas only) — the configured limit
 *     and the tenant's current count so the caller can render a precise
 *     upsell message without re-querying
 *
 * Declared separately from `OpenApiErrorResponseSchema` so SDK codegen
 * sees the extra fields as part of the typed contract. Schemathesis
 * still validates against the wider runtime envelope at the request
 * boundary; this schema is the publication shape.
 */
export const EntitlementRequiredResponseSchema = z.object({
  error: z.object({
    code: z.literal('entitlement_required'),
    message: z.string(),
    entitlement: z.string(),
    limit: z.number().optional(),
    current: z.number().optional(),
  }),
});

/**
 * Helper for declaring the 402 response on a tier-gated route.
 *
 * Usage:
 *   responses: {
 *     402: entitlementRequiredResponse(
 *       "Tenant tier does not include the 'max_apps' allowance.",
 *     ),
 *   }
 */
export function entitlementRequiredResponse(description: string) {
  return {
    description,
    content: {
      'application/json': { schema: EntitlementRequiredResponseSchema },
    },
  };
}

export type AppContext = Context<{ Bindings: Env; Variables: OpenAPIVariables }>;

export function getService(c: AppContext): AnalyticsService {
  // Row-policy scope: every analytics read is pinned to the
  // authenticated tenant + verified app from the auth middleware — never from
  // request input. With CLICKHOUSE_READ_USER configured, ClickHouse itself
  // enforces the tenant boundary via the `tenant_isolation*` row policies;
  // the app-layer WHERE clauses remain as defense in depth.
  const user = c.get('user');
  const service = getGatewayAnalyticsService(c.env, {
    tenantId: user.tenantId,
    appId: user.appId,
  });
  if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');
  return service;
}

/**
 * Build a Supabase client scoped to the current request's authentication
 * mode.
 *
 * Two paths:
 *
 *   - **API-key auth** (`user.authMode === 'apikey'`): mints a
 *     gateway-role JWT with the caller's `gateway_permissions` and tenant
 *     claim; PostgREST switches into the `gateway` Postgres role and the
 *     `gateway_tenant_*` RLS policies fire.
 *
 *   - **Bearer auth** (`user.authMode === 'bearer'`): forwards the user's
 *     own Supabase JWT plus the request's resolved tenant as `X-Tenant-Id`;
 *     PostgREST routes into the `authenticated` role and the dashboard's
 *     existing `app_authorize()` / `authorize()` / `tenant_id()` RLS policies
 *     fire, scoped to the resolved tenant (the DB re-validates membership).
 *     No separate gateway-role permission translation.
 *
 * Handlers never need to know which; the returned client obeys the same
 * `SupabaseClient<Database>` interface, and the correct RLS surface fires
 * for whichever auth path produced it.
 */
export async function getScopedSupabase(
  c: AppContext,
): Promise<SupabaseClient<Database>> {
  const user = c.get('user');

  if (user.authMode === 'bearer') {
    if (!user.userJwt) {
      // Defensive — auth middleware should always populate userJwt for
      // bearer sessions. If this fires, audit the middleware path.
      throw new Error('bearer user context is missing userJwt');
    }
    return createAuthenticatedClient(c.env, user.userJwt, user.tenantId);
  }

  return createTenantScopedClient(
    c.env,
    user.tenantId,
    user.gatewayUserId ?? user.tenantId,
    user.permissions ?? [],
  );
}

/**
 * Maps OTLP numeric status codes to human-readable strings for the public API.
 * Internal storage (ClickHouse) and the dashboard UI use numeric codes per the
 * OTLP wire protocol. The public API normalizes to named strings per Google
 * AIP-126 and OTel semantic conventions (otel.status_code).
 */
const STATUS_CODE_MAP: Record<string, string> = {
  '0': 'UNSET',
  '1': 'OK',
  '2': 'ERROR',
  // Legacy stored variants. Rows written before the converter normalized
  // StatusCode (normalizeOtlpStatusCode in services/span-converter.ts) may
  // carry raw OTLP enum names — surface them as the same canonical labels.
  'STATUS_CODE_UNSET': 'UNSET',
  'STATUS_CODE_OK': 'OK',
  'STATUS_CODE_ERROR': 'ERROR',
  'Unset': 'UNSET',
  'Ok': 'OK',
  'OK': 'OK',
  'UNSET': 'UNSET',
  'Error': 'ERROR',
  'ERROR': 'ERROR',
};

const STATUS_NAME_TO_CODE: Record<string, string> = {
  'UNSET': '0',
  'OK': '1',
  'ERROR': '2',
};

/** Maps a numeric OTLP status code to a named string for API responses. */
export function mapStatusToName(numericCode: string): string {
  return STATUS_CODE_MAP[numericCode] ?? numericCode;
}

/** Maps a named status string from API input to the numeric code for ClickHouse queries. */
export function mapStatusToCode(name: string): string | undefined {
  return STATUS_NAME_TO_CODE[name.toUpperCase()];
}

export { statusCodeEquivalents } from '../../services/span-converter';

/** `TenantContext.dataRetentionDays` sentinel meaning "no clamp" —
 * `AgentFleetService.clampToRetention` treats it as unlimited. The public
 * /v1/* API surface never resolves a tenant's plan retention, so every
 * gateway API read is retention-unclamped; the clamp binds only dashboard
 * reads, which resolve the tenant's plan retention via
 * `entitlementService.getLimit(tenantId, 'data_retention_days')` before
 * building their TenantContext (see apps/tenant-dashboard/src/lib/api/with-api.ts
 * and apps/tenant-dashboard/src/app/api/analytics/with-auth.ts). */
const API_UNCLAMPED_RETENTION_DAYS = -1;

/**
 * Builds a TenantContext from the gateway auth middleware user.
 * Centralizes the construction so all gateway handlers use the same pattern.
 * Gateway API keys don't have a userId concept — defaults to empty string.
 */
export function buildTenantContext(c: AppContext): TenantContext {
  const user = c.get('user');
  return {
    userId: '',
    tenantId: user.tenantId,
    appId: user.appId,
    dataRetentionDays: API_UNCLAMPED_RETENTION_DAYS,
  };
}

/**
 * Canonical error envelope for the public /v1/* API.
 *
 * Shape matches Stripe/OpenAI/Anthropic conventions:
 *   { error: { code, message, ...extras } }
 *
 * Readers: `body.error.message` for display, `body.error.code` for
 * programmatic branching.
 *
 * The `GatewayErrorCode` union is the source of truth for codes emitted by
 * /v1/* handlers. Add a new code here before emitting it from a handler —
 * the compile-time constraint on `structuredError()` prevents drift
 * (e.g. `not_found_trace` vs `trace_not_found`).
 */
// Error-envelope helpers moved to the neutral src/errors.ts so the runtime
// layer can build them without importing from openapi/routes (architecture
// review #5). Re-exported here so route imports (`from './_shared'`) are unchanged.
export { structuredError } from '../../errors';
export type { GatewayErrorCode, StructuredErrorBody } from '../../errors';

/**
 * Runtime assertion that ClickHouse query params include tenant scoping.
 *
 * All queries against tenant tables (otel_traces, scores) MUST be scoped
 * by both TenantId and AppId. Call this before every direct client.query()
 * or client.command() in gateway route handlers.
 *
 * @throws {Error} if tenantId or appId is missing or empty
 */
export function assertTenantScoped(params: Record<string, unknown>): void {
  if (!params.tenantId) {
    throw new Error(
      'ClickHouse query missing tenantId — all queries against tenant tables must include TenantId = {tenantId:String}',
    );
  }
  if (!params.appId) {
    throw new Error(
      'ClickHouse query missing appId — all queries against tenant tables must include AppId = {appId:String}',
    );
  }
}

/**
 * `EnvironmentQueryScope` plus the bound environment's UUID.
 *
 * ClickHouse data is env-stamped by *name* (via `buildEnvironmentWhereClause`),
 * but Supabase tables carry the env as an FK (`deployment.environment_id`) —
 * and `deployment.environment_name` is a saga-only column that is NULL on
 * ordinary push/build rows, so filtering on it silently drops them. Routes
 * querying Supabase by env must use `environmentId`.
 */
export interface ApiKeyEnvScope extends EnvironmentQueryScope {
  /** UUID of the environment the API key is bound to. */
  environmentId?: string;
}

/**
 * A scope that matches no rows: an explicitly EMPTY allow-list.
 *
 * `buildEnvironmentWhereClause` treats an empty `environments` array as
 * "this caller may read no environment" and emits a false predicate, which is
 * distinct from `undefined` ("no env filter"). The two must not be conflated:
 * one denies everything, the other permits everything.
 */
const IMPOSSIBLE_ENV_SCOPE: ApiKeyEnvScope = { environments: [] };

/**
 * Env scope for a KIND-scoped API key: every environment of the caller's app
 * whose target kind is in the key's allowed set.
 *
 * Read as the system admin client for the same reason `resolveEnvScope` does —
 * the caller is the `gateway` role, whose `environment` policy is tenant-wide, so
 * scoping is applied here explicitly (`tenant_id` AND `app_id` both pinned from
 * the verified user context, never from request input).
 *
 * Throws on a transient failure rather than degrading, matching the fail-closed
 * contract of the pinned-env path: the caller retries and we never broaden
 * authorization on a blip.
 */
async function resolveKindScope(
  c: AppContext,
  allowedEnvKinds: readonly string[],
): Promise<ApiKeyEnvScope> {
  const user = c.get('user');
  const rows = await listAppEnvironments(c.env, user.tenantId, String(user.appId));
  return kindScopeFromRows(rows, allowedEnvKinds);
}

/** One environment row, as much of it as the kind classification needs. */
export interface EnvKindRow {
  name: string | null;
  current_version: number | null;
  is_ephemeral: boolean | null;
}

/**
 * The kind-scope decision, separated from the query that feeds it.
 *
 * Split out so the part that decides scope — which environments a set of allowed
 * kinds admits, and what happens when it admits none — is testable as a pure
 * function over rows, with no Supabase client to stand up.
 */
export function kindScopeFromRows(
  rows: readonly EnvKindRow[],
  allowedEnvKinds: readonly string[],
): ApiKeyEnvScope {
  // Typed to admit null so the lookup needs no null branch: `envTargetOf`
  // returns null only for the `unknown` EnvKind, which `classifyEnvKind` never
  // produces, and a set built from the caller's kind strings cannot contain null
  // anyway. An explicit `kind !== null &&` guard would be a branch that can never
  // be false — dead code that no test can kill.
  const allowed = new Set<string | null>(allowedEnvKinds);
  const names = rows
    .filter((env) =>
      allowed.has(
        envTargetOf({
          current_version: env.current_version ?? 0,
          is_ephemeral: env.is_ephemeral,
        }),
      ),
    )
    .map((env) => env.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);

  if (names.length === 0) return IMPOSSIBLE_ENV_SCOPE;
  return { environments: names };
}

/**
 * Resolve the API-key-bound environment as an `EnvironmentQueryScope`.
 *
 * Used by analytics read routes to scope ClickHouse queries to
 * the environment the caller's API key is bound to. Returns `undefined` when
 * the key has no env binding (legacy / bearer auth) — callers then pass no
 * env filter, returning cross-env data.
 *
 * The `isDefault` flag mirrors the environment's `is_default` column (resolved
 * by `resolveEnvironmentFromApiKey`). It drives the legacy-row branch of
 * `buildEnvironmentWhereClause`: a default-env API key must also see
 * pre-feature traces/scores stamped with `Environment = ''`, exactly as the
 * dashboard's default-env view does.
 *
 * **Fail CLOSED on resolution errors.** An env-bound API key must not silently
 * degrade to cross-env access if `resolveEnvironmentFromApiKey` throws (e.g. a
 * transient Supabase blip). Re-throwing yields a 500 to the caller — they
 * retry, and we never broaden authorization on a transient failure. The earlier
 * fail-open code path (returning `undefined` on throw) would have leaked
 * traces from other envs to the bound caller.
 */
export async function resolveEnvScope(c: AppContext): Promise<ApiKeyEnvScope | undefined> {
  const user = c.get('user');
  if (!user.apiKeyId) return undefined;

  // A KIND-scoped key (e.g. "Preview only") has `environment_id IS NULL` and
  // carries `allowedEnvKinds` instead, so it has to be handled before the
  // pinned-env resolver below — that one takes its row-absent branch for such a
  // key and yields `undefined`, which means NO env filter.
  //
  // Resolve the kinds to concrete env names and hand back the plural
  // `environments` form (`Environment IN (...)`). Fails CLOSED: an empty set
  // yields an impossible scope rather than an unfiltered read, so a key whose
  // kinds match nothing sees nothing instead of everything.
  if (user.allowedEnvKinds && user.allowedEnvKinds.length > 0) {
    return resolveKindScope(c, user.allowedEnvKinds);
  }

  try {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: asServiceClient(createSystemAdminClient(c.env)),
      apiKeyId: user.apiKeyId,
      tenantId: user.tenantId,
      environmentIdFromToken: user.environmentId,
      // Read-path requirement: a transient Supabase failure must throw rather
      // than return `null`, because `null` maps to "no env filter" and so
      // widens the read across environments. A resolver that swallows
      // transient errors and returns NO_ENVIRONMENT would also make this
      // function's catch block unreachable. With
      // `failClosed: true` the resolver throws EnvironmentResolutionError,
      // which we let propagate to Hono's onError as a 500. The caller retries;
      // we never broaden authorization on a transient blip.
      failClosed: true,
    });
    if (!resolved) return undefined;
    return {
      environment: {
        name: resolved.name,
        isDefault: resolved.isDefault,
      },
      environmentId: resolved.id,
    };
  } catch (e) {
    console.error('[resolveEnvScope] env resolution failed for env-bound key, failing closed:', e);
    throw e;
  }
}

export { EnvironmentQueryScope };
