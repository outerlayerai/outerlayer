// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Difficulty calibration (step 5).
 *
 * A synthetic task carries signal only if a reference config sometimes solves
 * it and sometimes doesn't. We run a reference config over the set — modeled
 * as an injected `resolveRateOf(task) => number` seam — and DISCARD tasks
 * resolved above the ceiling (too easy) or below the floor (too hard); no
 * signal either way. Survivors are additionally flagged for the desirable
 * target band (30–80%).
 */

import type { EvalTask } from "@outerlayer/task-format";
import type { BuiltSyntheticTask } from "./task.js";

export interface BandThresholds {
  /** Discard tasks resolved BELOW this (too hard, no signal). Default 0.05. */
  discardBelow?: number;
  /** Discard tasks resolved ABOVE this (too easy, no signal). Default 0.95. */
  discardAbove?: number;
  /** Lower edge of the desirable band. Default 0.30. */
  targetMin?: number;
  /** Upper edge of the desirable band. Default 0.80. */
  targetMax?: number;
}

export const DEFAULT_BAND: Required<BandThresholds> = {
  discardBelow: 0.05,
  discardAbove: 0.95,
  targetMin: 0.3,
  targetMax: 0.8,
};

export interface CalibratedTask extends BuiltSyntheticTask {
  resolveRate: number;
  inTargetBand: boolean;
}

export interface DiscardedTask extends BuiltSyntheticTask {
  resolveRate: number;
  reason: "below_floor" | "above_ceiling";
}

export interface CalibrationResult {
  kept: CalibratedTask[];
  discarded: DiscardedTask[];
}

export interface CalibrationOptions extends BandThresholds {
  resolveRateOf: (task: EvalTask) => Promise<number> | number;
}

export async function calibrateDifficulty(
  items: BuiltSyntheticTask[],
  options: CalibrationOptions,
): Promise<CalibrationResult> {
  const band: Required<BandThresholds> = {
    discardBelow: options.discardBelow ?? DEFAULT_BAND.discardBelow,
    discardAbove: options.discardAbove ?? DEFAULT_BAND.discardAbove,
    targetMin: options.targetMin ?? DEFAULT_BAND.targetMin,
    targetMax: options.targetMax ?? DEFAULT_BAND.targetMax,
  };

  const kept: CalibratedTask[] = [];
  const discarded: DiscardedTask[] = [];

  for (const item of items) {
    const resolveRate = await options.resolveRateOf(item.task);
    if (resolveRate < band.discardBelow) {
      discarded.push({ ...item, resolveRate, reason: "below_floor" });
      continue;
    }
    if (resolveRate > band.discardAbove) {
      discarded.push({ ...item, resolveRate, reason: "above_ceiling" });
      continue;
    }
    const inTargetBand = resolveRate >= band.targetMin && resolveRate <= band.targetMax;
    kept.push({
      task: item.task,
      meta: { ...item.meta, resolveRate, inTargetBand },
      resolveRate,
      inTargetBand,
    });
  }

  return { kept, discarded };
}
