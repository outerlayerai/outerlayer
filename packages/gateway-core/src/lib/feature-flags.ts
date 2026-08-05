/**
 * Per-tenant feature-flag evaluation for gateway route handlers.
 *
 * Thin wrapper that stands up the gateway cache + `FeatureFlagService` and
 * evaluates a single flag for a tenant. Centralizing it here gives route
 * handlers a one-line gate AND a single seam to mock in route tests (so a
 * handler test never has to wire `initCache` / Cloudflare cache bindings).
 *
 * Evaluation semantics (see services/feature-flag-service.ts): a missing flag
 * row resolves to `false`, so a feature is gated-by-default until a platform
 * admin creates/enables the flag (globally or via a per-tenant override).
 *
 * @see apps/gateway/src/services/feature-flag-service.ts
 * @see apps/tenant-dashboard/src/flags/flags.ts (the matching dashboard key)
 */

import type { ExecutionCtx, CacheL2Store } from '../runtime';

import type { Env } from '../types';
import { createFeatureFlagService } from '../services';
import { initCache } from '../utils';
import { memory } from '../cache-store';

/**
 * Flag key gating the environment-rollback feature (UI + API). OFF until a
 * platform admin enables it. MUST stay in sync with the dashboard's
 * `enableEnvRollback` flag key.
 */
export const ENV_ROLLBACK_FLAG = 'enable_env_rollback';

/**
 * Evaluate a feature flag for the given tenant inside a request handler.
 *
 * @param env           Worker bindings (Supabase + Cloudflare cache config).
 * @param executionCtx  Execution context (pass gtx.execCtx, never raw c.executionCtx) — used for the cache namespace.
 * @param flagKey       The `feature_flag.key` to evaluate.
 * @param tenantId      Tenant to evaluate for; overrides win when present.
 * @returns `true` only when the flag resolves enabled for this tenant.
 *
 * Fails closed: any unexpected error (cache miss path throwing, Supabase
 * unreachable, etc.) resolves to `false`. A flaky dependency must degrade to
 * "feature disabled" (the caller 404s) rather than bubble into a 500 — and must
 * never accidentally EXPOSE a gated feature. Mirrors the dashboard's
 * fail-closed `useEnvRollbackEnabled` hook.
 */
export async function isFeatureEnabled(
  env: Env,
  executionCtx: ExecutionCtx,
  cacheL2Store: CacheL2Store,
  flagKey: string,
  tenantId?: string,
): Promise<boolean> {
  try {
    const cache = initCache(cacheL2Store, executionCtx, memory);
    const service = createFeatureFlagService(cache, env);
    // `await` inside the try so a rejected promise is caught here, not by the
    // caller (a bare `return service.isEnabled(...)` would escape this catch).
    return await service.isEnabled(flagKey, tenantId);
  } catch (err) {
    console.error(
      `[isFeatureEnabled] '${flagKey}' evaluation failed; treating as disabled`,
      err,
    );
    return false;
  }
}
