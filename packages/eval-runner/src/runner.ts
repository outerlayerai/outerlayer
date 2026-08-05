// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * runEvaluation — the run backend. Closes the eval loop:
 *
 *   tasks + two configs
 *     → runMatrix: each (task × config × trial) runs the agent in a
 *       sandbox from the prepped env, freezes the patch, grades in a
 *       FRESH sandbox by executing the repo's tests
 *     → reportStats: paired bootstrap, McNemar, Wilson, MDE, verdict tier
 *     → buildReportCard: the shareable verdict, integrity-linted
 *
 * Everything the dashboard's fake runner synthesizes, this produces for real.
 * The provider (LocalDocker / Fly / E2B), the launcher (claude-code / codex /
 * scripted), and the env factory are all injected — the orchestration is
 * identical regardless.
 */

import type { EvalTask } from "@outerlayer/task-format";
import { runMatrix, type MatrixOptions, type TrialConfig, type TrialResult } from "@outerlayer/trial-harness";
import { reportStats, type ReportStats } from "@outerlayer/eval-stats";
import { buildReportCard, type ReportCard } from "@outerlayer/report-card";
import {
  buildDivergent,
  buildPerTask,
  buildTaxonomy,
  toCardStats,
  toStatsTrials,
  totalCost,
} from "./map.js";

export interface EvalRunOptions extends Omit<MatrixOptions, "trialsPerTask"> {
  repoLabel: string;
  trialsPerTask: number;
  /** Seed for the paired bootstrap — determinism comes from here. */
  seed?: number;
  quarantinedTests?: string[];
  methodologyUrl?: string;
  /** Tasks the run was asked to evaluate, if the caller clamped `tasks` down
   * to what was available. Surfaced on the card when it exceeds what ran. */
  requestedTasks?: number;
}

export interface EvalRunResult {
  card: ReportCard;
  stats: ReportStats;
  trials: TrialResult[];
  spentUsd: number;
  /** Cells the budget kill-switch skipped, if any. */
  skipped: { taskId: string; configId: string; trialIndex: number }[];
}

export interface ComposeCardOptions {
  repoLabel: string;
  /** Pairing orientation: [A, B] — the card headlines A-vs-B in this order. */
  configIds: [string, string];
  trialsPerTask: number;
  /** Seed for the paired bootstrap — determinism comes from here. */
  seed?: number;
  quarantinedTests?: string[];
  methodologyUrl?: string;
  /** Requested task count, surfaced on the card when it exceeds what ran. */
  requestedTasks?: number;
}

export interface ComposedCard {
  card: ReportCard;
  stats: ReportStats;
  spentUsd: number;
}

/** The stats-to-card half of the run backend: trials → stats → integrity-linted card.
 * `runEvaluation` and the CLI's `eval report` share this path — one source of
 * truth for how TrialResults become a card, live or from files on disk. */
export function composeReportCard(
  trials: TrialResult[],
  options: ComposeCardOptions,
): ComposedCard {
  const { configIds } = options;

  // Statistics — the card computes nothing itself.
  const stats = reportStats(toStatsTrials(trials), {
    configA: configIds[0],
    configB: configIds[1],
    seed: options.seed ?? 1,
  });

  // The card from the stats + derived views over the raw trials.
  const spentUsd = totalCost(trials);
  const card = buildReportCard({
    repoLabel: options.repoLabel,
    stats: toCardStats(stats, spentUsd),
    taxonomy: buildTaxonomy(trials, configIds),
    divergent: buildDivergent(trials, configIds).slice(0, 8),
    perTask: buildPerTask(trials, configIds, options.trialsPerTask).slice(0, 50),
    quarantinedTests: options.quarantinedTests ?? [],
    methodologyUrl: options.methodologyUrl,
    ...(options.requestedTasks != null ? { requestedTasks: options.requestedTasks } : {}),
  });

  return { card, stats, spentUsd };
}

export async function runEvaluation(
  tasks: EvalTask[],
  configs: [TrialConfig, TrialConfig],
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  // 1. Execute the matrix: real agents, real sandboxes, real grading.
  const matrix = await runMatrix(tasks, configs, options);
  const trials = matrix.results;

  // 2–3. Stats + card via the shared composition.
  const { card, stats, spentUsd } = composeReportCard(trials, {
    repoLabel: options.repoLabel,
    configIds: [configs[0].id, configs[1].id],
    trialsPerTask: options.trialsPerTask,
    seed: options.seed,
    quarantinedTests: options.quarantinedTests,
    methodologyUrl: options.methodologyUrl,
    requestedTasks: options.requestedTasks,
  });

  return { card, stats, trials, spentUsd, skipped: matrix.skipped };
}
