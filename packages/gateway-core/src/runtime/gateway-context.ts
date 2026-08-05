/**
 * GatewayContext — the DI container the gateway threads through every request.
 *
 * Core (the runtime-agnostic gateway) declares these interfaces and consumes
 * *injected* instances; it never constructs an impl, never falls back to one,
 * and never branches on `null`. Each entrypoint's `buildGatewayContext` supplies
 * a concrete adapter for EVERY field — using an explicit no-op/inline adapter to
 * represent "disabled" (e.g. `NoopCacheStore`, `SelfHostBillingService`), never
 * `null`. A missing injection is a composition-root error, not a silent default.
 *
 * This file defines the shapes; the Cloudflare and self-host composition roots
 * supply the concrete adapters.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "@unkey/cache/stores";
import type { ExecutionCtx } from "./execution";
import type { ILoggerService, ExtendedLogContext } from "../services/logger-types";
import type { Env, StorageCapCheckResult, GatewayScheduleContext, GatewayCache } from "../types";
import type { Database } from "../db";
import type { VerifyKeyResult } from "../lib/verify-key";
import type { RateLimitOutcome } from "../lib/rate-limit";
import type { RateLimitConfig } from "../rate-limits";

/**
 * The L2 cache store — an `@unkey/cache` Store. `CloudflareCacheStore` (hosted)
 * and `NoopCacheStore` (self-host) both implement it; the L1 `MemoryStore` is
 * unaffected and always present. `TValue` is `any` to match the existing
 * `MemoryStore<string, any>`: one store instance is shared across the five
 * differently-typed cache namespaces (`UserMeta`, `PricingData`, …).
 */
export type CacheL2Store = Store<string, any>;

/**
 * Billing capability. Note this is on the INGEST HOT PATH: `checkStorageCap`
 * gates every ingest. `SelfHostBillingService` is a grant-everything Null Object
 * that returns the same "unlimited tier" result the real service returns when a
 * tenant has no cap — so self-host ingest never touches Stripe.
 *
 * `checkStorageCap` receives the per-request scoped Supabase client (built after
 * auth in the route), mirroring the ingestor receiving `service`. It also takes
 * the request's `GatewayCache`, which is where the tier and meter results are
 * cached. `initCache` is cheap per request; the stores it wraps are long-lived.
 *
 * `meteringTasks` returns the billing cron jobs (Stripe usage + storage meter)
 * so the scheduled handler can wrap them with the SAME `waitUntil` +
 * error-logging it already applies to the non-billing `alertHandler`. Billing
 * only declares what work it contributes — self-host returns `[]`. The
 * `waitUntil`/logging plumbing stays cron infrastructure, not a billing concern.
 *
 * `enforcesSubscriptionTiers` is the rate limiter's read of "does this runtime
 * split tenants into rate-limit tiers by Stripe subscription?" Hosted (Stripe)
 * → `true`, so a subscription-less tenant gets the throttled tier. Self-host →
 * `false`: there are no subscriptions, so every tenant gets the unlimited tier
 * instead of collapsing to `free`. The signal is which adapter the composition
 * root injected, not an env var, so it cannot drift from the runtime it
 * describes.
 */
export interface BillingService {
  checkStorageCap(
    supabase: SupabaseClient<Database>,
    tenantId: string,
    stripeCustomerId: string,
    cache: GatewayCache,
  ): Promise<StorageCapCheckResult>;

  meteringTasks(cron: GatewayScheduleContext): MeteringTask[];

  readonly enforcesSubscriptionTiers: boolean;
}

/** A single cron job the scheduled handler runs; `source` tags its error logs. */
export interface MeteringTask {
  source: string;
  run(): Promise<unknown>;
}

/** Produces a request-scoped logger. CF impl uses `@logtail/edge`; Node impl uses stdout. */
export interface LoggerFactory {
  createLogger(context?: ExtendedLogContext): ILoggerService;
}

/**
 * Resolves a programmatic (API-key) request to an authenticated tenant identity
 * — the runtime-specific auth seam. The Cloudflare adapter verifies the key
 * against Unkey (`verifyKey`); the node self-host adapter has no key service, so
 * it resolves the tenant from the app row in the operator's own Supabase
 * (`resolveAppIdentity`). The JWT/bearer path is deliberately NOT here: it's
 * runtime-agnostic (Supabase JWT validation) and the middleware handles it
 * BEFORE consulting this seam, so it stays fully tenant-validated on both runtimes.
 */
export interface AuthResolver {
  resolveApiKey(params: ResolveApiKeyParams): Promise<VerifyKeyResult>;
}

export interface ResolveApiKeyParams {
  authHeader: string;
  appId: string;
  env: Env;
  /** Optional identity cache (skips the Unkey round-trip within the TTL). The
   * self-host adapter ignores it — its Supabase lookup is already local. */
  cache?: GatewayCache;
  cacheKey?: string;
}

/**
 * Per-route request rate limiting — the runtime-specific limiter seam. The
 * Cloudflare adapter checks against Unkey's standalone ratelimiter (fail-open);
 * the node self-host adapter is a no-op that always allows (self-host enforces no
 * limits — the Worker's fail-open-without-a-root-key path was already effectively
 * this). The tier→config decision stays in the shared `enforceRateLimit` guard
 * (it reads `billing.enforcesSubscriptionTiers`); this seam only does the check,
 * so `@unkey/api` leaves the shared hot path.
 */
export interface RateLimiter {
  check(config: RateLimitConfig, identifier: string): Promise<RateLimitOutcome>;
}

/**
 * The injected container. Every field is non-nullable — see the module doc.
 */
export interface GatewayContext {
  /** Schedule background work that outlives the response (Worker execCtx / Node shim). */
  waitUntil(promise: Promise<unknown>): void;
  /**
   * The (runtime-neutral) execution context the composition root captured —
   * on Cloudflare the real Worker `ExecutionContext`, under Node the middleware's
   * no-op shim. Exposed because the `@unkey/cache` `Namespace` (via `initCache`)
   * needs a ctx object with `waitUntil`, not just the bare function. Call sites
   * MUST read this instead of `c.executionCtx`: Hono's getter THROWS when no
   * ExecutionContext was supplied (i.e. under `@hono/node-server`), so raw
   * `c.executionCtx` access 500s every request on the Node runtime.
   */
  execCtx: ExecutionCtx;
  cacheL2Store: CacheL2Store;
  billing: BillingService;
  logger: LoggerFactory;
  auth: AuthResolver;
  rateLimiter: RateLimiter;
}

/**
 * The composition-root factory each entrypoint implements. Core never calls a
 * concrete impl — a runtime-specific `buildGatewayContext` assembles the adapter
 * set from that runtime's config and lifecycle.
 */
export type BuildGatewayContext = (env: Env, execCtx: ExecutionCtx) => GatewayContext;
