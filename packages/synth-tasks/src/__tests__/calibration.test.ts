// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { calibrateDifficulty } from "../calibration.js";
import { buildSyntheticTask, type BuiltSyntheticTask } from "../task.js";
import { CLAMP_INJECTION, PAGINATION_INJECTION, PAGINATION_INJECTION_ALT, PYTEST_ENV } from "./helpers.js";

function built(injection: typeof PAGINATION_INJECTION, baseCommit: string): BuiltSyntheticTask {
  return buildSyntheticTask(injection, {
    repo: "https://example.invalid/app.git",
    baseCommit,
    environment: PYTEST_ENV,
    passToPass: [],
    problemStatement:
      "A recent change introduced a regression; restore the previously correct behavior.",
    generatorVersion: "synth-0.1.0",
  });
}

describe("calibrateDifficulty band filtering", () => {
  test("resolve rates {0.02, 0.5, 0.98} ⇒ only 0.5 survives", async () => {
    const tooHard = built(PAGINATION_INJECTION, "ref-hard");
    const signal = built(PAGINATION_INJECTION_ALT, "ref-signal");
    const tooEasy = built(CLAMP_INJECTION, "ref-easy");
    const rate: Record<string, number> = {
      [tooHard.task.id]: 0.02,
      [signal.task.id]: 0.5,
      [tooEasy.task.id]: 0.98,
    };

    const result = await calibrateDifficulty([tooHard, signal, tooEasy], {
      resolveRateOf: (task) => rate[task.id]!,
    });

    expect(result.kept.map((entry) => entry.task.id)).toEqual([signal.task.id]);
    expect(result.kept[0]!.resolveRate).toBe(0.5);
    expect(result.kept[0]!.inTargetBand).toBe(true);
    expect(result.kept[0]!.meta.resolveRate).toBe(0.5);
    expect(result.kept[0]!.meta.inTargetBand).toBe(true);

    expect(result.discarded).toEqual([
      { ...tooHard, resolveRate: 0.02, reason: "below_floor" },
      { ...tooEasy, resolveRate: 0.98, reason: "above_ceiling" },
    ]);
  });

  test("in-band-but-not-target survives, flagged inTargetBand=false", async () => {
    const task = built(PAGINATION_INJECTION, "ref-x");
    const result = await calibrateDifficulty([task], { resolveRateOf: () => 0.9 });
    expect(result.discarded).toEqual([]);
    expect(result.kept[0]!.resolveRate).toBe(0.9);
    expect(result.kept[0]!.inTargetBand).toBe(false); // 0.9 > targetMax 0.8, still < 0.95 ceiling
  });
});
