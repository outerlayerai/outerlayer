// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The simulation validation suite — the spec's real acceptance. We generate
 * synthetic worlds with KNOWN true deltas and check the machine's honesty:
 *   (a) the paired-bootstrap 95% CI covers the true parameter ~95% of the time,
 *   (b) verdicts match design intent (small effect at small N is rarely
 *       `clear`; large effect at large N is mostly `clear`),
 *   (c) the MDE shrinks with more tasks (N) and more trials (k).
 *
 * Everything is seeded, so these numbers are exactly reproducible; the bands
 * assert the statistical PROPERTY, not a brittle point value. Sim/resample
 * counts are kept modest so the whole file runs in a few seconds — the
 * production default stays >= 10k (asserted in unit.test.ts).
 */

import { describe, expect, test } from "vitest";
import { mde } from "../mde.js";
import { reportStats } from "../report.js";
import { simulateWorld } from "../simulate.js";
import type { Verdict } from "../types.js";

const DELTAS = [0, 5, 10, 20];
const NS = [30, 80, 200];

describe("(a) bootstrap CI coverage ≈ 95%", () => {
  test("the paired 95% CI covers the true majority delta across sims", () => {
    const SIMS = 120;
    const RESAMPLES = 600;
    let coveredTotal = 0;
    let nTotal = 0;
    let minCell = 1;
    let maxCell = 0;

    for (const dp of DELTAS) {
      for (const N of NS) {
        let covered = 0;
        for (let s = 0; s < SIMS; s += 1) {
          const world = simulateWorld({
            nTasks: N,
            trialsPerTask: 1,
            deltaPp: dp,
            seed: 9001 + s * 13 + dp * 101 + N * 7,
          });
          const rs = reportStats(world.trials, {
            configA: world.configA,
            configB: world.configB,
            seed: 202 + s,
            resamples: RESAMPLES,
          });
          const [lo, hi] = rs.pairedDelta.ci95;
          if (world.trueMajorityDelta >= lo && world.trueMajorityDelta <= hi) covered += 1;
        }
        const cell = covered / SIMS;
        minCell = Math.min(minCell, cell);
        maxCell = Math.max(maxCell, cell);
        coveredTotal += covered;
        nTotal += SIMS;
        // Per-cell sanity band (never-flaky): a broken CI would blow past this.
        expect(cell).toBeGreaterThanOrEqual(0.9);
        expect(cell).toBeLessThanOrEqual(0.99);
      }
    }

    // The headline calibration claim: pooled coverage is ~95% (±2pp).
    const pooled = coveredTotal / nTotal;
    expect(pooled).toBeGreaterThanOrEqual(0.93);
    expect(pooled).toBeLessThanOrEqual(0.97);
  });
});

function verdictHistogram(
  deltaPp: number,
  N: number,
  k: number,
  sims: number,
): Record<Verdict, number> {
  const hist: Record<Verdict, number> = { clear: 0, directional: 0, underpowered: 0 };
  for (let s = 0; s < sims; s += 1) {
    const world = simulateWorld({ nTasks: N, trialsPerTask: k, deltaPp, seed: 4400 + s * 5 });
    const rs = reportStats(world.trials, {
      configA: world.configA,
      configB: world.configB,
      seed: 9 + s,
      resamples: 600,
    });
    hist[rs.verdict] += 1;
  }
  return hist;
}

describe("(b) verdicts match design intent", () => {
  test("true 10pp at N=30 (k=1) is RARELY clear (mostly underpowered/directional)", () => {
    const sims = 160;
    const h = verdictHistogram(10, 30, 1, sims);
    expect(h.clear / sims).toBeLessThan(0.15);
    expect((h.underpowered + h.directional) / sims).toBeGreaterThan(0.85);
  });

  test("true 20pp at N=200 is MOSTLY clear (k=1 and k=3)", () => {
    const h1 = verdictHistogram(20, 200, 1, 120);
    expect(h1.clear / 120).toBeGreaterThan(0.6);
    const h3 = verdictHistogram(20, 200, 3, 80);
    expect(h3.clear / 80).toBeGreaterThan(0.6);
  });

  test("true 0pp is essentially never clear (no false winners)", () => {
    const sims = 120;
    const h = verdictHistogram(0, 80, 1, sims);
    expect(h.clear / sims).toBeLessThan(0.1);
  });
});

describe("(c) MDE monotonicity", () => {
  // Mean observed MDE over a noise-dominated world (resolvability away from
  // 0.5), where extra trials denoise the per-task label and lower discordance.
  function meanObservedMde(N: number, k: number, sims: number): number {
    let sum = 0;
    for (let i = 0; i < sims; i += 1) {
      const world = simulateWorld({
        nTasks: N,
        trialsPerTask: k,
        deltaPp: 5,
        seed: 7000 + i,
        baseLo: 0.55,
        baseHi: 0.9,
      });
      const rs = reportStats(world.trials, {
        configA: world.configA,
        configB: world.configB,
        seed: 3,
        resamples: 400,
      });
      sum += rs.mde.at80Power;
    }
    return sum / sims;
  }

  test("decreasing in N — closed form (fixed discordance)", () => {
    const values = NS.map((n) => mde({ nPairs: n, discordanceRate: 0.25 }));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
  });

  test("decreasing in N — end to end (mean observed MDE over sims)", () => {
    const m30 = meanObservedMde(30, 1, 60);
    const m80 = meanObservedMde(80, 1, 60);
    const m200 = meanObservedMde(200, 1, 60);
    expect(m80).toBeLessThan(m30);
    expect(m200).toBeLessThan(m80);
  });

  test("decreasing in k — end to end (more trials denoise the label)", () => {
    const k1 = meanObservedMde(80, 1, 100);
    const k3 = meanObservedMde(80, 3, 100);
    expect(k3).toBeLessThan(k1 * 0.97); // a real gap, not a razor's edge
  });
});

describe("exclusion sensitivity is always computed", () => {
  test("asymmetric-missing tasks are excluded and the flip check runs", () => {
    const world = simulateWorld({ nTasks: 40, trialsPerTask: 3, deltaPp: 10, seed: 5 });
    // Drop ALL config-b trials on two tasks -> asymmetric missing.
    const trials = world.trials.filter(
      (t) => !((t.taskId === "task-3" || t.taskId === "task-17") && t.config === world.configB),
    );
    const rs = reportStats(trials, {
      configA: world.configA,
      configB: world.configB,
      seed: 11,
      resamples: 800,
    });
    expect(rs.exclusions.map((e) => e.taskId).sort()).toEqual(["task-17", "task-3"]);
    expect(rs.nTasks).toBe(38);
    // Always a concrete boolean, computed from the inclusive re-run.
    expect(typeof rs.sensitivity.excludedFlippedConclusion).toBe("boolean");
    expect(rs.sensitivity.excludedFlippedConclusion).toBe(false);
  });
});
