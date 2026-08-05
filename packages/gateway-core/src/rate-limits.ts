/**
 * Single source of truth for gateway rate limits.
 *
 * These limits are applied via Unkey's STANDALONE ratelimiter
 * (`unkey.ratelimit.limit`, see `lib/rate-limit.ts`), keyed by tenantId, as a
 * fail-open step that runs AFTER authentication — never coupled to key
 * verification. The standalone limiter self-provisions: the limit + duration
 * are defined here, in code, so there is no per-identity Unkey configuration
 * to drift or go missing.
 *
 * This file is the only definition of these limits, and they must not also be
 * provisioned onto a tenant's Unkey identity. Unkey v2 returns a hard 412 from
 * `verifyKey` when an identity references a named limit it does not carry, and
 * the gateway turns that into a 500 — so any tenant the provisioning step
 * missed would fail authentication outright, not merely lose its rate limit.
 */

export type RateLimitTier = 'free' | 'paid';

export interface RateLimitConfig {
  /** Unkey ratelimit namespace (the logical bucket the counter lives in). */
  namespace: string;
  /** Max requests allowed within `durationMs`. */
  limit: number;
  /** Window length in milliseconds. */
  durationMs: number;
  /** Tokens deducted per request. */
  cost: number;
}

// A ceiling high enough it never trips in practice — used for paid tiers where
// the cap is "effectively unlimited" but we still want one uniform code path.
const EFFECTIVELY_UNLIMITED = { limit: 100_000, durationMs: 5_000 } as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Template (prompt) reads. Free tenants get a soft monthly cap; paid tenants
 * are effectively unlimited. Applied to `template.read` routes only — not
 * lumped across every endpoint (rate-limit best practice: separate operations
 * into their own buckets rather than one shared "requests" limit).
 */
export const TEMPLATE_READ_RATE_LIMIT: Record<RateLimitTier, RateLimitConfig> = {
  free: {
    namespace: 'template-request',
    limit: 1_000,
    durationMs: THIRTY_DAYS_MS,
    cost: 1,
  },
  paid: {
    namespace: 'template-request',
    ...EFFECTIVELY_UNLIMITED,
    cost: 1,
  },
};

const ONE_MINUTE_MS = 60_000;

/**
 * Observability reads — trace/span/score list, detail, search, and the
 * filter-schema discovery endpoint. These hit ClickHouse, where one runaway
 * client (an agent in a retry loop is the canonical case) can monopolize the
 * analytical store for the whole region. Per-minute buckets protect it. Paid is
 * a real protective ceiling here — not EFFECTIVELY_UNLIMITED — because an
 * unthrottled read loop degrades the store for every other tenant, not just
 * for the caller who wrote it.
 */
export const OBSERVABILITY_READ_RATE_LIMIT: Record<RateLimitTier, RateLimitConfig> = {
  free: {
    namespace: 'observability-read',
    limit: 100,
    durationMs: ONE_MINUTE_MS,
    cost: 1,
  },
  paid: {
    namespace: 'observability-read',
    limit: 1_000,
    durationMs: ONE_MINUTE_MS,
    cost: 1,
  },
};

/** A per-tier rate-limit config bundle, as declared on a route. */
export type RouteRateLimit = Record<RateLimitTier, RateLimitConfig>;

/**
 * Per-route rate-limit configs. A route opts in by setting
 * `static rateLimit = RATE_LIMITS.templateRead`; routes without it are not
 * rate-limited.
 */
export const RATE_LIMITS = {
  templateRead: TEMPLATE_READ_RATE_LIMIT,
  observabilityRead: OBSERVABILITY_READ_RATE_LIMIT,
} as const satisfies Record<string, RouteRateLimit>;
