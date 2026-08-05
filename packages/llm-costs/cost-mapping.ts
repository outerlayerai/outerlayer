// Static JSON imports — bundled by esbuild/wrangler at build time.
// Used as immediate fallback; refreshModelPricing() fetches fresh data from CDN.
import modelsFile from "@repo/model-registry/models.json";
import overridesFile from "@repo/model-registry/overrides.json";
// `/pricing` is the fs-free entry point — safe to bundle for Workers.
import {
  buildPricingDictionary,
  buildTokenPricingDictionary,
  type PricingDictionary,
  type TokenPricingDictionary,
} from "@repo/model-registry/pricing";

// Layered model-id matching (exact → normalized → prefix fallback), shared
// with the CLI so local and cloud cost attribution behave identically.
export {
  costForTokens,
  costForUsage,
  resolveModelKey,
  resolveModelPrice,
} from "@repo/model-registry/pricing";
export type {
  TokenPrice,
  TokenPricingDictionary,
  TokenUsage,
} from "@repo/model-registry/pricing";

type PricingMap = PricingDictionary;

// Bundled pricing — available immediately, no network required.
const bundledModels = {
  ...(modelsFile as any).models,
  ...(overridesFile as any).models,
};

/** Current pricing map. Starts with bundled data, updated by refreshModelPricing(). */
export let modelsCostMapping: PricingMap = buildPricingDictionary(bundledModels);

/**
 * Cache-aware per-token prices over the same models, for callers that bill
 * cache-read and cache-write separately (agent-session ingest). Refreshed in
 * lockstep with {@link modelsCostMapping} — the two must never disagree about
 * which models are priced.
 */
export let modelsTokenPricing: TokenPricingDictionary =
  buildTokenPricingDictionary(bundledModels);

/** The two documents that make up the registry. */
export const MODELS_KEY = "models.json";
export const OVERRIDES_KEY = "overrides.json";

/**
 * Where the runtime price map is read from.
 *
 * Injected rather than hardcoded because the two consumers cannot share one:
 * the gateway reads a Cloudflare KV binding, which does not exist outside a
 * Worker, while the CLI has no runtime source at all and runs on its bundled
 * snapshot. A caller that supplies nothing keeps the bundled data — the
 * behaviour the CLI wants — instead of failing.
 *
 * Do not reach for the registry over a jsdelivr URL: jsdelivr serves PUBLIC
 * GitHub repos and this registry lives in a private one, so every fetch 404s
 * and silently falls back to the bundled snapshot. That failure is invisible —
 * the map simply freezes at deploy time and any model newer than the running
 * deploy prices at 0.
 */
export interface ModelRegistrySource {
  /** Raw JSON text for a registry document, or null when absent. */
  get(key: string): Promise<string | null>;
}

/** Why a refresh did not replace the in-memory map. */
export interface PricingRefreshResult {
  /** True only when fresh data actually replaced the bundled snapshot. */
  refreshed: boolean;
  /** Machine-readable cause when `refreshed` is false. */
  reason?: "no_source" | "absent" | "read_error" | "malformed";
}

/**
 * Replace the in-memory price map from `source`, keeping the bundled snapshot
 * on any failure.
 *
 * Safe to call on every cold start. It RETURNS the outcome rather than
 * swallowing it: the previous implementation silently no-op'd against a 404
 * for long enough that callers documented it as working, and the only symptom
 * was cost quietly computed from a stale map. Callers should log a
 * non-refreshed result.
 */
export async function refreshModelPricing(
  source?: ModelRegistrySource,
): Promise<PricingRefreshResult> {
  if (!source) return { refreshed: false, reason: "no_source" };
  try {
    // Overrides are optional by design (hand-authored, often absent); a failure
    // reading them must not discard a perfectly good models document.
    const [modelsRaw, overridesRaw] = await Promise.all([
      source.get(MODELS_KEY),
      source.get(OVERRIDES_KEY).catch(() => null),
    ]);

    if (modelsRaw == null) return { refreshed: false, reason: "absent" };

    const modelsData = JSON.parse(modelsRaw) as any;
    const overridesData = overridesRaw == null ? null : JSON.parse(overridesRaw) as any;

    // A document that isn't the registry (a truncated write, a placeholder)
    // would otherwise install an EMPTY price map and silently unprice every
    // model — strictly worse than keeping the bundled snapshot.
    if (!modelsData || typeof modelsData.models !== "object" || modelsData.models === null) {
      return { refreshed: false, reason: "malformed" };
    }

    const freshModels: Record<string, any> = {
      ...modelsData.models,
      ...(overridesData?.models ?? {}),
    };

    modelsCostMapping = buildPricingDictionary(freshModels);
    modelsTokenPricing = buildTokenPricingDictionary(freshModels);
    return { refreshed: true };
  } catch {
    // Unreadable or unparseable — keep bundled data.
    return { refreshed: false, reason: "read_error" };
  }
}
