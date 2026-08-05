import type { GatewayCache, ModelRegistryKV, PricingData } from "../types";
import {
  modelsCostMapping,
  refreshModelPricing,
  type ModelRegistrySource,
} from "@repo/llm-costs";

/** Cache key for pricing data */
const PRICING_CACHE_KEY = "llm-pricing-data";

/**
 * Interface for the pricing service
 */
export interface IPricingService {
  /**
   * Get pricing data, using cache if available
   */
  getPricingData(): Promise<PricingData>;
}

/** Adapt a Cloudflare KV namespace to the registry source shape. */
export function kvRegistrySource(kv: ModelRegistryKV): ModelRegistrySource {
  return { get: (key) => kv.get(key, "text") };
}

/**
 * One refresh per isolate, shared by every PricingService built in it.
 *
 * Keyed by source so a test (or a second binding) gets its own attempt rather
 * than silently reusing the first caller's result. Deliberately NOT started at
 * module load: the source is a request/environment binding, so there is nothing
 * to read from until a caller supplies one.
 */
const refreshBySource = new WeakMap<ModelRegistrySource, Promise<void>>();

function refreshOnce(source: ModelRegistrySource): Promise<void> {
  const existing = refreshBySource.get(source);
  if (existing) return existing;
  const started = refreshModelPricing(source)
    .then((result) => {
      // A silently-failing refresh is indistinguishable from a working one
      // until someone notices a new model priced at zero — which is exactly how
      // the previous jsdelivr source went unnoticed. Say so instead.
      if (!result?.refreshed) {
        console.warn(
          `[pricing] model registry refresh did not apply (${result?.reason ?? "unknown"}) — ` +
            "serving the price map bundled at build time. Models released since that build " +
            "will not be priced.",
        );
      }
    })
    .catch(() => {
      // Never let a pricing refresh reject a request path.
    });
  refreshBySource.set(source, started);
  return started;
}

/**
 * PricingService returns LLM pricing data derived from the model registry.
 *
 * Given a registry source it refreshes once per isolate, then serves that map.
 * Without one — self-host, local dev, tests — it serves the snapshot bundled at
 * build time, which is correct but only as current as the last deploy.
 */
export class PricingService implements IPricingService {
  constructor(
    private readonly cache: GatewayCache,
    private readonly source?: ModelRegistrySource,
  ) {}

  async getPricingData(): Promise<PricingData> {
    const cached = await this.cache.pricingData.get(PRICING_CACHE_KEY);
    if (cached.val) {
      return cached.val;
    }

    // Refresh before serving the first uncached response, so the cache is
    // populated from fresh data rather than pinning the bundled snapshot for
    // the life of the cache entry.
    if (this.source) await refreshOnce(this.source);

    const pricingData: PricingData = modelsCostMapping as PricingData;
    await this.cache.pricingData.set(PRICING_CACHE_KEY, pricingData);

    return pricingData;
  }
}

/**
 * Create a PricingService with the given cache, and optionally the KV-backed
 * registry source. Callers without a binding get bundled pricing.
 */
export function createPricingService(
  cache: GatewayCache,
  source?: ModelRegistrySource,
): IPricingService {
  return new PricingService(cache, source);
}
