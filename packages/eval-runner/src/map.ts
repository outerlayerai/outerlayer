// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The two mapping seams the run backend owns:
 *  1. trial-harness `TrialResult[]` → eval-stats `TrialResultLike[]` (status
 *     collapse).
 *  2. eval-stats `ReportStats` → report-card `CardStats` + the card's derived
 *     views (where-it-breaks taxonomy, divergent tasks, per-task rows)
 *     computed from the raw trials.
 *
 * Keeping these here means every consumer builds the card from stats the same
 * way — and the packages upstream stay decoupled (trial-harness doesn't know
 * eval-stats; eval-stats doesn't know report-card).
 */

import type { TrialResult } from "@outerlayer/trial-harness";
import type { TrialResultLike } from "@outerlayer/eval-stats";
import type { ReportStats } from "@outerlayer/eval-stats";
import type { CardInputs, CardStats } from "@outerlayer/report-card";

/**
 * trial-harness has six terminal statuses; eval-stats has three. An agent that
 * failed to produce a working patch (agent_error / patch_apply_failed /
 * timeout) is a real
 * RESULT — it counts as graded-and-unresolved, NOT an exclusion. Only harness
 * failures the agent isn't responsible for (build_error / infra_error) are
 * excluded.
 */
export function toStatsTrials(trials: readonly TrialResult[]): TrialResultLike[] {
  return trials.map((t) => ({
    taskId: t.taskId,
    config: t.configId,
    resolved: t.resolved,
    costUsd: t.cost.usd,
    turns: t.trajectory?.turns ?? 0,
    wallClockMs: t.timings.totalMs,
    tokens: (t.trajectory?.inputTokens ?? 0) + (t.trajectory?.outputTokens ?? 0),
    status:
      t.status === "graded"
        ? "graded"
        : t.status === "build_error" || t.status === "infra_error"
          ? "infra_failed"
          : "graded", // agent_error / patch_apply_failed / timeout = agent result
  }));
}

/** eval-stats ReportStats → report-card CardStats (structural view the card renders). */
export function toCardStats(stats: ReportStats, totalCostUsd: number): CardStats {
  return {
    configs: stats.configs,
    nTasks: stats.nTasks,
    trialsPerTask: stats.trialsPerTask,
    resolveRate: {
      a: { rate: stats.resolveRate.a.value, ci95: stats.resolveRate.a.ci95 },
      b: { rate: stats.resolveRate.b.value, ci95: stats.resolveRate.b.ci95 },
    },
    pairedDelta: { est: stats.pairedDelta.est, ci95: stats.pairedDelta.ci95 },
    dollarsPerResolved: {
      a: stats.dollarsPerResolved.a.perResolved,
      b: stats.dollarsPerResolved.b.perResolved,
      ratioCi95: stats.dollarsPerResolved.ci95Ratio,
    },
    totalCostUsd,
    mde: { at80Power: stats.mde.at80Power, note: stats.mde.note },
    verdict: stats.verdict,
    verdictRules: stats.verdictRules,
    exclusions: stats.exclusions.map((e) => ({ taskId: e.taskId, reason: e.reason })),
    sensitivity: { excludedFlippedConclusion: stats.sensitivity.excludedFlippedConclusion },
  };
}

/** Per-config majority-resolved set (task → did this config resolve it). */
function majorityResolved(trials: readonly TrialResult[], config: string): Map<string, boolean> {
  const byTask = new Map<string, { resolved: number; graded: number }>();
  for (const t of trials) {
    if (t.configId !== config || t.status !== "graded") continue;
    const acc = byTask.get(t.taskId) ?? { resolved: 0, graded: 0 };
    acc.graded += 1;
    if (t.resolved) acc.resolved += 1;
    byTask.set(t.taskId, acc);
  }
  const out = new Map<string, boolean>();
  for (const [taskId, { resolved, graded }] of byTask) {
    out.set(taskId, graded > 0 && resolved * 2 >= graded);
  }
  return out;
}

/** Where-it-breaks: non-graded status counts per config (trial-harness taxonomy). */
export function buildTaxonomy(
  trials: readonly TrialResult[],
  configs: [string, string],
): CardInputs["taxonomy"] {
  return configs.map((configId) => {
    const counts: Record<string, number> = {};
    for (const t of trials) {
      if (t.configId === configId && t.status !== "graded") {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
      }
    }
    return { configId, counts };
  });
}

/** Tasks resolved by exactly one config — the "top divergent" drill targets. */
export function buildDivergent(
  trials: readonly TrialResult[],
  configs: [string, string],
): CardInputs["divergent"] {
  const [a, b] = configs;
  const aRes = majorityResolved(trials, a);
  const bRes = majorityResolved(trials, b);
  const tasks = new Set([...aRes.keys(), ...bRes.keys()]);
  const divergent: CardInputs["divergent"] = [];
  for (const taskId of tasks) {
    const ra = aRes.get(taskId) ?? false;
    const rb = bRes.get(taskId) ?? false;
    if (ra !== rb) divergent.push({ taskId, resolvedByA: ra, resolvedByB: rb });
  }
  return divergent.sort((x, y) => x.taskId.localeCompare(y.taskId));
}

/** Per-task table rows: resolves + cost per config. */
export function buildPerTask(
  trials: readonly TrialResult[],
  configs: [string, string],
  trialsPerTask: number,
): CardInputs["perTask"] {
  const [a, b] = configs;
  const tasks = [...new Set(trials.map((t) => t.taskId))].sort();
  const count = (task: string, config: string, resolvedOnly: boolean) =>
    trials.filter(
      (t) => t.taskId === task && t.configId === config && t.status === "graded" && (!resolvedOnly || t.resolved),
    ).length;
  const cost = (task: string, config: string) =>
    trials.filter((t) => t.taskId === task && t.configId === config).reduce((s, t) => s + t.cost.usd, 0);
  return tasks.map((taskId) => ({
    taskId,
    aResolved: count(taskId, a, true),
    bResolved: count(taskId, b, true),
    trials: trialsPerTask,
    aCostUsd: cost(taskId, a),
    bCostUsd: cost(taskId, b),
  }));
}

export function totalCost(trials: readonly TrialResult[]): number {
  return trials.reduce((s, t) => s + t.cost.usd, 0);
}
