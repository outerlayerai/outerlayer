// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import type { TrialResult, TrialStatus } from "@outerlayer/trial-harness";
import { reportStats, type ReportStats, type TrialResultLike } from "@outerlayer/eval-stats";
import { buildReportCard } from "@outerlayer/report-card";
import {
  buildDivergent,
  buildPerTask,
  buildTaxonomy,
  toCardStats,
  toStatsTrials,
  totalCost,
} from "../map.js";

function trial(over: Partial<TrialResult> & { taskId: string; configId: string }): TrialResult {
  return {
    schemaVersion: 1,
    trialIndex: 0,
    status: "graded",
    resolved: false,
    failToPass: [],
    passToPass: [],
    patch: "",
    patchApplyOk: true,
    trajectory: { launcher: "x", turns: 3, toolCalls: 5, toolErrors: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, wallClockMs: 4000 },
    cost: { usd: 0.2, source: "measured" },
    leak: { agentWorktreeClean: true, transcriptClean: true, gradeOffline: true, patchesNeverInAgentSandbox: true, frozenPatchIntact: true },
    quarantinedSkipped: [],
    attempt: 1,
    timings: { agentMs: 3000, gradeMs: 1000, totalMs: 4000 },
    ...over,
  };
}

describe("toStatsTrials — trial-harness six statuses → eval-stats three", () => {
  test("agent failures are graded results; only harness failures are excluded", () => {
    const statuses: TrialStatus[] = ["graded", "agent_error", "patch_apply_failed", "timeout", "build_error", "infra_error"];
    const mapped = toStatsTrials(statuses.map((status) => trial({ taskId: "t", configId: "a", status })));
    expect(mapped.map((m) => m.status)).toEqual([
      "graded", // graded
      "graded", // agent_error — the agent failed, a real result
      "graded", // patch_apply_failed — bad patch, a real result
      "graded", // timeout — agent-side, a result
      "infra_failed", // build_error — env failed, not the agent's fault
      "infra_failed", // infra_error — harness failure
    ]);
  });

  test("field mapping: cost/turns/tokens/wallclock from the trial", () => {
    const [m] = toStatsTrials([trial({ taskId: "t1", configId: "opus", resolved: true })]);
    expect(m).toEqual({
      taskId: "t1", config: "opus", resolved: true, costUsd: 0.2,
      turns: 3, wallClockMs: 4000, tokens: 1200, status: "graded",
    });
  });

  test("null trajectory degrades turns/tokens to 0, never NaN", () => {
    const [m] = toStatsTrials([trial({ taskId: "t", configId: "a", trajectory: null })]);
    expect(m.turns).toBe(0);
    expect(m.tokens).toBe(0);
  });
});

describe("derived card views over raw trials", () => {
  // opus resolves t1+t2, glm resolves neither; glm has an agent_error on t3.
  const trials: TrialResult[] = [
    trial({ taskId: "t1", configId: "opus", resolved: true }),
    trial({ taskId: "t2", configId: "opus", resolved: true }),
    trial({ taskId: "t3", configId: "opus", resolved: true }),
    trial({ taskId: "t1", configId: "glm", resolved: false }),
    trial({ taskId: "t2", configId: "glm", resolved: false }),
    trial({ taskId: "t3", configId: "glm", status: "agent_error", resolved: false }),
  ];

  test("taxonomy counts non-graded statuses per config", () => {
    expect(buildTaxonomy(trials, ["opus", "glm"])).toEqual([
      { configId: "opus", counts: {} },
      { configId: "glm", counts: { agent_error: 1 } },
    ]);
  });

  test("divergent: tasks resolved by exactly one config", () => {
    // t1, t2 resolved by opus not glm; t3 not graded for glm (majority false).
    expect(buildDivergent(trials, ["opus", "glm"])).toEqual([
      { taskId: "t1", resolvedByA: true, resolvedByB: false },
      { taskId: "t2", resolvedByA: true, resolvedByB: false },
      { taskId: "t3", resolvedByA: true, resolvedByB: false },
    ]);
  });

  test("per-task rows: resolves + summed cost per config", () => {
    const rows = buildPerTask(trials, ["opus", "glm"], 1);
    expect(rows.find((r) => r.taskId === "t1")).toEqual({
      taskId: "t1", aResolved: 1, bResolved: 0, trials: 1, aCostUsd: 0.2, bCostUsd: 0.2,
    });
  });

  test("totalCost sums every trial", () => {
    expect(totalCost(trials)).toBeCloseTo(1.2, 10);
  });
});

describe("toCardStats — eval-stats ReportStats → report-card CardStats", () => {
  const stats: ReportStats = {
    configs: ["opus", "glm"],
    nTasks: 40,
    trialsPerTask: 3,
    resolveRate: {
      a: { value: 0.62, ci95: [0.5, 0.73], n: 40, successes: 25 },
      b: { value: 0.4, ci95: [0.28, 0.53], n: 40, successes: 16 },
    },
    pairedDelta: { est: 0.22, ci95: [0.1, 0.34], mcnemar: { b: 12, c: 3, p: 0.02 } },
    dollarsPerResolved: {
      a: { perResolved: 0.35, totalCostUsd: 8.75, resolves: 25 },
      b: { perResolved: 0.12, totalCostUsd: 1.92, resolves: 16 },
      ci95Ratio: [2.1, 3.6],
    },
    efficiency: {
      turns: { meanA: 5, meanB: 4, meanDelta: 1, ci95: [0.2, 1.8] },
      wallClock: { meanA: 4000, meanB: 3000, meanDelta: 1000, ci95: [200, 1800] },
      tokens: { meanA: 1200, meanB: 900, meanDelta: 300, ci95: [50, 550] },
    },
    passAtK: [{ k: 3, a: 0.7, b: 0.45 }],
    passHatK: [{ k: 3, a: 0.5, b: 0.3 }],
    mde: { at80Power: 0.11, note: "discordance 0.25" },
    verdict: "clear",
    verdictRules: "95% CI excludes 0 AND |est| >= MDE*0.8",
    exclusions: [{ taskId: "t-infra", reason: "infra_failed" }],
    sensitivity: { excludedFlippedConclusion: false, perTrialDelta: { est: 0.2, ci95: [0.09, 0.31] } },
  };

  test("maps Ratio.value→rate, Money.perResolved→$/resolved, ci95Ratio, Mde, exclusions", () => {
    const card = toCardStats(stats, 10.67);
    expect(card.resolveRate).toEqual({ a: { rate: 0.62, ci95: [0.5, 0.73] }, b: { rate: 0.4, ci95: [0.28, 0.53] } });
    expect(card.pairedDelta).toEqual({ est: 0.22, ci95: [0.1, 0.34] });
    expect(card.dollarsPerResolved).toEqual({ a: 0.35, b: 0.12, ratioCi95: [2.1, 3.6] });
    expect(card.totalCostUsd).toBe(10.67);
    expect(card.mde).toEqual({ at80Power: 0.11, note: "discordance 0.25" });
    expect(card.verdict).toBe("clear");
    expect(card.exclusions).toEqual([{ taskId: "t-infra", reason: "infra_failed" }]);
    expect(card.sensitivity).toEqual({ excludedFlippedConclusion: false });
  });

  test("Infinity $/resolved (zero resolves) passes through, not NaN", () => {
    const zero = { ...stats, dollarsPerResolved: { ...stats.dollarsPerResolved, b: { perResolved: Infinity, totalCostUsd: 2, resolves: 0 } } };
    expect(toCardStats(zero, 5).dollarsPerResolved.b).toBe(Infinity);
  });
});

describe("real eval-stats → card: the winner sign contract", () => {
  // The bug this pins: eval-stats emits pairedDelta.est = A − B (positive ⇒ A
  // is ahead), but the report card once read that sign as B − A and headlined
  // the LOSER. It escaped every unit test because the mapping seam is correct
  // (it passes est through untouched) and the N=5 live loop lands on the
  // `underpowered` verdict, which never names a winner. Only a run that reaches
  // a naming verdict (clear/directional) over REAL stats exercises the branch —
  // so build a cleanly-separated world and drive all three packages for real.
  function separatedWorld(): TrialResultLike[] {
    const trials: TrialResultLike[] = [];
    for (let i = 0; i < 30; i++) {
      const aResolved = i < 24; // A resolves 24/30
      const bResolved = i < 8; //  B resolves  8/30 — a subset of A's, so all 16
      //                            discordant pairs favour A (McNemar → clear).
      for (const [config, resolved, cost] of [
        ["config-a", aResolved, 0.4],
        ["config-b", bResolved, 0.1],
      ] as const) {
        trials.push({ taskId: `t${i}`, config, resolved, costUsd: cost, turns: 3, wallClockMs: 4000, tokens: 1000, status: "graded" });
      }
    }
    return trials;
  }

  test("A ahead ⇒ est > 0 ⇒ the card headlines config A, never config B", () => {
    const stats = reportStats(separatedWorld(), { configA: "config-a", configB: "config-b", seed: 7 });
    // eval-stats put A ahead with a positive A − B delta and a real verdict.
    expect(stats.pairedDelta.est).toBeGreaterThan(0);
    expect(stats.verdict).not.toBe("underpowered");

    const card = buildReportCard({
      repoLabel: "acme/x",
      stats: toCardStats(stats, 15),
      taxonomy: [],
      divergent: [],
      perTask: [],
      quarantinedTests: [],
    });

    // The naming branch ran and named the ACTUAL winner (A), not the loser (B).
    expect(card.conclusion).toMatch(/^config-a resolves \+\d+pp more than config-b\b/);
    expect(card.conclusion).not.toContain("config-b resolves");
  });
});
