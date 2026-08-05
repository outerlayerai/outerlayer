// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// composeReportCard is the shared trials→stats→card path: runEvaluation uses
// it live, the CLI's `eval report` uses it over files. These tests pin the
// contract both consumers rely on: determinism, integrity, cost accounting,
// and the pairing orientation coming from configIds (not from the data).

import { describe, expect, test } from "vitest";
import type { TrialResult } from "@outerlayer/trial-harness";
import { assertCardIntegrity, renderCardText } from "@outerlayer/report-card";
import { composeReportCard } from "../runner.js";
import { totalCost } from "../map.js";

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

function world(): TrialResult[] {
  const trials: TrialResult[] = [];
  for (let task = 0; task < 8; task += 1) {
    for (let index = 0; index < 3; index += 1) {
      trials.push(trial({ taskId: `t${task}`, configId: "a", trialIndex: index, resolved: task < 6 }));
      trials.push(trial({ taskId: `t${task}`, configId: "b", trialIndex: index, resolved: task < 3 }));
    }
  }
  return trials;
}

describe("composeReportCard", () => {
  test("same trials + same seed ⇒ deep-equal cards; integrity lint passes", () => {
    const options = { repoLabel: "acme/widget", configIds: ["a", "b"] as [string, string], trialsPerTask: 3, seed: 7 };
    const first = composeReportCard(world(), options);
    const second = composeReportCard(world(), options);
    expect(second.card).toEqual(first.card);
    expect(() => assertCardIntegrity(first.card, renderCardText(first.card))).not.toThrow();
    expect(first.card.stats.nTasks).toBe(8);
    expect(first.card.stats.configs).toEqual(["a", "b"]);
  });

  test("spentUsd is the measured sum over ALL trials, and lands on the card", () => {
    const trials = world();
    const { card, spentUsd } = composeReportCard(trials, {
      repoLabel: "acme/widget",
      configIds: ["a", "b"],
      trialsPerTask: 3,
    });
    expect(spentUsd).toBeCloseTo(totalCost(trials), 10);
    expect(card.stats.totalCostUsd).toBeCloseTo(totalCost(trials), 10);
  });

  test("configIds set the pairing orientation regardless of data order", () => {
    const flipped = composeReportCard(world(), {
      repoLabel: "acme/widget",
      configIds: ["b", "a"],
      trialsPerTask: 3,
      seed: 7,
    });
    expect(flipped.card.stats.configs).toEqual(["b", "a"]);
    // a resolves 6/8, b resolves 3/8 — oriented b-vs-a the delta flips sign.
    expect(flipped.card.stats.pairedDelta.est).toBeLessThan(0);
  });
});
