// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Pairing: the unit of analysis is the TASK. For each task and config we take
 * the majority outcome over that config's graded trials, then pair the two
 * configs task-by-task. Non-graded trials (infra-failed, quarantined) are
 * dropped before the majority; a task that ends up with no graded trials for
 * one config is asymmetric and gets excluded (and reported).
 */

import type { Exclusion, TrialResultLike } from "./types.js";

/** Per-(task,config) aggregate over graded trials. */
interface Cell {
  /** Graded trials. */
  n: number;
  /** Graded resolved trials. */
  c: number;
  costUsd: number;
  turns: number;
  wallClockMs: number;
  tokens: number;
}

/** One paired task: config A vs config B, collapsed to comparable quantities. */
export interface PairedTask {
  taskId: string;
  /** Majority-resolved (strict: 2·c > n) indicator, 0 or 1. */
  majA: number;
  majB: number;
  /** Graded trial counts. */
  nA: number;
  nB: number;
  /** Graded resolved trial counts. */
  cA: number;
  cB: number;
  /** Total cost across graded trials. */
  costA: number;
  costB: number;
  /** Per-task MEAN efficiency values over graded trials. */
  turnsA: number;
  turnsB: number;
  wallA: number;
  wallB: number;
  tokensA: number;
  tokensB: number;
}

export interface Pairing {
  tasks: PairedTask[];
  exclusions: Exclusion[];
}

/** Strict majority: more than half of the graded trials resolved. */
export function majorityResolved(c: number, n: number): number {
  return 2 * c > n ? 1 : 0;
}

function emptyCell(): Cell {
  return { n: 0, c: 0, costUsd: 0, turns: 0, wallClockMs: 0, tokens: 0 };
}

function cellToPairSide(cell: Cell): {
  maj: number;
  n: number;
  c: number;
  cost: number;
  turns: number;
  wall: number;
  tokens: number;
} {
  return {
    maj: majorityResolved(cell.c, cell.n),
    n: cell.n,
    c: cell.c,
    cost: cell.costUsd,
    turns: cell.n > 0 ? cell.turns / cell.n : 0,
    wall: cell.n > 0 ? cell.wallClockMs / cell.n : 0,
    tokens: cell.n > 0 ? cell.tokens / cell.n : 0,
  };
}

/**
 * Build the paired-task table for configs A and B.
 *
 * @param includeExcluded When true (the sensitivity re-run), a task missing
 * graded trials for a config is KEPT with that side imputed as unresolved
 * (majority 0, zero cost/effort) instead of excluded. This is how
 * `sensitivity.excludedFlippedConclusion` is computed.
 */
export function buildPairing(
  trials: TrialResultLike[],
  configA: string,
  configB: string,
  includeExcluded = false,
): Pairing {
  // taskId -> { A: Cell, B: Cell }, plus a record of any non-graded trials so
  // we can explain a fully-excluded task.
  const byTask = new Map<
    string,
    { a: Cell; b: Cell; sawNonGraded: boolean; order: number }
  >();
  let order = 0;

  for (const t of trials) {
    if (t.config !== configA && t.config !== configB) continue;
    let row = byTask.get(t.taskId);
    if (!row) {
      row = { a: emptyCell(), b: emptyCell(), sawNonGraded: false, order: order++ };
      byTask.set(t.taskId, row);
    }
    if (t.status !== "graded") {
      row.sawNonGraded = true;
      continue;
    }
    const cell = t.config === configA ? row.a : row.b;
    cell.n += 1;
    if (t.resolved) cell.c += 1;
    cell.costUsd += t.costUsd;
    cell.turns += t.turns;
    cell.wallClockMs += t.wallClockMs;
    cell.tokens += t.tokens;
  }

  // Stable order = first-seen task order, so output is deterministic.
  const rows = [...byTask.entries()].sort((x, y) => x[1].order - y[1].order);

  const tasks: PairedTask[] = [];
  const exclusions: Exclusion[] = [];

  for (const [taskId, row] of rows) {
    const hasA = row.a.n > 0;
    const hasB = row.b.n > 0;

    if (!hasA || !hasB) {
      if (!includeExcluded) {
        const missing = !hasA && !hasB ? "both configs" : !hasA ? configA : configB;
        const reason = row.sawNonGraded
          ? `no graded trials for ${missing} (infra-failed/quarantined)`
          : `asymmetric trials: no trials for ${missing}`;
        exclusions.push({ taskId, reason });
        continue;
      }
      // Sensitivity re-run: keep the task, impute the missing side as a
      // zero-effort non-resolve.
    }

    const a = cellToPairSide(row.a);
    const b = cellToPairSide(row.b);
    tasks.push({
      taskId,
      majA: a.maj,
      majB: b.maj,
      nA: a.n,
      nB: b.n,
      cA: a.c,
      cB: b.c,
      costA: a.cost,
      costB: b.cost,
      turnsA: a.turns,
      turnsB: b.turns,
      wallA: a.wall,
      wallB: b.wall,
      tokensA: a.tokens,
      tokensB: b.tokens,
    });
  }

  return { tasks, exclusions };
}
