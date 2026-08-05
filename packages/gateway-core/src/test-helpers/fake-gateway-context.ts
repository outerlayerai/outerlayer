/**
 * A fake `buildGatewayContext` for gateway-core unit tests.
 *
 * Core route/middleware tests need *a* `gtx` (auth reads `gtx.cacheL2Store`) but
 * must NOT reach for the Cloudflare composition root — that lives in apps/gateway
 * and pulls Stripe / @logtail bindings a core unit test has no business loading.
 * This double mirrors the real container's shape with in-memory / no-op adapters:
 *
 *   - `cacheL2Store` is a no-op L2 (every read misses → the L1 MemoryStore serves).
 *   - `billing` and `logger` are grant-all / no-op.
 *
 * Tests that need specific behavior override the relevant field on the returned
 * object (e.g. `gtx.billing.checkStorageCap = vi.fn()...`).
 */
import { Ok } from '@unkey/error';
import { verifyKey } from '../lib/verify-key';
import { NoopRateLimiter } from '../runtime/adapters/noop-rate-limiter';
import type { Env } from '../types';
import type { ExecutionCtx } from '../runtime/execution';
import type {
  CacheL2Store,
  GatewayContext,
} from '../runtime/gateway-context';

const noopCacheL2Store: CacheL2Store = {
  name: 'fake-noop',
  async get() {
    return Ok(undefined);
  },
  async set() {
    return Ok();
  },
  async remove() {
    return Ok();
  },
};

/** Build a fake `GatewayContext`. Drop-in for the Cloudflare `buildGatewayContext`
 * in core unit tests. Override fields on the result for per-test behavior. */
export function fakeBuildGatewayContext(_env: Env, execCtx: ExecutionCtx): GatewayContext {
  return {
    waitUntil: (p) => {
      try {
        execCtx?.waitUntil?.(p);
      } catch {
        void Promise.resolve(p).catch(() => {});
      }
    },
    // Always a valid ctx object so cache-init call sites can read gtx.execCtx
    // (fake tests sometimes pass a partial/undefined execCtx).
    execCtx:
      execCtx ??
      ({
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionCtx),
    cacheL2Store: noopCacheL2Store,
    billing: {
      checkStorageCap: async () => ({
        allowed: true,
        currentBytes: 0,
        limitBytes: -1,
        capReached: false,
      }),
      meteringTasks: () => [],
      enforcesSubscriptionTiers: true,
    },
    logger: {
      createLogger: () => ({
        info() {},
        warn() {},
        error() {},
        async flush() {},
      }),
    },
    // Delegate to the real verifyKey so existing route/middleware tests drive auth
    // exactly as in production (hashing the key + the verify_api_key RPC, mocked
    // via the msw Supabase handler). Tests needing self-host behavior override this.
    auth: { resolveApiKey: (params) => verifyKey(params) },
    // No-op limiter — rate limiting fails open by default, so unit tests never
    // see 429s unless explicitly configured. Tests needing 429s override this field.
    rateLimiter: new NoopRateLimiter(),
  };
}
