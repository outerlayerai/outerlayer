/**
 * Pricing OpenAPI Route
 *
 * Public, no-auth endpoint returning LLM model pricing data. Shape is a
 * dynamic map keyed by model ID (e.g. "gpt-5" → { promptPrice, completionPrice }).
 * Registered under UNAUTHENTICATED_V1_PATHS (skips auth middleware) and
 * RAW_SHAPE_V1_PATHS (exempt from the response-envelope smoke test) — the
 * raw map shape is the contract SDK consumers depend on.
 *
 * Pricing source: @repo/llm-costs bundles the model registry at build time
 * and refreshes from CDN on cold start (non-blocking). Failures silently
 * fall back to bundled data, so this handler has no meaningful error path.
 */

import { z, BaseRoute, type AppContext } from './_shared';
import { createPricingService, kvRegistrySource } from '../../services';
import { initCache } from '../../utils';
import { memory } from '../../cache-store';

/** Cache-Control header for pricing endpoint (1 day TTL — matches legacy contract). */
const PRICING_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400';

/**
 * Response schema. Uses z.record() because top-level keys are model IDs,
 * not a fixed set. Prices are per 1K tokens (see packages/llm-costs/
 * cost-mapping.ts buildPricingMap).
 */
const PricingEntrySchema = z.object({
  promptPrice: z.number(),
  completionPrice: z.number(),
});

const PricingResponseSchema = z.record(z.string(), PricingEntrySchema);

// ---------------------------------------------------------------------------
// GET /v1/pricing
// ---------------------------------------------------------------------------

export class GetPricing extends BaseRoute {
  schema = {
    tags: ['Pricing'],
    summary: 'Get LLM pricing',
    operationId: 'get-pricing',
    description: 'Returns per-model pricing for cost calculation. Response is a dynamic map keyed by model ID (e.g. `gpt-5`, `claude-opus-4-6`). Prices are per 1,000 tokens.\n\nPublic endpoint — no authentication required. Response is cached for 24 hours (`Cache-Control: public, max-age=86400`).',
    security: [],
    responses: {
      200: {
        description: 'LLM pricing map (model-id → `{ promptPrice, completionPrice }`).',
        content: {
          'application/json': {
            schema: PricingResponseSchema,
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const cache = initCache(c.get('gtx').cacheL2Store, c.get('gtx').execCtx, memory);
    // Bound in the Worker; absent on self-host/local, where pricing falls back
    // to the snapshot bundled at build time.
    const registry = c.env.MODEL_REGISTRY;
    const pricingService = createPricingService(
      cache,
      registry ? kvRegistrySource(registry) : undefined,
    );
    const pricingData = await pricingService.getPricingData();

    return c.json(pricingData, 200, { 'Cache-Control': PRICING_CACHE_CONTROL });
  }
}
