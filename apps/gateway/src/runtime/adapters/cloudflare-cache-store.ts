/**
 * Cloudflare impl of the L2 `CacheL2Store` — the hosted default.
 *
 * Returns the existing `@unkey/cache` `CloudflareStore`, built from the
 * `CLOUDFLARE_*` cache vars. This is exactly the store `initCache` constructs
 * inline today; Step 3d moves that construction here and has `initCache` take the
 * store from the injected `GatewayContext` instead. Self-host injects
 * `NoopCacheStore` instead (no `CLOUDFLARE_*` vars).
 */
import { CloudflareStore } from "@unkey/cache/stores";
import type { Env } from "@repo/gateway-core/types";
import type { CacheL2Store } from "@repo/gateway-core/runtime/gateway-context";

type CacheBindings = Pick<
  Env,
  "CLOUDFLARE_CACHE_DOMAIN" | "CLOUDFLARE_ZONE_ID" | "CLOUDFLARE_API_KEY"
>;

export function createCloudflareCacheStore(env: CacheBindings): CacheL2Store {
  return new CloudflareStore({
    domain: env.CLOUDFLARE_CACHE_DOMAIN!,
    zoneId: env.CLOUDFLARE_ZONE_ID!,
    cloudflareApiKey: env.CLOUDFLARE_API_KEY!,
  });
}
