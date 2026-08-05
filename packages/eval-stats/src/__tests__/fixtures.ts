// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { TrialResultLike, TrialStatus } from "../types.js";

/**
 * Build a fully-controlled paired trial set (1 graded trial per config per
 * task) from concordance/discordance counts, so verdict-branch tests pin exact
 * outcomes. `aOnly` = tasks A resolves and B does not, etc.
 */
export function buildTrials(counts: {
  aOnly: number;
  bOnly: number;
  both: number;
  neither: number;
  configA?: string;
  configB?: string;
}): TrialResultLike[] {
  const { aOnly, bOnly, both, neither, configA = "config-a", configB = "config-b" } = counts;
  const out: TrialResultLike[] = [];
  let id = 0;
  const push = (taskId: string, config: string, resolved: boolean): void => {
    out.push({
      taskId,
      config,
      resolved,
      costUsd: 0.01,
      turns: 5,
      wallClockMs: 1000,
      tokens: 500,
      status: "graded",
    });
  };
  const emit = (n: number, aRes: boolean, bRes: boolean): void => {
    for (let i = 0; i < n; i += 1) {
      const taskId = `t${id++}`;
      push(taskId, configA, aRes);
      push(taskId, configB, bRes);
    }
  };
  emit(aOnly, true, false);
  emit(bOnly, false, true);
  emit(both, true, true);
  emit(neither, false, false);
  return out;
}

/** One graded trial with overridable fields. */
export function trial(over: Partial<TrialResultLike> & { taskId: string; config: string }): TrialResultLike {
  return {
    resolved: false,
    costUsd: 0.01,
    turns: 3,
    wallClockMs: 500,
    tokens: 300,
    status: "graded" as TrialStatus,
    ...over,
  };
}
