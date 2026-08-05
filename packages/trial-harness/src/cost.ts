// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Cost from trajectory usage × vendored prices. When usage
 * is unavailable (a launcher/transcript that didn't report tokens), cost is
 * 'estimated' at 0 rather than fabricated — the result says which.
 */

import type { TrajectorySummary, TrialCost } from "./types.js";

/** USD per 1M tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}

export type PriceTable = Record<string, ModelPrice>;

export function computeCost(
  model: string,
  trajectory: TrajectorySummary | null,
  prices: PriceTable,
): TrialCost {
  const price = prices[model];
  if (!trajectory || !price || trajectory.inputTokens === null || trajectory.outputTokens === null) {
    return { usd: 0, source: "estimated" };
  }
  const cacheRead = trajectory.cacheReadTokens ?? 0;
  const usd =
    (trajectory.inputTokens / 1_000_000) * price.inputPerMTok +
    (trajectory.outputTokens / 1_000_000) * price.outputPerMTok +
    (cacheRead / 1_000_000) * (price.cacheReadPerMTok ?? 0);
  return { usd, source: "measured" };
}
