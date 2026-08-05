/**
 * NoopRateLimiter — the node self-host `RateLimiter` adapter.
 *
 * Self-host enforces no request rate limits: every check allows the request
 * (`allowOpen`). This is the same effective behavior the Cloudflare adapter
 * already had when no Unkey root key was configured — made the explicit,
 * composition-selected default for a runtime that has no Unkey at all.
 */
import { allowOpen, type RateLimitOutcome } from "../../lib/rate-limit";
import type { RateLimiter } from "../gateway-context";
import type { RateLimitConfig } from "../../rate-limits";

export class NoopRateLimiter implements RateLimiter {
  async check(config: RateLimitConfig): Promise<RateLimitOutcome> {
    return allowOpen(config);
  }
}
