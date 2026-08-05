// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * One digest tile stat. The digest leads with deltas, not totals — `deltaPct`
 * is the week-over-week % change, null when there is no prior week (baseline
 * week) or the prior value is 0 (a % change from zero isn't honest).
 * For rate tiles (tool error rate) `current`/`prior` are fractions 0..1;
 * for count/$ tiles they are raw counts/dollars.
 */
export interface DeltaStat {
  current: number;
  prior: number | null;
  deltaPct: number | null;
}

/**
 * Pre-aggregated numbers for one week — the caller (cloud rollup query or
 * local scan) does the counting; the digest only compares and narrates.
 * Dates are ISO strings so composition stays pure (no clocks, no timezones).
 */
export interface WeeklyRollup {
  periodStart: string;
  periodEnd: string;
  sessions: number;
  costUsd: number;
  toolCalls: number;
  toolErrors: number;
  activeActors: number;
}

/**
 * A finding as it appears in the digest: the one-sentence summary plus the
 * numbers a reader ranks by. `wowDelta` is the $ change vs the prior week's
 * top finding from the same detector — null when the detector is new this
 * week or either side has no honest dollar figure.
 */
export interface DigestFinding {
  detectorId: string;
  severity: string;
  summary: string;
  costUsd: number | null;
  sessionCount: number;
  wowDelta: number | null;
}

/**
 * The composed weekly digest — a render-ready model shared by the email and
 * Slack renderers so both channels always tell the same story. Strings are
 * stored raw; each renderer escapes for its own markup.
 */
export interface DigestModel {
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  tiles: {
    sessions: DeltaStat;
    costUsd: DeltaStat;
    toolErrorRate: DeltaStat;
    activeActors: DeltaStat;
  };
  /** Top 3 findings by $ (nulls last), matching the runner's ranking. */
  topFindings: DigestFinding[];
  /** One sentence naming the week's largest adverse delta, or null. */
  watchThis: string | null;
  /** Dashboard URL prefix every tile and finding links into. */
  deepLinkBase: string;
}
