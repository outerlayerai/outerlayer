// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * SLOs computed from runner telemetry. "Fully self-serve and not
 * flaky" is PROVEN from a canary fleet, not asserted — these are the objective
 * launch-gate values. All computed from typed trial statuses + timings the
 * runner and trial harness already emit.
 */

import type { TrialStatus } from "@outerlayer/trial-harness";

/** One trial's telemetry (subset of TrialResult the SLOs need). */
export interface TrialTelemetry {
  status: TrialStatus;
  /** Non-graded trials MUST carry a typed reason (zero-silent-failure SLO). */
  hasTypedReason: boolean;
}

/** One qualify→card run's outcome for the unattended-completion SLO. */
export interface RunTelemetry {
  qualifyPassed: boolean;
  producedCard: boolean;
  humanTouches: number;
  qualifyMs: number;
  cardWallClockMs: number;
  estimatedCostUsd: number;
  measuredCostUsd: number;
}

export interface SloValues {
  /** typed infra_error / all trials, target < 0.03. */
  infraErrorRate: number;
  /** qualify-passed repos producing a card with zero human touches, target ≥ 0.90. */
  unattendedCompletion: number;
  /** every non-graded trial has a typed reason — count of silent failures, target 0. */
  silentFailures: number;
  qualifyP50Ms: number;
  qualifyP95Ms: number;
  cardP95Ms: number;
  /** runs within ±40% of the cost estimate, target ≥ 0.80. */
  costPredictability: number;
  trials: number;
  runs: number;
}

export const SLO_GATES = {
  infraErrorRateMax: 0.03,
  unattendedCompletionMin: 0.9,
  silentFailuresMax: 0,
  qualifyP50MsMax: 15 * 60_000,
  qualifyP95MsMax: 40 * 60_000,
  costPredictabilityMin: 0.8,
} as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export function computeSlos(trials: TrialTelemetry[], runs: RunTelemetry[]): SloValues {
  const infra = trials.filter((t) => t.status === "infra_error").length;
  const silentFailures = trials.filter((t) => t.status !== "graded" && !t.hasTypedReason).length;

  const qualifyPassed = runs.filter((r) => r.qualifyPassed);
  const unattended = qualifyPassed.filter((r) => r.producedCard && r.humanTouches === 0).length;

  const qualifyTimes = runs.map((r) => r.qualifyMs).sort((a, b) => a - b);
  const cardTimes = runs.filter((r) => r.producedCard).map((r) => r.cardWallClockMs).sort((a, b) => a - b);

  const withinEstimate = runs.filter(
    (r) => r.estimatedCostUsd > 0 && Math.abs(r.measuredCostUsd - r.estimatedCostUsd) / r.estimatedCostUsd <= 0.4,
  ).length;

  return {
    infraErrorRate: trials.length > 0 ? infra / trials.length : 0,
    unattendedCompletion: qualifyPassed.length > 0 ? unattended / qualifyPassed.length : 0,
    silentFailures,
    qualifyP50Ms: percentile(qualifyTimes, 0.5),
    qualifyP95Ms: percentile(qualifyTimes, 0.95),
    cardP95Ms: percentile(cardTimes, 0.95),
    costPredictability: runs.length > 0 ? withinEstimate / runs.length : 0,
    trials: trials.length,
    runs: runs.length,
  };
}

export interface SloCheck {
  name: string;
  value: number;
  gate: number;
  comparator: "<=" | ">=";
  pass: boolean;
}

export function checkSlos(slos: SloValues): SloCheck[] {
  const mk = (name: string, value: number, gate: number, comparator: "<=" | ">="): SloCheck => ({
    name,
    value,
    gate,
    comparator,
    pass: comparator === "<=" ? value <= gate : value >= gate,
  });
  return [
    mk("infra_error_rate", slos.infraErrorRate, SLO_GATES.infraErrorRateMax, "<="),
    mk("unattended_completion", slos.unattendedCompletion, SLO_GATES.unattendedCompletionMin, ">="),
    mk("silent_failures", slos.silentFailures, SLO_GATES.silentFailuresMax, "<="),
    mk("qualify_p50_ms", slos.qualifyP50Ms, SLO_GATES.qualifyP50MsMax, "<="),
    mk("qualify_p95_ms", slos.qualifyP95Ms, SLO_GATES.qualifyP95MsMax, "<="),
    mk("cost_predictability", slos.costPredictability, SLO_GATES.costPredictabilityMin, ">="),
  ];
}
