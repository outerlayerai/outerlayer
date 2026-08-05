// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The public contract of `@outerlayer/eval-stats`.
 *
 * This package is standalone by design: it does NOT import the trial harness's
 * `TrialResult`.
 * It consumes a minimal local `TrialResultLike` so it can develop and be
 * golden-tested against synthetic fixtures before the result contract lands.
 * The adapter from `TrialResult` -> `TrialResultLike` is a one-liner at the call site.
 */

/** A trial's grading status. Only `graded` trials enter the statistics. */
export type TrialStatus = "graded" | "infra_failed" | "quarantined";

/**
 * The minimal shape this package needs from one trial of one config on one
 * task. The trial harness's richer `TrialResult` is structurally assignable to this.
 */
export interface TrialResultLike {
  taskId: string;
  /** Which config produced this trial (one of the two being compared). */
  config: string;
  /** Did the trial resolve the task (all gate tests pass)? */
  resolved: boolean;
  /** Measured spend for this trial, in USD. */
  costUsd: number;
  /** Agent turns consumed. */
  turns: number;
  /** Wall-clock latency of the trial, in milliseconds. */
  wallClockMs: number;
  /** Total tokens consumed. */
  tokens: number;
  /**
   * Grading status. Only `graded` counts; `infra_failed` (harness/runner
   * failure, not the agent's fault) and `quarantined` (flaky gate test) are
   * exclusions.
   */
  status: TrialStatus;
}

/** A proportion with a Wilson score 95% confidence interval. */
export interface Ratio {
  /** Point estimate in [0, 1]. */
  value: number;
  /** Wilson score 95% CI, clamped to [0, 1]. */
  ci95: [number, number];
  /** Denominator (tasks for a task-level rate). */
  n: number;
  /** Numerator (successes). */
  successes: number;
}

/**
 * Cost efficiency for one config: total measured spend over resolved tasks.
 * `perResolved` is `Infinity` when `resolves === 0` (never `NaN`); renderers
 * MUST show it as "n/a (0 resolved)" rather than a number.
 */
export interface Money {
  /** total measured cost / resolves; `Infinity` if `resolves === 0`. */
  perResolved: number;
  /** Sum of `costUsd` over ALL graded trials for this config. */
  totalCostUsd: number;
  /** Tasks resolved by majority (the denominator). */
  resolves: number;
}

/** A paired efficiency delta (A − B) with a bootstrap 95% CI. */
export interface PairedSummary {
  /** Mean over tasks of the per-task mean for config A. */
  meanA: number;
  /** Mean over tasks of the per-task mean for config B. */
  meanB: number;
  /** Mean over tasks of (per-task mean A − per-task mean B). */
  meanDelta: number;
  /** Paired-bootstrap 95% CI of `meanDelta`. */
  ci95: [number, number];
}

/** Exact (small-sample-safe) McNemar test on discordant task-majorities. */
export interface McNemar {
  /** Tasks A resolved (majority) but B did not. */
  b: number;
  /** Tasks B resolved (majority) but A did not. */
  c: number;
  /** Two-sided exact binomial p-value. */
  p: number;
}

/** pass@k / pass^k row: unbiased estimate for each config at a given k. */
export interface PassAtKRow {
  k: number;
  a: number;
  b: number;
}

/** Minimum detectable effect at the target power. */
export interface Mde {
  /** Smallest paired resolve-rate delta detectable at 80% power (proportion). */
  at80Power: number;
  /** Human-readable formula + assumptions, for the card and the docs. */
  note: string;
}

export type Verdict = "clear" | "directional" | "underpowered";

/** One task dropped from the paired analysis, with the reason. */
export interface Exclusion {
  taskId: string;
  reason: string;
}

/**
 * The full statistical readout for a two-config comparison. Every number a
 * report card shows comes from here — the UI never computes statistics.
 *
 * Sign convention: ALL deltas are `A − B` where `configs = [A, B]`. A positive
 * `pairedDelta.est` means config A resolves more tasks than config B.
 */
export interface ReportStats {
  /** [A, B] — the two configs compared, in delta-sign order. */
  configs: [string, string];
  /** Paired units (tasks) included after exclusions. */
  nTasks: number;
  /** Fully-supported trials per task (min graded trials across included tasks/configs). */
  trialsPerTask: number;

  /** PRIMARY metric inputs: task-level majority resolve rate per config. */
  resolveRate: { a: Ratio; b: Ratio };

  /** PRIMARY metric: paired resolve-rate delta (A − B). */
  pairedDelta: {
    /** Point estimate = resolveRate.a − resolveRate.b. */
    est: number;
    /** Paired-bootstrap 95% CI (percentile method, seeded). */
    ci95: [number, number];
    /** Exact McNemar on discordant task-majorities. */
    mcnemar: McNemar;
  };

  /** SECONDARY: cost per resolved task, per config, with ratio CI (A/B). */
  dollarsPerResolved: { a: Money; b: Money; ci95Ratio: [number, number] };

  /** SECONDARY: paired efficiency deltas (A − B) for turns/wallClock/tokens. */
  efficiency: {
    turns: PairedSummary;
    wallClock: PairedSummary;
    tokens: PairedSummary;
  };

  /** EXPLORATORY: unbiased pass@k (at-least-one-of-k) per config. */
  passAtK: PassAtKRow[];
  /**
   * EXPLORATORY: unbiased pass^k (all-of-k, a consistency metric) per config.
   * Additive to this package's core contract ("pass@k / pass^k"); see README.
   */
  passHatK: PassAtKRow[];

  /** Minimum detectable effect at 80% power for this N / discordance. */
  mde: Mde;

  /** Tiered verdict — never a naked winner. */
  verdict: Verdict;
  /** Human-readable statement of the exact rule that fired. */
  verdictRules: string;

  /** Tasks dropped (infra-failed, quarantined, or asymmetric trials). */
  exclusions: Exclusion[];

  /** Robustness checks. */
  sensitivity: {
    /** Did re-running WITH the excluded tasks (imputed as unresolved) change the verdict? */
    excludedFlippedConclusion: boolean;
    /**
     * Per-trial (pass@1-granularity) paired delta, as an alternative to the
     * majority-over-trials pairing. Additive to this package's core contract,
     * which treats per-trial pairing as a sensitivity. See README.
     */
    perTrialDelta: { est: number; ci95: [number, number] };
  };
}

/** Options for {@link reportStats}. */
export interface ReportStatsOptions {
  /** Config id that plays the role of A (left side of every A − B delta). */
  configA: string;
  /** Config id that plays the role of B. */
  configB: string;
  /** Seed for the paired bootstrap RNG — determinism comes from here. */
  seed: number;
  /** Bootstrap resamples. Defaults to {@link DEFAULT_RESAMPLES} (>= 10000). */
  resamples?: number;
  /** Target power for the MDE (default 0.8). */
  power?: number;
  /** Two-sided alpha for CIs and the MDE (default 0.05). */
  alpha?: number;
}

/** Parameters for the standalone {@link mde} calculator. */
export interface MdeParams {
  /** Number of paired tasks. */
  nPairs: number;
  /** Assumed or observed discordance rate (proportion of discordant pairs). */
  discordanceRate: number;
  /** Target power (default 0.8). */
  power?: number;
  /** Two-sided alpha (default 0.05). */
  alpha?: number;
}
