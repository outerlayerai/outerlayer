/**
 * CloudflareRateLimiter — the hosted `RateLimiter` adapter.
 *
 * Checks against Unkey's standalone ratelimiter. Self-provisioning (limit +
 * duration passed inline), and NEVER throws: no root key, a limiter error, or a
 * malformed response all FAIL OPEN (allow the request) — data-plane availability
 * beats strict enforcement when the limiter is degraded. Kept separate from
 * the shared `rate-limit.ts` so `@unkey/api` stays off the self-host
 * runtime's hot path.
 */
import { Unkey } from "@unkey/api";
import { allowOpen, type RateLimitOutcome } from "@repo/gateway-core/lib/rate-limit";
import type { RateLimiter } from "@repo/gateway-core/runtime/gateway-context";
import type { RateLimitConfig } from "@repo/gateway-core/rate-limits";
import type { Env } from "@repo/gateway-core/types";

export class CloudflareRateLimiter implements RateLimiter {
  constructor(private readonly env: Env) {}

  async check(config: RateLimitConfig, identifier: string): Promise<RateLimitOutcome> {
    // No root key (e.g. local dev / tests without Unkey) → no enforcement.
    if (!this.env.UNKEY_API_KEY) {
      return allowOpen(config);
    }

    try {
      const unkey = new Unkey({ rootKey: this.env.UNKEY_API_KEY });
      const res = await unkey.ratelimit.limit({
        namespace: config.namespace,
        identifier,
        limit: config.limit,
        duration: config.durationMs,
        cost: config.cost,
      });

      // Speakeasy wraps the payload in `data`; tolerate either shape defensively.
      const data = (res as { data?: unknown }).data ?? res;
      const d = data as { success?: boolean; limit?: number; remaining?: number; reset?: number };

      // If the response is malformed, treat as fail-open rather than blocking.
      if (typeof d?.success !== "boolean") {
        return allowOpen(config);
      }

      return {
        allowed: d.success,
        limit: d.limit ?? config.limit,
        remaining: d.remaining ?? 0,
        reset: d.reset ?? 0,
        failedOpen: false,
      };
    } catch (error) {
      console.warn("[ratelimit] check failed — failing open (request allowed):", {
        namespace: config.namespace,
        error: error instanceof Error ? error.message : String(error),
      });
      return allowOpen(config);
    }
  }
}
