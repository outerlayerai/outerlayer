// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The Harness Report Card model. The card is the shareable verdict:
 * "Config A vs Config B on OUR repo — Δ resolve rate with CIs,
 * $-per-resolved-task, and where it breaks." Its integrity rules ARE the
 * brand (integrity.ts): verdict tier always visible, MDE always printed,
 * exclusions always disclosed, never a naked winner.
 *
 * All numbers come from the harness's ReportStats — the card NEVER computes
 * stats (single source of truth). This model takes a structural view of
 * that contract so the card composes whatever the stats layer emits.
 */

export const CARD_SCHEMA_VERSION = 1;

export type Verdict = "clear" | "directional" | "underpowered";

export interface Ratio {
  rate: number;
  ci95: [number, number];
}

/** Structural view of eval-stats' ReportStats — only what the card renders. */
export interface CardStats {
  configs: [string, string];
  nTasks: number;
  trialsPerTask: number;
  resolveRate: { a: Ratio; b: Ratio };
  pairedDelta: { est: number; ci95: [number, number] };
  dollarsPerResolved: { a: number; b: number; ratioCi95: [number, number] };
  totalCostUsd: number;
  mde: { at80Power: number; note: string };
  verdict: Verdict;
  verdictRules: string;
  exclusions: { taskId: string; reason: string }[];
  sensitivity: { excludedFlippedConclusion: boolean };
}

/** Where-it-breaks taxonomy per config, from trial statuses and failure detectors. */
export interface FailureTaxonomy {
  configId: string;
  counts: Record<string, number>; // status/detector → count
}

export interface DivergentTask {
  taskId: string;
  resolvedByA: boolean;
  resolvedByB: boolean;
}

export interface PerTaskRow {
  taskId: string;
  aResolved: number; // resolves across trials
  bResolved: number;
  trials: number;
  aCostUsd: number;
  bCostUsd: number;
}

export interface CardInputs {
  repoLabel: string;
  stats: CardStats;
  taxonomy: FailureTaxonomy[];
  divergent: DivergentTask[];
  perTask: PerTaskRow[];
  quarantinedTests: string[];
  methodologyUrl?: string;
  /**
   * Tasks the run was *asked* to evaluate (the wizard/CLI request). When this
   * exceeds `stats.nTasks` the run scored fewer than requested — today because
   * the scripted-fixture worker caps at its available tasks, later because the
   * qualified set is smaller. Renderers disclose the gap so a requested scale
   * is never silently ignored. Undefined ⇒ nothing to reconcile (nTasks stands).
   */
  requestedTasks?: number;
}

export interface ReportCard {
  schemaVersion: typeof CARD_SCHEMA_VERSION;
  repoLabel: string;
  verdict: Verdict;
  /** The headline conclusion — templated, always carrying N and the tier. */
  conclusion: string;
  /** "This run can detect differences ≥ Xpp; observed |Δ| = Ypp." — ALWAYS. */
  mdeLine: string;
  stats: CardStats;
  taxonomy: FailureTaxonomy[];
  divergent: DivergentTask[];
  perTask: PerTaskRow[];
  quarantinedTests: string[];
  methodologyUrl?: string;
  /** Requested task count when it exceeded what actually ran — see CardInputs. */
  requestedTasks?: number;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  clear: "Clear result",
  directional: "Directional",
  underpowered: "Underpowered",
};

export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABEL[verdict];
}

function pp(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}pp`;
}

export function buildReportCard(inputs: CardInputs): ReportCard {
  const { stats } = inputs;
  const [aId, bId] = stats.configs;
  const deltaPct = Math.abs(stats.pairedDelta.est) * 100;
  const mdePct = stats.mde.at80Power * 100;

  const conclusion = buildConclusion(inputs, aId, bId);
  const mdeLine = `This run can detect differences ≥ ${mdePct.toFixed(0)}pp; observed |Δ| = ${deltaPct.toFixed(0)}pp.`;

  // Only carry the requested count when it actually exceeds what ran — an
  // equal (or absent) request is nothing to reconcile, so the card stays clean.
  const clampedFrom =
    inputs.requestedTasks != null && inputs.requestedTasks > stats.nTasks
      ? inputs.requestedTasks
      : undefined;

  return {
    schemaVersion: CARD_SCHEMA_VERSION,
    repoLabel: inputs.repoLabel,
    verdict: stats.verdict,
    conclusion,
    mdeLine,
    stats,
    taxonomy: inputs.taxonomy,
    divergent: inputs.divergent,
    perTask: inputs.perTask,
    quarantinedTests: inputs.quarantinedTests,
    methodologyUrl: inputs.methodologyUrl,
    ...(clampedFrom != null ? { requestedTasks: clampedFrom } : {}),
  };
}

function buildConclusion(inputs: CardInputs, aId: string, bId: string): string {
  const { stats } = inputs;
  const tier = VERDICT_LABEL[stats.verdict].toLowerCase();
  const n = `N=${stats.nTasks}`;
  if (stats.verdict === "underpowered") {
    return `No detectable difference between ${aId} and ${bId} at ${n} — underpowered (need a smaller gap or more tasks/trials to resolve ${pp(stats.pairedDelta.est)}).`;
  }
  // pairedDelta.est is A − B (eval-stats' canonical convention): est > 0 means
  // config A resolved more, so A is the better arm. (Getting this backwards
  // names the wrong winner.)
  const aBetter = stats.pairedDelta.est >= 0;
  const better = aBetter ? aId : bId;
  const worse = aBetter ? bId : aId;
  const betterRate = aBetter ? stats.resolveRate.a : stats.resolveRate.b;
  const worseRate = aBetter ? stats.resolveRate.b : stats.resolveRate.a;
  const keptPct = worseRate.rate > 0 ? Math.round((betterRate.rate / worseRate.rate) * 100) : 0;
  const dollarBetter = aBetter ? stats.dollarsPerResolved.a : stats.dollarsPerResolved.b;
  const dollarWorse = aBetter ? stats.dollarsPerResolved.b : stats.dollarsPerResolved.a;
  const costPct = dollarWorse > 0 ? Math.round((dollarBetter / dollarWorse) * 100) : 0;
  return `${better} resolves ${pp(Math.abs(stats.pairedDelta.est))} more than ${worse} (${keptPct}% of its rate) at ${costPct}% of the $/resolved-task — ${tier} at ${n}.`;
}
