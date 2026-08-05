// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { DetectionSession, DetectorConfig, Finding, ResolvedConfig, Detector } from "./types.js";
import { cacheReadRatio, median, percentile } from "./helpers.js";

const SEVERITY_RANK: Record<string, number> = { high: 3, warn: 2, info: 1 };

/** Compute team baselines from the batch (cost-outlier keys off costP95;
 * cacheReadRatioMedian stays available to config/cloud consumers). */
export function computeBaselines(sessions: DetectionSession[]): { costP95: number; cacheReadRatioMedian: number } {
  const costs = sessions.map((s) => s.costUsd ?? 0).filter((c) => c > 0);
  const ratios = sessions.map(cacheReadRatio).filter((r): r is number => r !== null);
  return {
    costP95: costs.length ? percentile(costs, 0.95) : 0,
    cacheReadRatioMedian: ratios.length ? median(ratios) : 0,
  };
}

export function resolveConfig(sessions: DetectionSession[], config: DetectorConfig = {}): ResolvedConfig {
  const computed = computeBaselines(sessions);
  return {
    thresholds: config.thresholds ?? {},
    dollarsPerHour: config.dollarsPerHour ?? 0,
    baselines: {
      costP95: config.baselines?.costP95 ?? computed.costP95,
      cacheReadRatioMedian: config.baselines?.cacheReadRatioMedian ?? computed.cacheReadRatioMedian,
    },
  };
}

/**
 * Run detectors over a batch of sessions and return findings ranked by dollars
 * wasted (desc), ties broken by severity then evidence breadth. A detector
 * that throws is isolated — its failure is logged to `onError` and skipped,
 * never taking down the whole run (a broken detector must not blank the report).
 */
export function runDetectors(
  detectors: Detector[],
  sessions: DetectionSession[],
  config: DetectorConfig = {},
  onError?: (detectorId: string, err: unknown) => void,
): Finding[] {
  const resolved = resolveConfig(sessions, config);
  const findings: Finding[] = [];
  for (const detector of detectors) {
    try {
      findings.push(...detector.run(sessions, resolved));
    } catch (err) {
      onError?.(detector.id, err);
    }
  }
  return rankFindings(findings);
}

/** Rank: dollars desc (nulls last), then severity, then #sessions. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const ca = a.costUsd ?? -1;
    const cb = b.costUsd ?? -1;
    if (cb !== ca) return cb - ca;
    const sev = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sev !== 0) return sev;
    return b.sessionIds.length - a.sessionIds.length;
  });
}
