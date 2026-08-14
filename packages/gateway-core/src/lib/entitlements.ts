/**
 * Tier-based entitlement enforcement for the gateway.
 *
 * The resolution logic — override → tier matrix → hobby default — lives
 * in `@repo/entitlements`. Same package is consumed by the dashboard's
 * `EntitlementService` so the dashboard render, cron evaluation, and
 * gateway request paths all agree on "is this tenant entitled?".
 *
 * This file owns the gateway-specific concerns:
 *   - The narrow allowlist of keys (`GatewayEntitlement`,
 *     `GatewayNumericEntitlement`) so a typo in a route registration
 *     can't silently skip enforcement.
 *   - The middleware factories (`enforceEntitlement`, `enforceQuota`)
 *     that translate the resolved value into a 402 envelope.
 *   - The Supabase admin-client construction at the middleware boundary
 *     (the shared resolver is HTTP-transport-agnostic).
 *   - Structured observability — every deny + every error emits a
 *     `LoggerService` event so the billing-funnel and on-call
 *     dashboards can see what's happening. `c.executionCtx.waitUntil`
 *     flushes Logtail without blocking the response.
 *
 * Auth-mode independence (why admin client, not scoped):
 *   The gateway accepts both API-key auth (sets `authMode: 'apikey'`,
 *   uses the gateway Postgres role) and bearer auth (sets
 *   `authMode: 'bearer'`, uses the user's JWT in the authenticated
 *   role) — the dashboard reaches /v1/* over the latter, using the
 *   user's Supabase session JWT.
 *
 *   The `authenticated`-role RLS policy on `billing` (see
 *   `30-billing.sql`) requires the `billing.read` app permission,
 *   which a regular user hitting a gated endpoint almost certainly
 *   doesn't have. A scoped-client read would return zero rows for those
 *   tenants → resolver falls back to hobby → paying customers get
 *   miscategorised as `entitlement_required`.
 *
 *   Admin client + the explicit `.eq('tenant_id', tenantId)` filter
 *   that the shared resolver already applies covers both auth modes
 *   uniformly. The tenant-isolation invariant lives in
 *   `@repo/entitlements/src/resolver.ts` and is tested at the package
 *   level (see "scopes to the requested tenant" test).
 */

import type { Context, Next } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveBooleanEntitlement as resolveBooleanEntitlementShared,
  resolveNumericLimit as resolveNumericLimitShared,
  quotaCheck,
  type EntitlementResolverLogger,
} from '@repo/entitlements';
import {
  isSelfHostDeployment,
  resolveSelfHostBoolean,
  SELF_HOST_NUMERIC_LIMIT,
} from '@repo/ee-license';
import type { CheckEnvLimitFn } from '@repo/environments-service';
import { createSystemAdminClient } from './system-client';
import type { ILoggerService } from '../services/logger-types';
import type { Env } from '../types';
import type { Database } from '../db';
import type { OpenAPIVariables } from '../openapi/middleware';

/** Admin Supabase client passed into quota count fetchers. */
export type SystemSupabase = SupabaseClient<Database>;

/**
 * The boolean entitlement keys the gateway enforces. Add a new key here
 * BEFORE referencing it in `enforceEntitlement()` so the compile-time
 * check catches typos that would silently skip enforcement.
 *
 * Subset of `@repo/tier-config` boolean keys — only the ones the gateway
 * gates today. Keeping the list narrow makes the surface auditable:
 * every entry corresponds to at least one /v1/* write endpoint that
 * must be tier-checked.
 *
 * Other boolean entitlements (custom_metrics_enabled, custom_roles,
 * app_level_roles) currently have no gateway write surface — they're
 * dashboard-only. When a corresponding /v1/* endpoint lands, add the
 * key here and either an `enforceEntitlement(key)` registration call
 * or a hand-rolled check in the handler.
 */
export type GatewayEntitlement =
  // Cloud workers: enforced on POST /v1/workers/runs and the
  // persistent-session routes in routes/workers.ts.
  | 'workers_enabled'
  | 'persistent_worker_environments'
  // GET /v1/topics: gates headless (REST/MCP) access only. The dashboard
  // Topics UI renders for every tier regardless of this entitlement — there
  // is no dashboard-side check on it yet.
  | 'topics_enabled';

/**
 * The numeric (quota) entitlement keys the gateway enforces. Same
 * "add-before-use" rule as `GatewayEntitlement`.
 *
 * `max_spans_per_month` is enforced separately by `SpanLimitService` on
 * the trace ingestion path — it caches in-memory and queries ClickHouse
 * rather than Supabase, so it can't share the resolver here.
 *
 * `max_storage_gb_per_month` is enforced by `StorageCapService` on the
 * session-sync ingest path (Stripe usage meter, hobby tier only). The
 * remaining numeric keys (max_users, max_cdn_requests, data_retention_days,
 * rate_limit_rpm) have no gateway-side enforcement; they're checked by the
 * dashboard or other paths.
 */
export type GatewayNumericEntitlement =
  | 'max_api_keys'
  | 'max_apps'
  // Enforced on POST /v1/environments via the EnvironmentService
  // `checkEnvLimit` dep wired in environments.ts buildEnvironmentService.
  | 'max_environments_per_app'
  // Cloud workers: concurrency + monthly minutes on run launch,
  // live-environment count on session create (routes/workers.ts).
  | 'max_concurrent_worker_runs'
  | 'max_worker_minutes_per_month'
  | 'max_persistent_worker_environments';

// ---------------------------------------------------------------------------
// Logger bridge
//
// Per-request LoggerService that auto-injects tenant/app/request context
// and routes structured events to BetterStack (Logtail) + Sentry. The
// shared resolver speaks the narrow `EntitlementResolverLogger` interface;
// we adapt to it here so the resolver doesn't grow a Cloudflare Worker
// dependency.
// ---------------------------------------------------------------------------

interface MaybeUser {
  tenantId?: string;
  appId?: string;
}

function buildLogger(
  c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
  user: MaybeUser,
): ILoggerService {
  // The injected logger factory builds a request-scoped LoggerService bound to
  // the composition root's ExecutionContext (waitUntil-based Logtail flush),
  // so this module doesn't need to name LoggerService or a Cloudflare Worker
  // type directly.
  return c.get('gtx').logger.createLogger({
    tenantId: user.tenantId,
    appId: user.appId,
    source: 'gateway-entitlements',
  });
}

/**
 * Adapt `ILoggerService` to the shared resolver's logger interface.
 *
 * The resolver currently only invokes `warn` (fall-through paths on
 * Supabase read failures). `info` and `error` aren't bridged because
 * the resolver never calls them — adding placeholders here just to
 * satisfy the interface would be dead code. If the resolver grows
 * `.info()` or `.error()` calls, add them here; the
 * `EntitlementResolverLogger` interface in `@repo/entitlements` marks
 * all three as optional so the resolver won't crash on a missing
 * bridge method.
 */
function bridgeResolverLogger(logger: ILoggerService): EntitlementResolverLogger {
  return {
    warn(message, fields) {
      logger.warn(`[entitlements] ${message}`, fields);
    },
  };
}

/**
 * Coerce a `catch` / `Promise.allSettled` rejection reason into an Error.
 * `ILoggerService.error` takes an Error so it can populate Sentry's
 * `errorName` + stack. JS code (or transitive deps) sometimes throws
 * strings — the helper wraps those in `new Error(String(...))` so we
 * don't drop the rejection reason into Sentry as `undefined`.
 *
 * Centralised here so the four catch blocks below don't each carry
 * their own copy of the ternary — coverage and audit both improve.
 */
function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function flushLogger(
  c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
  logger: ILoggerService,
): void {
  // Don't block the response on log flush — use waitUntil so the runtime
  // keeps the connection alive until logs land in BetterStack. Route through
  // the injected gtx (never raw c.executionCtx: its getter throws under Node).
  c.get('gtx').waitUntil(logger.flush());
}

/**
 * Self-host detection for gateway code paths. Narrowed to the one env key
 * so callers can pass the Hono `c.env` / worker `env` directly —
 * `@repo/ee-license`'s own default of `process.env` doesn't exist on the
 * Cloudflare runtime. Single definition so every gateway surface (resolvers,
 * middlewares, SpanLimitService wiring) agrees on what "self-host" means:
 * the exact string 'true', nothing else.
 */
export function isSelfHostGateway(env: Pick<Env, 'OUTERLAYER_SELF_HOSTED'>): boolean {
  return isSelfHostDeployment({ OUTERLAYER_SELF_HOSTED: env.OUTERLAYER_SELF_HOSTED });
}

// Self-host resolution note: on a self-hosted deployment entitlements don't
// come from billing tiers — there is no Stripe there. Every numeric limit
// is unlimited and every non-EE boolean is on.
// `licensed: false` is deliberate: no EE key has a gateway write surface
// today, so this is purely the generous-default half — and it keeps any
// future EE key in `GatewayEntitlement` fail-closed until gateway license
// resolution exists (reuse `getSelfHostLicense` from @repo/ee-license then;
// the dashboard's `EntitlementService` shows the shape). Cloud deployments
// never set OUTERLAYER_SELF_HOSTED, so their resolution is byte-for-byte
// unchanged.

/**
 * Out-of-HTTP-context resolver. Cron jobs and ad-hoc scripts call this
 * when they need to ask the entitlement question for a tenant without
 * an authenticated request to scope by. Uses `createSystemAdminClient`
 * (service-role, bypasses RLS) — appropriate for cross-tenant batch
 * paths, NOT for per-request handlers (the middlewares below use a
 * scoped client so RLS enforces tenant isolation at the DB layer).
 */
export async function resolveBooleanEntitlement(
  env: Env,
  tenantId: string,
  key: GatewayEntitlement,
): Promise<boolean> {
  if (isSelfHostGateway(env)) return resolveSelfHostBoolean(key, false);
  const supabase = createSystemAdminClient(env);
  return resolveBooleanEntitlementShared(supabase, tenantId, key);
}

export async function resolveNumericLimit(
  env: Env,
  tenantId: string,
  key: GatewayNumericEntitlement,
): Promise<number> {
  if (isSelfHostGateway(env)) return SELF_HOST_NUMERIC_LIMIT;
  const supabase = createSystemAdminClient(env);
  return resolveNumericLimitShared(supabase, tenantId, key);
}

/**
 * Build the `checkEnvLimit` dependency the shared `EnvironmentService`
 * consumes. `EnvironmentService.createEnvironment` supplies the app's
 * current environment count; this resolves the `max_environments_per_app` tier
 * ceiling and applies the canonical `quotaCheck` comparison — so "over the
 * limit" has a single definition, shared with `enforceQuota`. Resolution uses
 * an admin client (the billing / override tables are not gateway-role
 * readable). Wired into POST /v1/environments via `buildEnvironmentService`.
 */
export function buildEnvLimitCheck(env: Env): CheckEnvLimitFn {
  return async ({ tenantId, currentCount }) => {
    // Self-host: unlimited, and no billing/tier reads at all. The tierName is
    // only ever interpolated into the over-limit message, which this branch
    // can't produce — but keep it truthful for any future caller.
    if (isSelfHostGateway(env)) {
      return { allowed: true, limit: SELF_HOST_NUMERIC_LIMIT, tierName: 'self-hosted' };
    }
    // Run the limit lookup and tier read in parallel — both hit the same
    // admin client. The tier name is surfaced on the failure result so the
    // user-facing message can read "…on the hobby tier — upgrade to add more".
    // Hobby-tier callers expect the plan name.
    const supabase = createSystemAdminClient(env);
    const [limit, tierName] = await Promise.all([
      resolveNumericLimitShared(supabase, tenantId, 'max_environments_per_app'),
      readBillingTierName(supabase, tenantId),
    ]);
    const { allowed } = quotaCheck(currentCount, limit);
    return { allowed, limit, tierName };
  };
}

/**
 * Read `billing.tier_id` for one tenant. Returns 'hobby' as the documented
 * default (matches `@repo/entitlements`'s `readTenantTier`) so a tenant with
 * no billing row still gets a sensible tier name on the env-limit message.
 *
 * Inlined here rather than re-exporting from `@repo/entitlements` — the
 * shared resolver keeps its tier reads private to make caching changes
 * possible without coordinating consumers. This is a single read in a
 * write-path (POST /v1/environments) so adding a second admin query is fine.
 */
async function readBillingTierName(
  supabase: SystemSupabase,
  tenantId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('billing')
    .select('tier_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    // A silent fallback to 'hobby' on a billing-table outage would hide the
    // root cause when users see surprising tier names in env-limit errors.
    // Log loud, then degrade — matches `@repo/entitlements`'s readTenantTier.
    console.error('[entitlements] readBillingTierName failed', {
      tenantId,
      error: error.message,
    });
  }
  const tier = (data as { tier_id?: string } | null)?.tier_id;
  return typeof tier === 'string' && tier.length > 0 ? tier : 'hobby';
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

/**
 * Per-route entitlement guard for chanfana-registered routes.
 *
 * Runs after auth + permission middleware (so `user.tenantId` is
 * populated and the caller has the right RBAC scope). Denies with 402
 * `entitlement_required` when the tenant's tier (or override) excludes
 * the feature. The 402 status code is the semantic match per RFC 9110
 * §15.5.2 ("Payment Required") — same code Stripe uses for tier-gated
 * resources. Body carries the `entitlement` key so the calling agent
 * can branch on it.
 *
 * Permission ⇄ entitlement ordering note: permission middleware also
 * runs per-route. If a caller fails permissions (wrong scope) AND
 * lacks entitlement, they see the 403 — permission is the more
 * actionable error (they need to re-mint the key) and we never want
 * to leak entitlement info to callers who lack the read scope.
 *
 * Observability: every deny + every infra error emits a structured
 * `entitlement_denied` / `entitlement_error` event through Logtail.
 * That's the billing-funnel signal: "how many hobby tenants hit
 * `max_apps` denied this month?"
 *
 * No caching: every gated request does two Supabase reads (override +
 * billing) against the admin client. Fine for the low-traffic write
 * endpoints currently gated. If a hot path is ever gated, copy the
 * TTL-cache pattern from `SpanLimitService` (5-min tier cache, 60s
 * count cache).
 */
export function enforceEntitlement(key: GatewayEntitlement) {
  // Named so route-registration tests can identify this handler in
  // `openApiApp.routes[].handler.name` and verify it's installed after
  // `permissionGuard` for tier-gated routes.
  return async function entitlementGuard(
    c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
    next: Next,
  ): Promise<Response | void> {
    const user = c.get('user');
    if (!user?.tenantId) {
      // Defensive — auth middleware should always populate user. If we
      // reach here with no user, the auth chain is misconfigured.
      // We use `warn` (not `error`) so we don't fabricate a synthetic
      // Error just to satisfy `logger.error(Error, …)`; the event +
      // fields are what get queried, and Sentry shouldn't page on a
      // 401 returned to a (probably misbehaving) caller. If this fires
      // in steady state, the alert lives downstream in the
      // `entitlement_auth_misconfigured` event aggregation.
      const logger = buildLogger(c, {});
      logger.warn('entitlement guard reached with no user on context', {
        event: 'entitlement_auth_misconfigured',
        key,
      });
      flushLogger(c, logger);
      return c.json(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
      );
    }

    const logger = buildLogger(c, user);

    let entitled: boolean;
    if (isSelfHostGateway(c.env)) {
      // Self-host: nothing is read — resolution is pure. Falls through to
      // the shared deny/next logic below so a future EE key in
      // `GatewayEntitlement` still produces the standard 402 unlicensed.
      entitled = resolveSelfHostBoolean(key, false);
    } else {
      try {
        // Admin client (service role): mode-independent. Both API-key and
        // bearer auth requests land here, and the bearer-auth path can't
        // use a scoped client because the authenticated-role RLS policy
        // on `billing` requires permissions the user doesn't have. The
        // tenant filter is in the shared resolver itself (`.eq('tenant_id',
        // tenantId)`), pinned by the `@repo/entitlements` test suite.
        const supabase = createSystemAdminClient(c.env);
        entitled = await resolveBooleanEntitlementShared(
          supabase,
          user.tenantId,
          key,
          bridgeResolverLogger(logger),
        );
      } catch (error) {
        logger.error(
          toError(error),
          {
            event: 'entitlement_error',
            key,
            source: 'resolver_throw',
          },
        );
        flushLogger(c, logger);
        // Infrastructure failure on the entitlement lookup is a real 500
        // (we couldn't decide one way or the other) — not the 402 path.
        return c.json(
          {
            error: {
              code: 'internal_error',
              message: 'Entitlement resolution failed',
            },
          },
          500,
        );
      }
    }

    if (!entitled) {
      // The billing-funnel signal. Aggregated to answer:
      //   - how many denials per key per day?
      //   - which tenants are hitting the gate the most? (upsell targets)
      //   - did a tier change in `tiers.json` actually reduce denials?
      logger.info('entitlement denied', {
        event: 'entitlement_denied',
        key,
      });
      flushLogger(c, logger);
      return c.json(
        {
          error: {
            code: 'entitlement_required',
            message: `Tenant tier does not include the '${key}' feature`,
            entitlement: key,
          },
        },
        402,
      );
    }

    return next();
  };
}

/**
 * Per-route quota guard for chanfana-registered routes.
 *
 * Mirrors `enforceEntitlement` but compares a per-tenant *count* against
 * a numeric tier limit. Use cases are creates that grow a counted
 * resource (e.g. POST /v1/api-keys → `max_api_keys`). The route opts in
 * by passing `{ quota: { key, getCurrentCount } }` to
 * `registerAuthenticatedRoute`.
 *
 * Ordering note (same as enforceEntitlement): runs AFTER permissionGuard
 * so a caller without the right scope sees 403, not 402 — we never want
 * to leak tier-limit state to a caller who lacks the read scope.
 *
 * Error attribution: limit-resolution and count-fetching run in parallel
 * via `Promise.allSettled` so the catch block can name which side
 * failed. Important on-call signal — a count-query failure (RLS misconfig,
 * table renamed) is a very different bug than a billing-table outage.
 *
 * The `getCurrentCount` callback runs per-request. Caching is the
 * caller's responsibility — for the api-keys case, creates are
 * low-volume enough that a per-request Supabase HEAD query is
 * acceptable. Higher-volume quota'd routes should add a TTL cache like
 * `SpanLimitService` does for `max_spans_per_month`.
 */
export interface QuotaUser {
  tenantId: string;
  appId?: string;
}

export function enforceQuota(options: {
  key: GatewayNumericEntitlement;
  /**
   * Fetch the tenant's current count of the quota'd resource. Receives
   * an admin Supabase client; the fetcher MUST scope its query by
   * tenant_id to avoid cross-tenant counts (the admin client bypasses
   * RLS). See `countApiKeysForTenant` in openapi/index.ts for the
   * canonical pattern.
   */
  getCurrentCount: (supabase: SystemSupabase, user: QuotaUser) => Promise<number>;
}) {
  return async function quotaGuard(
    c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
    next: Next,
  ): Promise<Response | void> {
    const user = c.get('user') as QuotaUser | null;
    if (!user?.tenantId) {
      // Same rationale as the boolean guard above: warn (not error) so
      // we don't synthesise an Error just to satisfy logger.error().
      const logger = buildLogger(c, {});
      logger.warn('quota guard reached with no user on context', {
        event: 'quota_auth_misconfigured',
        key: options.key,
      });
      flushLogger(c, logger);
      return c.json(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
      );
    }

    const logger = buildLogger(c, user);

    // Self-host: every numeric quota is unlimited, so skip the billing read
    // AND the count fetch — counting a resource against an infinite limit is
    // pure overhead. (quotaCheck(n, UNLIMITED) is always allowed.)
    if (isSelfHostGateway(c.env)) {
      return next();
    }

    // Admin client — mode-independent. Same rationale as enforceEntitlement:
    // bearer auth can't use a scoped client because the authenticated
    // role lacks the billing.read permission required by RLS. The
    // count query's tenant scope is the caller's responsibility (see
    // `countApiKeysForTenant`).
    let supabase: SystemSupabase;
    try {
      supabase = createSystemAdminClient(c.env);
    } catch (error) {
      logger.error(
        toError(error),
        { event: 'quota_error', key: options.key, source: 'admin_client' },
      );
      flushLogger(c, logger);
      return c.json(
        { error: { code: 'internal_error', message: 'Quota resolution failed' } },
        500,
      );
    }

    // Parallel + per-side error attribution. Promise.all would conflate
    // "limit lookup failed" with "count query failed" in the catch
    // block; on-call needs to know which side broke.
    const [limitResult, countResult] = await Promise.allSettled([
      resolveNumericLimitShared(
        supabase,
        user.tenantId,
        options.key,
        bridgeResolverLogger(logger),
      ),
      options.getCurrentCount(supabase, user),
    ]);

    if (limitResult.status === 'rejected') {
      const reason = limitResult.reason;
      logger.error(
        toError(reason),
        {
          event: 'quota_error',
          key: options.key,
          source: 'limit_resolver',
        },
      );
      flushLogger(c, logger);
      return c.json(
        { error: { code: 'internal_error', message: 'Quota resolution failed' } },
        500,
      );
    }
    if (countResult.status === 'rejected') {
      const reason = countResult.reason;
      logger.error(
        toError(reason),
        {
          event: 'quota_error',
          key: options.key,
          source: 'count_fetcher',
        },
      );
      flushLogger(c, logger);
      return c.json(
        { error: { code: 'internal_error', message: 'Quota resolution failed' } },
        500,
      );
    }

    const limit = limitResult.value;
    const current = countResult.value;
    const check = quotaCheck(current, limit);

    if (!check.allowed) {
      logger.info('quota denied', {
        event: 'quota_denied',
        key: options.key,
        limit,
        current,
      });
      flushLogger(c, logger);
      return c.json(
        {
          error: {
            code: 'entitlement_required',
            message: `Tenant tier limits '${options.key}' to ${limit}; ${current} already exist`,
            entitlement: options.key,
            limit,
            current,
          },
        },
        402,
      );
    }

    return next();
  };
}

// Re-export so route-registration callers can declare both at once.
export type { GatewayPermission } from './permissions';
