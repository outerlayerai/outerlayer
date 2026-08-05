// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import {
  ModelRegistryImpl,
  candidateModelIds,
  modelsFileSchema,
  overridesFileSchema,
} from "@repo/model-registry";
import modelsJson from "@repo/model-registry/models.json";
import overridesJson from "@repo/model-registry/overrides.json";
import type { Usage } from "@outerlayer/session-schema";

/** Prices in USD per token. */
export interface ModelPrice {
  in: number;
  out: number;
  cacheRead?: number;
  cacheCreate?: number;
}

// Backed by @repo/model-registry's BUNDLED snapshot (litellm +
// openrouter, regenerated upstream) — STATIC JSON imports inlined into the
// dist at build, NO runtime fetch and NO runtime fs read, so scan/watch stay
// fully offline and the published package stands alone. (The registry's
// `getModelRegistry()` reads models.json from disk relative to its package —
// unresolvable once bundled — and `getModelRegistryAsync()` fetches a CDN:
// never call either here.)
export const PRICE_TABLE_SOURCE = "@repo/model-registry (litellm + openrouter snapshot)";

/**
 * Result of a price lookup. `price: null` means the model is unknown — the
 * caller emits an `unknown_model_cost` warning and records `costUsd: null`.
 * Never silently guessed.
 */
export interface PriceResolution {
  price: ModelPrice | null;
  /** The registry key that matched, when resolved via normalization/prefix. */
  matchedId?: string;
  /** How it resolved — for a `--verbose` parse report. */
  via?: "exact" | "normalized" | "prefix";
}

let PRICED: Record<string, ModelPrice> | null = null;
let PRICED_LOWER: Map<string, string> | null = null;

/** Cache-aware price map from the registry's bundled snapshot (built once). */
function pricedModels(): Record<string, ModelPrice> {
  if (!PRICED) {
    const registry = new ModelRegistryImpl(
      modelsFileSchema.parse(modelsJson),
      overridesFileSchema.parse(overridesJson),
    );
    PRICED = {};
    for (const m of registry.getAllModels()) {
      if (!m.pricing) continue;
      PRICED[m.id] = {
        in: m.pricing.inputCostPerToken,
        out: m.pricing.outputCostPerToken,
        ...(m.pricing.cacheReadCostPerToken !== undefined ? { cacheRead: m.pricing.cacheReadCostPerToken } : {}),
        ...(m.pricing.cacheCreationCostPerToken !== undefined ? { cacheCreate: m.pricing.cacheCreationCostPerToken } : {}),
      };
    }
    PRICED_LOWER = new Map(Object.keys(PRICED).map((k) => [k.toLowerCase(), k]));
  }
  return PRICED;
}

/** Longest boundary-prefix match so a variant the normalizer can't strip
 * prices against its base (e.g. `claude-opus-4-8-experimental`). */
function prefixMatch(modelId: string): { id: string; price: ModelPrice } | null {
  const table = pricedModels();
  let best: { id: string; price: ModelPrice } | null = null;
  const lower = modelId.toLowerCase();
  for (const [id, price] of Object.entries(table)) {
    const idLower = id.toLowerCase();
    if (lower.startsWith(idLower)) {
      const boundary = lower[idLower.length];
      if (boundary === undefined || boundary === "-" || boundary === "@" || boundary === ":") {
        if (!best || id.length > best.id.length) best = { id, price };
      }
    }
  }
  return best;
}

const resolveCache = new Map<string, PriceResolution>();

/** Resolve a model id to a price (or null). Memoized per id. The candidate
 * ladder (raw → provider/region stripped → date/version stripped) comes from
 * the registry itself, so new provider prefixes are its problem, not ours. */
export function resolvePrice(modelId: string): PriceResolution {
  if (!modelId) return { price: null };
  const cached = resolveCache.get(modelId);
  if (cached) return cached;

  const table = pricedModels();
  let resolution: PriceResolution = { price: null };

  for (const c of candidateModelIds(modelId)) {
    const hit = table[c] ? c : PRICED_LOWER!.get(c.toLowerCase());
    if (hit && table[hit]) {
      resolution = { price: table[hit], matchedId: hit, via: hit === modelId ? "exact" : "normalized" };
      break;
    }
  }
  if (!resolution.price) {
    const pm = prefixMatch(modelId);
    if (pm) resolution = { price: pm.price, matchedId: pm.id, via: "prefix" };
  }

  resolveCache.set(modelId, resolution);
  return resolution;
}

/**
 * Cache-aware cost of one usage record. Returns null for an unknown model
 * (never guessed). Cache tokens are priced separately — collapsing them would
 * badly misstate Claude Code cost (cache-read routinely dominates).
 */
export function costOfUsage(modelId: string, usage: Usage): number | null {
  const { price } = resolvePrice(modelId);
  if (!price) return null;
  return (
    usage.in * price.in +
    usage.out * price.out +
    usage.cacheRead * (price.cacheRead ?? 0) +
    usage.cacheCreate * (price.cacheCreate ?? 0)
  );
}

/** True when the registry can price this model (after normalization). */
export function isPriceKnown(modelId: string): boolean {
  return resolvePrice(modelId).price !== null;
}
