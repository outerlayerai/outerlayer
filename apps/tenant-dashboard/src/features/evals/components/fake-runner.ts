/**
 * Seeded fake runner. The wizard → live matrix → card flow runs end to
 * end with NO backend: this synthesizes deterministic trial
 * outcomes from a seed, then produces the same `CardStats` the real stats
 * engine (@outerlayer/eval-stats) emits server-side. It's the exact shape the
 * spec's acceptance uses — "wizard → (seeded fake runner) → card, for all
 * three verdict tiers" — and lets Playwright drive the whole UI unmetered.
 *
 * When the real run backend lands, this module is swapped for a client that
 * dispatches trials through the gateway and reads TrialResults; the Card
 * components below don't change (they render a CardStats-shaped model).
 */

import {
  buildReportCard,
  type CardInputs,
  type CardStats,
  type ReportCard,
  type Verdict,
} from "@outerlayer/report-card";

export interface WizardConfig {
  id: string;
  launcher: "claude-code" | "codex";
  model: string;
  baseUrl?: string;
}

export interface EvalRunRequest {
  repoLabel: string;
  taskIds: string[];
  configs: [WizardConfig, WizardConfig];
  trialsPerTask: number;
  budgetUsd: number;
  /** Which world to synthesize — drives the verdict tier deterministically. */
  scenario: Verdict;
}

/** One cell of the live trial matrix. */
export interface TrialCell {
  taskId: string;
  configId: string;
  trialIndex: number;
  status: "queued" | "running" | "graded" | "agent_error" | "timeout";
  resolved: boolean;
}

/** Deterministic RNG (mulberry32) — the same seed always yields the same run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Per-config resolve probability by scenario — tuned so the verdict tiers
 * come out as intended at the requested N. */
const RESOLVE_RATES: Record<Verdict, [number, number]> = {
  clear: [0.68, 0.42], // wide gap → clears at moderate N
  directional: [0.62, 0.54], // small consistent gap → directional
  underpowered: [0.58, 0.56], // tiny gap → underpowered
};

/** Synthesize the trial matrix cells (what the progress view animates). */
export function planTrialCells(request: EvalRunRequest): TrialCell[] {
  const cells: TrialCell[] = [];
  for (const taskId of request.taskIds) {
    for (const config of request.configs) {
      for (let trialIndex = 0; trialIndex < request.trialsPerTask; trialIndex++) {
        cells.push({ taskId, configId: config.id, trialIndex, status: "queued", resolved: false });
      }
    }
  }
  return cells;
}

/** Resolve a single cell deterministically. */
export function resolveCell(request: EvalRunRequest, cell: TrialCell): TrialCell {
  const rng = mulberry32(seedFromString(`${cell.taskId}:${cell.configId}:${cell.trialIndex}:${request.scenario}`));
  const configIndex = request.configs[0].id === cell.configId ? 0 : 1;
  const rate = RESOLVE_RATES[request.scenario][configIndex];
  const roll = rng();
  // ~4% of trials are typed non-graded outcomes (agent_error/timeout), to
  // populate the where-it-breaks taxonomy honestly.
  if (roll > 0.96) {
    return { ...cell, status: rng() > 0.5 ? "agent_error" : "timeout", resolved: false };
  }
  return { ...cell, status: "graded", resolved: rng() < rate };
}

/** Aggregate resolved cells into the CardStats the report-card renders. */
export function buildCardFromCells(request: EvalRunRequest, cells: TrialCell[]): ReportCard {
  const [a, b] = request.configs;
  const perTaskResolve = (configId: string, taskId: string) =>
    cells.filter((c) => c.configId === configId && c.taskId === taskId && c.status === "graded" && c.resolved).length;
  const gradedTrials = (configId: string, taskId: string) =>
    cells.filter((c) => c.configId === configId && c.taskId === taskId && c.status === "graded").length;

  // Per-task majority outcome per config.
  let aWins = 0;
  let bWins = 0;
  let aResolvedTasks = 0;
  let bResolvedTasks = 0;
  const perTask: CardInputs["perTask"] = [];
  const divergent: CardInputs["divergent"] = [];
  for (const taskId of request.taskIds) {
    const aRes = perTaskResolve(a.id, taskId);
    const bRes = perTaskResolve(b.id, taskId);
    const aTrials = Math.max(1, gradedTrials(a.id, taskId));
    const bTrials = Math.max(1, gradedTrials(b.id, taskId));
    const aMaj = aRes * 2 >= aTrials;
    const bMaj = bRes * 2 >= bTrials;
    if (aMaj) aResolvedTasks++;
    if (bMaj) bResolvedTasks++;
    if (aMaj && !bMaj) { aWins++; divergent.push({ taskId, resolvedByA: true, resolvedByB: false }); }
    if (bMaj && !aMaj) { bWins++; divergent.push({ taskId, resolvedByA: false, resolvedByB: true }); }
    perTask.push({
      taskId,
      aResolved: aRes,
      bResolved: bRes,
      trials: request.trialsPerTask,
      aCostUsd: 0.14 + (seedFromString(taskId) % 30) / 100,
      bCostUsd: 0.05 + (seedFromString(taskId) % 12) / 100,
    });
  }

  const n = request.taskIds.length;
  const aRate = aResolvedTasks / n;
  const bRate = bResolvedTasks / n;
  const delta = aRate - bRate; // A − B, matching @outerlayer/eval-stats' sign convention
  const discordant = aWins + bWins;
  // MDE from the observed discordance (McNemar power approximation).
  const mde = discordant > 0 ? 1.96 * Math.sqrt(discordant / (n * n)) : 0.1;
  const ciHalf = mde * (request.scenario === "clear" ? 0.6 : request.scenario === "directional" ? 1.0 : 1.4);

  const totalCost = perTask.reduce((s, t) => s + (t.aCostUsd + t.bCostUsd) * request.trialsPerTask, 0);
  const dpr = (rate: number, cost: number) => (rate > 0 ? cost / (rate * n) : Infinity);

  const stats: CardStats = {
    configs: [a.id, b.id],
    nTasks: n,
    trialsPerTask: request.trialsPerTask,
    resolveRate: {
      a: { rate: aRate, ci95: wilson(aResolvedTasks, n) },
      b: { rate: bRate, ci95: wilson(bResolvedTasks, n) },
    },
    pairedDelta: { est: delta, ci95: [delta - ciHalf, delta + ciHalf] },
    dollarsPerResolved: {
      a: dpr(aRate, perTask.reduce((s, t) => s + t.aCostUsd * request.trialsPerTask, 0)),
      b: dpr(bRate, perTask.reduce((s, t) => s + t.bCostUsd * request.trialsPerTask, 0)),
      ratioCi95: [0.2, 0.4],
    },
    totalCostUsd: totalCost,
    mde: { at80Power: mde, note: `observed discordance ${discordant}/${n}` },
    verdict: request.scenario,
    verdictRules: VERDICT_RULE[request.scenario],
    exclusions: cells.some((c) => c.status !== "graded")
      ? [{ taskId: request.taskIds[0] ?? "task-001", reason: "infra_error" }]
      : [],
    sensitivity: { excludedFlippedConclusion: false },
  };

  const taxonomy: CardInputs["taxonomy"] = [a, b].map((config) => {
    const counts: Record<string, number> = {};
    for (const cell of cells) {
      if (cell.configId === config.id && cell.status !== "graded") {
        counts[cell.status] = (counts[cell.status] ?? 0) + 1;
      }
    }
    return { configId: config.id, counts };
  });

  return buildReportCard({
    repoLabel: request.repoLabel,
    stats,
    taxonomy,
    divergent: divergent.slice(0, 5),
    perTask: perTask.slice(0, 12),
    quarantinedTests: [],
    methodologyUrl: "https://outerlayer.ai/docs/methodology",
  });
}

const VERDICT_RULE: Record<Verdict, string> = {
  clear: "95% CI excludes 0 AND |est| ≥ MDE·0.8",
  directional: "CI includes 0 but sign consistent across ≥70% of paired tasks; pass@1 agrees with pass@k",
  underpowered: "neither clear nor directional — more tasks/trials needed to reach MDE",
};

function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
