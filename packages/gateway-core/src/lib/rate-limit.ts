/**
 * Shared rate-limit guard + helpers. The actual limiter check is a runtime seam
 * (`gtx.rateLimiter`): the Cloudflare adapter uses Unkey's standalone
 * ratelimiter (fail-open), the node self-host adapter is a no-op. This module
 * owns the tier→config decision, the response headers, and `allowOpen` (the
 * fail-open outcome both adapters return) — `@unkey/api` lives in the CF adapter,
 * not here, so it stays off the shared/self-host hot path.
 *
 * The guard runs AFTER authentication and NEVER blocks on limiter failure: the
 * adapters fail open, so a limiter outage never breaks the data plane.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types';
import type { RateLimitConfig, RateLimitTier, RouteRateLimit } from '../rate-limits';
import type { OpenAPIVariables } from '../openapi/middleware';

export interface RateLimitOutcome {
  /** True if the request is within the limit (or the limiter failed open). */
  allowed: boolean;
  /** The configured limit (for X-RateLimit-Limit). */
  limit: number;
  /** Remaining tokens in the window (for X-RateLimit-Remaining). */
  remaining: number;
  /** Unix ms when the window resets (for X-RateLimit-Reset); 0 if unknown. */
  reset: number;
  /** True when the outcome came from the fail-open path, not a real check. */
  failedOpen: boolean;
}

/** The fail-open outcome: allow the request with the full budget, flagged
 * `failedOpen`. Shared by both `RateLimiter` adapters (no root key / limiter
 * error → allow) and by the self-host no-op limiter. */
export function allowOpen(config: RateLimitConfig): RateLimitOutcome {
  return { allowed: true, limit: config.limit, remaining: config.limit, reset: 0, failedOpen: true };
}

/** Standard rate-limit response headers (RFC draft + Retry-After). */
function rateLimitHeaders(outcome: RateLimitOutcome): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(outcome.limit),
    'X-RateLimit-Remaining': String(Math.max(0, outcome.remaining)),
  };
  if (outcome.reset > 0) {
    headers['X-RateLimit-Reset'] = String(outcome.reset);
    headers['Retry-After'] = String(Math.max(1, Math.ceil((outcome.reset - Date.now()) / 1000)));
  }
  return headers;
}

/**
 * Per-route rate-limit guard for chanfana-registered routes, wired in
 * `registerAuthenticatedRoute` from a route's optional `static rateLimit`.
 *
 * Runs AFTER auth + permission, keyed by the authenticated tenantId, with the
 * tier (free/paid) read from the verified user. The check goes through the
 * injected `gtx.rateLimiter` seam, which fails open — a limiter outage never
 * blocks the request. On a genuine limit breach it returns 429 with
 * `Retry-After` + `X-RateLimit-*` headers so clients can back off.
 */
export function enforceRateLimit(routeLimit: RouteRateLimit) {
  return async function rateLimitGuard(
    c: Context<{ Bindings: Env; Variables: OpenAPIVariables }>,
    next: Next,
  ): Promise<Response | void> {
    const user = c.get('user');
    // Always reached after auth; if somehow unauthenticated there's no tenant
    // to key on, so let the request proceed (auth/permission already ran).
    if (!user?.tenantId) {
      return next();
    }

    // When the runtime doesn't enforce subscription tiers (self-host has no
    // Stripe subscriptions) there is no split to make — treat every tenant as
    // the unlimited 'paid' tier instead of collapsing to throttled 'free'.
    // Hosted (StripeBillingService) keeps the subscription-based split. The
    // signal is the injected billing adapter, not an env flag.
    const gtx = c.get('gtx');
    const { enforcesSubscriptionTiers } = gtx.billing;
    const tier: RateLimitTier =
      !enforcesSubscriptionTiers || user.stripeSubscriptionId ? 'paid' : 'free';
    const outcome = await gtx.rateLimiter.check(routeLimit[tier], user.tenantId);

    if (!outcome.allowed) {
      return c.json(
        { error: { code: 'rate_limited', message: 'Rate limit exceeded. Please retry later.' } },
        // Hono's c.json() typing doesn't accept status + headers together.
        { status: 429, headers: rateLimitHeaders(outcome) } as unknown as 429,
      );
    }

    return next();
  };
}
