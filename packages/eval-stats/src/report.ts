// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `reportStats` — the one function a card is built from. Given trials for two
 * configs it returns the full {@link ReportStats}: paired resolve-rate delta
 * (primary), cost efficiency, effort deltas, pass@k/pass^k, the MDE, and a
 * tiered verdict. Pure and deterministic: every random draw comes from the
 * seeded RNG, so the same input and seed produce byte-identical output.
 */

import {
  mcnemarExactP,
  percentileSorted,
  round10,
  round10Pair,
  safeRatio,
  wilsonInterval,
} from "./math.js";
import { mde as mdeCalc, mdeNote, tasksNeeded } from "./mde.js";
import { buildPairing, type PairedTask, type Pairing } from "./pairing.js";
import { passAtKUnbiased, passHatKUnbiased } from "./passk.js";
import { mulberry32 } from "./rng.js";
import type {
  PairedSummary,
  PassAtKRow,
  Ratio,
  ReportStats,
  ReportStatsOptions,
  TrialResultLike,
  Verdict,
} from "./types.js";

/** Production default. The spec mandates >= 10k paired resamples. */
export const DEFAULT_RESAMPLES = 10000;

/** Fraction of MDE the point estimate must clear to be `clear`. */
const CLEAR_MDE_FRACTION = 0.8;
/** Fraction of discordant tasks that must agree in sign to be `directional`. */
const DIRECTIONAL_SIGN_FRACTION = 0.7;

/** One decimal, in percentage points. */
function pp(x: number): string {
  return (x * 100).toFixed(1);
}

/** −1 / 0 / +1 with a tiny dead-zone so bootstrap noise never fakes a sign. */
function sign(x: number): number {
  if (x > 1e-12) return 1;
  if (x < -1e-12) return -1;
  return 0;
}

interface BootstrapCIs {
  delta: [number, number];
  costRatio: [number, number];
  turns: [number, number];
  wall: [number, number];
  tokens: [number, number];
  trialDelta: [number, number];
}

/**
 * One coherent paired bootstrap: each replicate resamples TASKS (the pairing
 * unit) with replacement and recomputes every task-level statistic from the
 * SAME resample, so the CIs are mutually consistent and the seed fully
 * determines them.
 */
function pairedBootstrap(
  tasks: PairedTask[],
  seed: number,
  resamples: number,
): BootstrapCIs {
  const n = tasks.length;
  const d = new Float64Array(n);
  const majA = new Float64Array(n);
  const majB = new Float64Array(n);
  const costA = new Float64Array(n);
  const costB = new Float64Array(n);
  const turns = new Float64Array(n);
  const wall = new Float64Array(n);
  const tokens = new Float64Array(n);
  const trial = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = tasks[i];
    d[i] = t.majA - t.majB;
    majA[i] = t.majA;
    majB[i] = t.majB;
    costA[i] = t.costA;
    costB[i] = t.costB;
    turns[i] = t.turnsA - t.turnsB;
    wall[i] = t.wallA - t.wallB;
    tokens[i] = t.tokensA - t.tokensB;
    trial[i] = (t.nA > 0 ? t.cA / t.nA : 0) - (t.nB > 0 ? t.cB / t.nB : 0);
  }

  const deltas = new Array<number>(resamples);
  const ratios = new Array<number>(resamples);
  const turnsD = new Array<number>(resamples);
  const wallD = new Array<number>(resamples);
  const tokensD = new Array<number>(resamples);
  const trialD = new Array<number>(resamples);

  const rng = mulberry32(seed);
  for (let r = 0; r < resamples; r += 1) {
    let sumD = 0;
    let sumMajA = 0;
    let sumMajB = 0;
    let sumCostA = 0;
    let sumCostB = 0;
    let sumTurns = 0;
    let sumWall = 0;
    let sumTokens = 0;
    let sumTrial = 0;
    for (let j = 0; j < n; j += 1) {
      const idx = (rng() * n) | 0;
      sumD += d[idx];
      sumMajA += majA[idx];
      sumMajB += majB[idx];
      sumCostA += costA[idx];
      sumCostB += costB[idx];
      sumTurns += turns[idx];
      sumWall += wall[idx];
      sumTokens += tokens[idx];
      sumTrial += trial[idx];
    }
    deltas[r] = sumD / n;
    // $/resolved ratio A/B in cross-multiplied form so 0/0 is defined.
    ratios[r] = safeRatio(sumCostA * sumMajB, sumCostB * sumMajA);
    turnsD[r] = sumTurns / n;
    wallD[r] = sumWall / n;
    tokensD[r] = sumTokens / n;
    trialD[r] = sumTrial / n;
  }

  const ci = (arr: number[]): [number, number] => {
    arr.sort((x, y) => x - y);
    return [percentileSorted(arr, 0.025), percentileSorted(arr, 0.975)];
  };

  return {
    delta: ci(deltas),
    costRatio: ci(ratios),
    turns: ci(turnsD),
    wall: ci(wallD),
    tokens: ci(tokensD),
    trialDelta: ci(trialD),
  };
}

/** Average an unbiased per-task estimator over a set of tasks. */
function averagePassK(
  tasks: PairedTask[],
  k: number,
  estimator: (c: number, n: number, k: number) => number,
  side: "a" | "b",
): number {
  let sum = 0;
  for (const t of tasks) {
    sum += side === "a" ? estimator(t.cA, t.nA, k) : estimator(t.cB, t.nB, k);
  }
  return sum / tasks.length;
}

function degenerateReport(
  configA: string,
  configB: string,
  power: number,
  alpha: number,
): ReportStats {
  const zeroRatio: Ratio = { value: 0, ci95: [0, 1], n: 0, successes: 0 };
  const zeroSummary: PairedSummary = {
    meanA: 0,
    meanB: 0,
    meanDelta: 0,
    ci95: [0, 0],
  };
  return {
    configs: [configA, configB],
    nTasks: 0,
    trialsPerTask: 0,
    resolveRate: { a: zeroRatio, b: zeroRatio },
    pairedDelta: { est: 0, ci95: [0, 0], mcnemar: { b: 0, c: 0, p: 1 } },
    dollarsPerResolved: {
      a: { perResolved: Infinity, totalCostUsd: 0, resolves: 0 },
      b: { perResolved: Infinity, totalCostUsd: 0, resolves: 0 },
      ci95Ratio: [1, 1],
    },
    efficiency: { turns: zeroSummary, wallClock: zeroSummary, tokens: zeroSummary },
    passAtK: [],
    passHatK: [],
    mde: {
      at80Power: Infinity,
      note: mdeNote({
        nPairs: 0,
        discordanceRate: 0,
        power,
        alpha,
        assumption: "no paired tasks",
      }),
    },
    verdict: "underpowered",
    verdictRules: "underpowered: no paired tasks to compare.",
    exclusions: [],
    sensitivity: { excludedFlippedConclusion: false, perTrialDelta: { est: 0, ci95: [0, 0] } },
  };
}

/** Compute everything except `exclusions` and the exclusion-flip sensitivity. */
function computeCore(
  pairing: Pairing,
  opts: Required<Omit<ReportStatsOptions, "resamples">> & { resamples: number },
): ReportStats {
  const { configA, configB, seed, resamples, power, alpha } = opts;
  const tasks = pairing.tasks;
  const n = tasks.length;
  if (n === 0) return degenerateReport(configA, configB, power, alpha);

  // --- Marginals and the paired point estimate ---
  let resolvesA = 0;
  let resolvesB = 0;
  let mcB = 0; // A resolved, B did not
  let mcC = 0; // B resolved, A did not
  let totalCostA = 0;
  let totalCostB = 0;
  let sumTurnsA = 0;
  let sumTurnsB = 0;
  let sumWallA = 0;
  let sumWallB = 0;
  let sumTokensA = 0;
  let sumTokensB = 0;
  let sumTrialDelta = 0; // per-trial (pass@1-granularity) paired delta numerator
  for (const t of tasks) {
    resolvesA += t.majA;
    resolvesB += t.majB;
    if (t.majA === 1 && t.majB === 0) mcB += 1;
    if (t.majA === 0 && t.majB === 1) mcC += 1;
    totalCostA += t.costA;
    totalCostB += t.costB;
    sumTurnsA += t.turnsA;
    sumTurnsB += t.turnsB;
    sumWallA += t.wallA;
    sumWallB += t.wallB;
    sumTokensA += t.tokensA;
    sumTokensB += t.tokensB;
    sumTrialDelta +=
      (t.nA > 0 ? t.cA / t.nA : 0) - (t.nB > 0 ? t.cB / t.nB : 0);
  }
  const perTrialEst = sumTrialDelta / n;

  const rateA = wilsonInterval(resolvesA, n, alpha);
  const rateB = wilsonInterval(resolvesB, n, alpha);
  const est = (resolvesA - resolvesB) / n;
  const discordance = (mcB + mcC) / n;
  const mcnemarP = mcnemarExactP(mcB, mcC);

  // --- Coherent paired bootstrap for every CI that needs one ---
  const boot = pairedBootstrap(tasks, seed, resamples);

  // --- pass@k / pass^k over fully-supported k on complete tasks ---
  const complete = tasks.filter((t) => t.nA > 0 && t.nB > 0);
  let kMax = 0;
  if (complete.length > 0) {
    kMax = Infinity;
    for (const t of complete) kMax = Math.min(kMax, t.nA, t.nB);
  }
  const passAtK: PassAtKRow[] = [];
  const passHatK: PassAtKRow[] = [];
  for (let k = 1; k <= kMax; k += 1) {
    passAtK.push({
      k,
      a: round10(averagePassK(complete, k, passAtKUnbiased, "a")),
      b: round10(averagePassK(complete, k, passAtKUnbiased, "b")),
    });
    passHatK.push({
      k,
      a: round10(averagePassK(complete, k, passHatKUnbiased, "a")),
      b: round10(averagePassK(complete, k, passHatKUnbiased, "b")),
    });
  }

  // --- MDE at 80% power from the OBSERVED discordance ---
  const mdeValue = mdeCalc({ nPairs: n, discordanceRate: discordance, power, alpha });
  const mdeObj = {
    at80Power: round10(mdeValue),
    note: mdeNote({
      nPairs: n,
      discordanceRate: discordance,
      power,
      alpha,
      assumption: "observed discordance",
    }),
  };

  // --- Cost efficiency ---
  const perResolvedA = resolvesA === 0 ? Infinity : totalCostA / resolvesA;
  const perResolvedB = resolvesB === 0 ? Infinity : totalCostB / resolvesB;

  // --- Effort deltas ---
  const mkSummary = (
    sumA: number,
    sumB: number,
    ci95: [number, number],
  ): PairedSummary => ({
    meanA: round10(sumA / n),
    meanB: round10(sumB / n),
    meanDelta: round10((sumA - sumB) / n),
    ci95: round10Pair(ci95),
  });

  // --- Verdict ---
  const [ciLo, ciHi] = boot.delta;
  const ciExcludesZero = (ciLo > 0 && ciHi > 0) || (ciLo < 0 && ciHi < 0);
  const absEst = Math.abs(est);
  const clearMagnitudeOK = absEst >= CLEAR_MDE_FRACTION * mdeValue;

  const discordantTotal = mcB + mcC;
  const signConsistentFrac =
    discordantTotal > 0 ? Math.max(mcB, mcC) / discordantTotal : 0;
  const signConsistent = signConsistentFrac >= DIRECTIONAL_SIGN_FRACTION;

  const dir1 = passAtK.length > 0 ? sign(passAtK[0].a - passAtK[0].b) : 0;
  const dirK =
    passAtK.length > 0
      ? sign(passAtK[passAtK.length - 1].a - passAtK[passAtK.length - 1].b)
      : 0;
  const passAgree = dir1 !== 0 && dir1 === dirK;

  let verdict: Verdict;
  let verdictRules: string;
  if (ciExcludesZero && clearMagnitudeOK) {
    verdict = "clear";
    const winner = est > 0 ? configA : configB;
    verdictRules =
      `clear: 95% CI [${pp(ciLo)}, ${pp(ciHi)}] pp excludes 0 and ` +
      `|Δ|=${pp(absEst)} pp ≥ 0.8·MDE=${pp(CLEAR_MDE_FRACTION * mdeValue)} pp ` +
      `(favors ${winner}).`;
  } else if (!ciExcludesZero && signConsistent && passAgree) {
    verdict = "directional";
    const winner = est > 0 ? configA : configB;
    const kLast = passAtK[passAtK.length - 1].k;
    const passPhrase =
      kLast === 1
        ? "pass@1 is directionally consistent"
        : `pass@1 agrees with pass@${kLast}`;
    verdictRules =
      `directional: 95% CI [${pp(ciLo)}, ${pp(ciHi)}] pp includes 0, but ` +
      `${(signConsistentFrac * 100).toFixed(0)}% of ${discordantTotal} discordant tasks ` +
      `favor ${winner} and ${passPhrase}.`;
  } else {
    verdict = "underpowered";
    const need = tasksNeeded(absEst, { discordanceRate: discordance, power, alpha });
    const needStr = Number.isFinite(need) ? `~${need}` : "many more";
    if (sign(est) === 0) {
      verdictRules =
        `underpowered: Δ≈0 (${pp(est)} pp), 95% CI [${pp(ciLo)}, ${pp(ciHi)}] pp; ` +
        `no effect to size. MDE at this N is ${pp(mdeValue)} pp.`;
    } else if (ciExcludesZero) {
      // CI excludes 0 but |Δ| < 0.8·MDE: the interval is real yet below our
      // detectability bar — too wide to trust at this N. Not "clear".
      verdictRules =
        `underpowered: 95% CI [${pp(ciLo)}, ${pp(ciHi)}] pp excludes 0 but ` +
        `|Δ|=${pp(absEst)} pp < 0.8·MDE=${pp(CLEAR_MDE_FRACTION * mdeValue)} pp; ` +
        `interval too wide to trust at this N. ${needStr} paired tasks would clear ` +
        `the bar (have ${n}).`;
    } else {
      verdictRules =
        `underpowered: 95% CI [${pp(ciLo)}, ${pp(ciHi)}] pp includes 0. ` +
        `Observed Δ=${pp(est)} pp needs ${needStr} paired tasks to detect at ` +
        `${(power * 100).toFixed(0)}% power (have ${n}); more trials/task also help ` +
        `if the ${(discordance * 100).toFixed(0)}% discordance is noise-driven.`;
    }
  }

  return {
    configs: [configA, configB],
    nTasks: n,
    trialsPerTask: Number.isFinite(kMax) ? kMax : 0,
    resolveRate: {
      a: { value: round10(rateA.value), ci95: round10Pair(rateA.ci95), n, successes: resolvesA },
      b: { value: round10(rateB.value), ci95: round10Pair(rateB.ci95), n, successes: resolvesB },
    },
    pairedDelta: {
      est: round10(est),
      ci95: round10Pair(boot.delta),
      // p is left unrounded: it is deterministic (integer/`pow` arithmetic) and
      // rounding to 1e-10 would flatten tiny-but-nonzero p-values toward 0.
      mcnemar: { b: mcB, c: mcC, p: mcnemarP },
    },
    dollarsPerResolved: {
      a: { perResolved: round10(perResolvedA), totalCostUsd: round10(totalCostA), resolves: resolvesA },
      b: { perResolved: round10(perResolvedB), totalCostUsd: round10(totalCostB), resolves: resolvesB },
      ci95Ratio: round10Pair(boot.costRatio),
    },
    efficiency: {
      turns: mkSummary(sumTurnsA, sumTurnsB, boot.turns),
      wallClock: mkSummary(sumWallA, sumWallB, boot.wall),
      tokens: mkSummary(sumTokensA, sumTokensB, boot.tokens),
    },
    passAtK,
    passHatK,
    mde: mdeObj,
    verdict,
    verdictRules,
    exclusions: [],
    sensitivity: {
      excludedFlippedConclusion: false,
      perTrialDelta: { est: round10(perTrialEst), ci95: round10Pair(boot.trialDelta) },
    },
  };
}

/**
 * The full statistical readout for a two-config comparison.
 *
 * @param trials Trials for BOTH configs (and possibly others, which are
 * ignored). Only `status === "graded"` trials count.
 * @param opts Which two configs, the RNG seed, and optional resamples/power/alpha.
 */
export function reportStats(
  trials: readonly TrialResultLike[],
  opts: ReportStatsOptions,
): ReportStats {
  const resolved = {
    configA: opts.configA,
    configB: opts.configB,
    seed: opts.seed,
    resamples: opts.resamples ?? DEFAULT_RESAMPLES,
    power: opts.power ?? 0.8,
    alpha: opts.alpha ?? 0.05,
  };

  const pairing = buildPairing([...trials], resolved.configA, resolved.configB, false);
  const core = computeCore(pairing, resolved);
  core.exclusions = pairing.exclusions;

  // Sensitivity: re-run INCLUDING the excluded tasks (missing side imputed as
  // an unresolved, zero-effort trial) and see whether the verdict flips.
  let excludedFlippedConclusion = false;
  if (pairing.exclusions.length > 0) {
    const inclusive = buildPairing([...trials], resolved.configA, resolved.configB, true);
    const inclusiveCore = computeCore(inclusive, resolved);
    excludedFlippedConclusion = inclusiveCore.verdict !== core.verdict;
  }
  core.sensitivity.excludedFlippedConclusion = excludedFlippedConclusion;

  return core;
}
