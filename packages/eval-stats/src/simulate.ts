// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Synthetic world generator for the simulation validation suite (and for demos
 * / docs). Everything here is seeded and deterministic — the same params and
 * seed produce the same trials AND the same exactly-computed true parameters,
 * which is what lets the tests check bootstrap CI coverage against ground truth.
 */

import { comb } from "./math.js";
import { mulberry32, type Rng } from "./rng.js";
import type { TrialResultLike } from "./types.js";

export interface WorldParams {
  /** Number of tasks (the paired unit). */
  nTasks: number;
  /** Graded trials per config per task. */
  trialsPerTask: number;
  /** True trial-level effect in percentage points: B's per-task resolve prob = A's + deltaPp/100. */
  deltaPp: number;
  /** RNG seed. */
  seed: number;
  /** Latent per-task base resolve probability for A ~ Uniform(baseLo, baseHi). */
  baseLo?: number;
  baseHi?: number;
  /** Config ids to stamp on trials. */
  configA?: string;
  configB?: string;
}

export interface World {
  trials: TrialResultLike[];
  configA: string;
  configB: string;
  /**
   * Exact expected value of the estimator `reportStats` targets: the mean
   * over tasks of (P(majority-A resolves) − P(majority-B resolves)) at this
   * trial count. This is the parameter a 95% CI should cover ~95% of the time.
   */
  trueMajorityDelta: number;
  /** Exact mean trial-level delta (A − B); equals `trueMajorityDelta` when trialsPerTask = 1. */
  trueTrialDelta: number;
}

/** P(strict majority of `k` Bernoulli(p) trials resolves), i.e. P(X > k/2). */
export function majorityResolveProb(p: number, k: number): number {
  let sum = 0;
  const threshold = k / 2;
  for (let j = 0; j <= k; j += 1) {
    if (j > threshold) sum += comb(k, j) * p ** j * (1 - p) ** (k - j);
  }
  return sum;
}

function drawTrial(
  rng: Rng,
  taskId: string,
  config: string,
  p: number,
): TrialResultLike {
  const resolved = rng() < p;
  // Deterministic, plausible-but-simple effort draws. Cost/effort intentionally
  // correlate weakly with un-resolution so the efficiency deltas are non-trivial.
  const base = resolved ? 1 : 1.35;
  return {
    taskId,
    config,
    resolved,
    costUsd: 0.02 * base * (0.5 + rng()),
    turns: 1 + Math.floor(rng() * 8 * base),
    wallClockMs: Math.floor(1000 * base * (1 + rng())),
    tokens: Math.floor(500 * base * (1 + rng())),
    status: "graded",
  };
}

/**
 * Generate a paired world. Config A's per-task latent resolve probability is
 * drawn Uniform(baseLo, baseHi); config B's is that plus `deltaPp/100`, clamped
 * to [0, 1]. Defaults keep both probabilities inside (0, 1) without clamping so
 * the realized marginal delta matches `deltaPp`.
 */
export function simulateWorld(params: WorldParams): World {
  const {
    nTasks,
    trialsPerTask: k,
    deltaPp,
    seed,
    baseLo = 0.3,
    baseHi = 0.7,
    configA = "config-a",
    configB = "config-b",
  } = params;
  const delta = deltaPp / 100;
  const rng = mulberry32(seed);
  const trials: TrialResultLike[] = [];
  let sumMajDelta = 0;
  let sumTrialDelta = 0;

  for (let i = 0; i < nTasks; i += 1) {
    const taskId = `task-${i}`;
    const pA = baseLo + rng() * (baseHi - baseLo);
    const pB = Math.min(1, Math.max(0, pA + delta));
    for (let t = 0; t < k; t += 1) trials.push(drawTrial(rng, taskId, configA, pA));
    for (let t = 0; t < k; t += 1) trials.push(drawTrial(rng, taskId, configB, pB));
    sumMajDelta += majorityResolveProb(pA, k) - majorityResolveProb(pB, k);
    sumTrialDelta += pA - pB;
  }

  return {
    trials,
    configA,
    configB,
    trueMajorityDelta: nTasks > 0 ? sumMajDelta / nTasks : 0,
    trueTrialDelta: nTasks > 0 ? sumTrialDelta / nTasks : 0,
  };
}

/**
 * Inject grading failures: mark a fraction of trials as `infra_failed` /
 * `quarantined`, and optionally drop ALL of one config's trials on some tasks
 * (asymmetric missing) so exclusion + sensitivity paths get exercised. Returns
 * a NEW trial array; the input is not mutated.
 */
export function injectFailures(
  trials: TrialResultLike[],
  opts: { seed: number; nonGradedFraction?: number; asymmetricTaskIds?: string[]; asymmetricDropConfig?: string },
): TrialResultLike[] {
  const { seed, nonGradedFraction = 0, asymmetricTaskIds = [], asymmetricDropConfig } = opts;
  const drop = new Set(asymmetricTaskIds);
  const rng = mulberry32(seed);
  const out: TrialResultLike[] = [];
  for (const t of trials) {
    if (drop.has(t.taskId) && t.config === asymmetricDropConfig) continue; // asymmetric missing
    if (nonGradedFraction > 0 && rng() < nonGradedFraction) {
      out.push({ ...t, status: rng() < 0.5 ? "infra_failed" : "quarantined" });
    } else {
      out.push({ ...t });
    }
  }
  return out;
}
