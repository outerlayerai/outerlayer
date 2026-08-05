// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { reportStats } from "../report.js";
import { simulateWorld } from "../simulate.js";
import type { ReportStats } from "../types.js";

/**
 * The committed golden. Same fixture + same seed => this exact object, forever.
 * Regenerate deliberately (never "just to make the test pass") if the contract
 * or a formula changes; a diff here is a diff in a public claim surface.
 */
const GOLDEN: ReportStats = {
  configs: ["config-a", "config-b"],
  nTasks: 14,
  trialsPerTask: 3,
  resolveRate: {
    a: { value: 0.6428571429, ci95: [0.3876442309, 0.8365526826], n: 14, successes: 9 },
    b: { value: 0.9285714286, ci95: [0.6853129555, 0.9872777848], n: 14, successes: 13 },
  },
  pairedDelta: {
    est: -0.2857142857,
    ci95: [-0.5, -0.0714285714],
    mcnemar: { b: 0, c: 4, p: 0.125 },
  },
  dollarsPerResolved: {
    a: { perResolved: 0.1003283874, totalCostUsd: 0.9029554866, resolves: 9 },
    b: { perResolved: 0.067370824, totalCostUsd: 0.8758207115, resolves: 13 },
    ci95Ratio: [1.025551453, 2.4745758616],
  },
  efficiency: {
    turns: {
      meanA: 5.0238095238,
      meanB: 4.9523809524,
      meanDelta: 0.0714285714,
      ci95: [-0.9767857143, 1.2386904762],
    },
    wallClock: {
      meanA: 1627.9047619048,
      meanB: 1582.6428571429,
      meanDelta: 45.2619047619,
      ci95: [-123.2446428571, 210.7869047619],
    },
    tokens: {
      meanA: 846.7619047619,
      meanB: 782.0952380952,
      meanDelta: 64.6666666667,
      ci95: [-8.4535714286, 136.8636904762],
    },
  },
  passAtK: [
    { k: 1, a: 0.6666666667, b: 0.8571428571 },
    { k: 2, a: 0.880952381, b: 0.9761904762 },
    { k: 3, a: 1, b: 1 },
  ],
  passHatK: [
    { k: 1, a: 0.6666666667, b: 0.8571428571 },
    { k: 2, a: 0.4523809524, b: 0.7380952381 },
    { k: 3, a: 0.3571428571, b: 0.6428571429 },
  ],
  mde: {
    at80Power: 0.4002264598,
    note: "Detectable Δ ≈ 40.0 pp at 80% power (n=14 paired tasks, discordance=0.29; observed discordance).",
  },
  verdict: "underpowered",
  verdictRules:
    "underpowered: 95% CI [-50.0, -7.1] pp excludes 0 but |Δ|=28.6 pp < 0.8·MDE=32.0 pp; interval too wide to trust at this N. ~28 paired tasks would clear the bar (have 14).",
  exclusions: [],
  sensitivity: {
    excludedFlippedConclusion: false,
    perTrialDelta: { est: -0.1904761905, ci95: [-0.3095238095, -0.0714285714] },
  },
};

function goldenWorld() {
  return simulateWorld({
    nTasks: 14,
    trialsPerTask: 3,
    deltaPp: 15,
    seed: 42,
    baseLo: 0.5,
    baseHi: 0.82,
  });
}

describe("golden — same input + seed => byte-identical output", () => {
  test("reproduces the committed object exactly", () => {
    const world = goldenWorld();
    const rs = reportStats(world.trials, {
      configA: world.configA,
      configB: world.configB,
      seed: 7,
      resamples: 3000,
    });
    expect(rs).toEqual(GOLDEN);
  });

  test("is deterministic across repeated runs", () => {
    const world = goldenWorld();
    const opts = { configA: world.configA, configB: world.configB, seed: 7, resamples: 3000 };
    const a = reportStats(world.trials, opts);
    const b = reportStats(world.trials, opts);
    expect(a).toEqual(b);
  });

  test("a different seed moves the bootstrap CIs (the seed reaches the resampler)", () => {
    const world = goldenWorld();
    const base = { configA: world.configA, configB: world.configB, resamples: 3000 };
    const s7 = reportStats(world.trials, { ...base, seed: 7 });
    const s8 = reportStats(world.trials, { ...base, seed: 8 });
    // Point estimates are seed-independent; bootstrap CIs are not.
    expect(s8.pairedDelta.est).toBe(s7.pairedDelta.est);
    expect(s8.pairedDelta.ci95).not.toEqual(s7.pairedDelta.ci95);
  });
});

describe("property — permutation invariance (swap config order)", () => {
  test("flips the sign of the delta but preserves verdict and magnitude", () => {
    const world = goldenWorld();
    const ab = reportStats(world.trials, {
      configA: "config-a",
      configB: "config-b",
      seed: 7,
      resamples: 3000,
    });
    const ba = reportStats(world.trials, {
      configA: "config-b",
      configB: "config-a",
      seed: 7,
      resamples: 3000,
    });

    // Same seed => same resample indices => exact negation of every delta.
    expect(ba.pairedDelta.est).toBe(-ab.pairedDelta.est);
    expect(ba.pairedDelta.ci95[0]).toBeCloseTo(-ab.pairedDelta.ci95[1], 12);
    expect(ba.pairedDelta.ci95[1]).toBeCloseTo(-ab.pairedDelta.ci95[0], 12);

    // Verdict and magnitude are order-invariant.
    expect(ba.verdict).toBe(ab.verdict);
    expect(Math.abs(ba.pairedDelta.est)).toBe(Math.abs(ab.pairedDelta.est));
    expect(ba.mde).toEqual(ab.mde);

    // McNemar discordance swaps direction; the p-value is unchanged.
    expect(ba.pairedDelta.mcnemar.b).toBe(ab.pairedDelta.mcnemar.c);
    expect(ba.pairedDelta.mcnemar.c).toBe(ab.pairedDelta.mcnemar.b);
    expect(ba.pairedDelta.mcnemar.p).toBe(ab.pairedDelta.mcnemar.p);

    // Per-config readouts swap sides.
    expect(ba.resolveRate.a).toEqual(ab.resolveRate.b);
    expect(ba.resolveRate.b).toEqual(ab.resolveRate.a);
    expect(ba.dollarsPerResolved.a).toEqual(ab.dollarsPerResolved.b);
    for (let i = 0; i < ab.passAtK.length; i += 1) {
      expect(ba.passAtK[i].a).toBe(ab.passAtK[i].b);
      expect(ba.passAtK[i].b).toBe(ab.passAtK[i].a);
    }
  });
});
