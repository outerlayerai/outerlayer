// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * EnvBuildReport — per-repo env outcomes that feed the Repo Report
 * directly: how many envs built deterministically vs needed repair vs
 * escalated, build/probe times, and cache hit rate.
 */

export const ENV_REPORT_SCHEMA_VERSION = 1;

export type EnvOutcome = "deterministic" | "repaired" | "cache_hit" | "escalated";

export interface EnvTaskResult {
  taskId: string;
  outcome: EnvOutcome;
  envKey?: string;
  imageRef?: string;
  setupSource: "original" | "repaired";
  repairAttempts: number;
  costUsd: number;
  buildMs: number;
  probeMs: number;
}

export interface EnvBuildReport {
  schemaVersion: typeof ENV_REPORT_SCHEMA_VERSION;
  provider: string;
  startedAt: string;
  finishedAt: string;
  results: EnvTaskResult[];
  summary: {
    total: number;
    deterministic: number;
    repaired: number;
    cacheHits: number;
    escalated: number;
    cacheHitRate: number;
    totalCostUsd: number;
    /** Warm boots ready for card time = anything that produced an env. */
    ready: number;
  };
}

export function summarizeEnvResults(
  results: EnvTaskResult[],
): EnvBuildReport["summary"] {
  let deterministic = 0;
  let repaired = 0;
  let cacheHits = 0;
  let escalated = 0;
  let totalCostUsd = 0;
  for (const result of results) {
    if (result.outcome === "deterministic") deterministic += 1;
    else if (result.outcome === "repaired") repaired += 1;
    else if (result.outcome === "cache_hit") cacheHits += 1;
    else escalated += 1;
    totalCostUsd += result.costUsd;
  }
  const total = results.length;
  return {
    total,
    deterministic,
    repaired,
    cacheHits,
    escalated,
    cacheHitRate: total > 0 ? cacheHits / total : 0,
    totalCostUsd,
    ready: total - escalated,
  };
}

export function renderEnvReportText(report: EnvBuildReport): string {
  const glyph: Record<EnvOutcome, string> = {
    deterministic: "✓",
    repaired: "🔧",
    cache_hit: "⚡",
    escalated: "⛑",
  };
  const lines: string[] = [];
  lines.push(`env prep — provider=${report.provider} tasks=${report.summary.total}`);
  lines.push("");
  for (const result of report.results) {
    const cost = result.costUsd > 0 ? ` $${result.costUsd.toFixed(2)}` : "";
    const attempts = result.repairAttempts > 0 ? ` (${result.repairAttempts} repair attempt(s))` : "";
    lines.push(
      `${glyph[result.outcome]} ${result.taskId}  [${result.outcome}]${attempts}${cost}  build ${result.buildMs}ms · probe ${result.probeMs}ms`,
    );
  }
  lines.push("");
  const { summary } = report;
  lines.push(
    `${summary.deterministic} deterministic · ${summary.repaired} repaired · ${summary.cacheHits} cache-hit · ${summary.escalated} escalated`,
  );
  lines.push(
    `${summary.ready}/${summary.total} ready for card time · cache hit rate ${(summary.cacheHitRate * 100).toFixed(0)}% · spent $${summary.totalCostUsd.toFixed(2)}`,
  );
  return lines.join("\n");
}
