// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Finding } from "../types.js";
import { round } from "../helpers.js";
import { rankFindings } from "../runner.js";
import type { DeltaStat, DigestFinding, DigestModel, WeeklyRollup } from "./types.js";

/** Deltas the digest may lead with, in tie-break priority order. */
const WATCH_RANK: Record<"cost" | "errorRate" | "newFinding", number> = {
  cost: 3,
  errorRate: 2,
  newFinding: 1,
};

/** A week-over-week rise above this % is worth calling out. */
const ADVERSE_PCT = 25;

/** Fewer sessions than this and a digest is noise — skip the send entirely. */
const MIN_SESSIONS = 3;

/** How many findings the digest surfaces (the report has the rest). */
const TOP_FINDINGS = 3;

function deltaStat(current: number, prior: number | null): DeltaStat {
  // No prior week → baseline week; prior of 0 → a % change would be a lie.
  if (prior === null || prior === 0) return { current, prior, deltaPct: null };
  return { current, prior, deltaPct: round(((current - prior) / prior) * 100) };
}

/** Tool error rate as a fraction 0..1 (0 when the week made no tool calls). */
function errorRate(week: WeeklyRollup): number {
  return week.toolCalls > 0 ? week.toolErrors / week.toolCalls : 0;
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;
const fmtRatePct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/**
 * Pick the one sentence the digest opens with: the largest adverse delta
 * (spend up >25%, error rate up >25%), or the top finding when it's new this
 * week. Ties break cost > errorRate > newFinding so two equal spikes always
 * read the same. Null on a baseline week (no prior → no comparative claim)
 * or when nothing moved adversely.
 */
function pickWatchThis(
  tiles: DigestModel["tiles"],
  topFindings: DigestFinding[],
  prior: WeeklyRollup | null,
  priorFindings: Finding[],
): string | null {
  if (prior === null) return null;
  const candidates: { kind: keyof typeof WATCH_RANK; magnitude: number; sentence: string }[] = [];
  const cost = tiles.costUsd;
  if (cost.deltaPct !== null && cost.deltaPct > ADVERSE_PCT && cost.prior !== null) {
    candidates.push({
      kind: "cost",
      magnitude: cost.deltaPct,
      sentence: `Spend is up ${cost.deltaPct}% week over week (${fmtUsd(cost.prior)} → ${fmtUsd(cost.current)}) — worth a look before it compounds.`,
    });
  }
  const rate = tiles.toolErrorRate;
  if (rate.deltaPct !== null && rate.deltaPct > ADVERSE_PCT && rate.prior !== null) {
    candidates.push({
      kind: "errorRate",
      magnitude: rate.deltaPct,
      sentence: `Tool error rate is up ${rate.deltaPct}% week over week (${fmtRatePct(rate.prior)} → ${fmtRatePct(rate.current)}) — one recurring failure usually explains most of it.`,
    });
  }
  const top = topFindings[0];
  if (top && !priorFindings.some((p) => p.detectorId === top.detectorId)) {
    // A brand-new top finding has no delta magnitude — it only leads when
    // nothing crossed the adverse threshold.
    candidates.push({ kind: "newFinding", magnitude: -Infinity, sentence: `New this week: ${top.summary}.` });
  }
  candidates.sort((a, b) => b.magnitude - a.magnitude || WATCH_RANK[b.kind] - WATCH_RANK[a.kind]);
  return candidates[0]?.sentence ?? null;
}

/**
 * Compose the weekly digest model from pre-aggregated rollups + findings.
 * Pure and clock-free: the caller decides what "this week" means. Leads with
 * deltas and dollars, not totals — the first week is a "baseline week" (all
 * deltas null), and a quiet week (< 3 sessions) returns null so nobody gets
 * an email about nothing.
 */
export function composeDigest(input: {
  tenantName: string;
  deepLinkBase: string;
  current: WeeklyRollup;
  prior: WeeklyRollup | null;
  findings: Finding[];
  priorFindings: Finding[];
}): DigestModel | null {
  const { tenantName, deepLinkBase, current, prior, findings, priorFindings } = input;
  if (current.sessions < MIN_SESSIONS) return null;

  const tiles = {
    sessions: deltaStat(current.sessions, prior ? prior.sessions : null),
    costUsd: deltaStat(current.costUsd, prior ? prior.costUsd : null),
    toolErrorRate: deltaStat(errorRate(current), prior ? errorRate(prior) : null),
    activeActors: deltaStat(current.activeActors, prior ? prior.activeActors : null),
  };

  // Same ranking as the report (dollars desc, nulls last) so the digest's
  // top 3 is always the report's top 3. Prior side ranked too, so a WoW
  // match compares against the prior week's top finding for that detector.
  const rankedPrior = rankFindings(priorFindings);
  const topFindings = rankFindings(findings)
    .slice(0, TOP_FINDINGS)
    .map((f): DigestFinding => {
      const match = rankedPrior.find((p) => p.detectorId === f.detectorId);
      const wowDelta =
        match && match.costUsd !== null && f.costUsd !== null ? round(f.costUsd - match.costUsd) : null;
      return {
        detectorId: f.detectorId,
        severity: f.severity,
        summary: f.summary,
        costUsd: f.costUsd,
        sessionCount: f.sessionIds.length,
        wowDelta,
      };
    });

  return {
    tenantName,
    periodStart: current.periodStart,
    periodEnd: current.periodEnd,
    tiles,
    topFindings,
    watchThis: pickWatchThis(tiles, topFindings, prior, priorFindings),
    deepLinkBase,
  };
}
