// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Provenance labelling (step 4). Synthetic tasks measure bug-FIXING on your
 * codebase, not feature work, so a card must caption them honestly and the
 * stats + card layers must render the natural-vs-synthetic split — never a single merged headline.
 * `renderProvenanceSplit` exists precisely so the merged number is impossible
 * to render by accident.
 */

import type { EvalTask } from "@outerlayer/task-format";

/** The honest caption a card shows above a synthetic set. */
export const SYNTHETIC_HONESTY_CAPTION = "regression-fix tasks, not feature work";

export interface ProvenanceCounts {
  mined: number;
  synthetic: number;
  manual?: number;
}

/** Count tasks by provenance (unset provenance counts as none of the three). */
export function countByProvenance(tasks: EvalTask[]): { mined: number; synthetic: number; manual: number } {
  let mined = 0;
  let synthetic = 0;
  let manual = 0;
  for (const task of tasks) {
    if (task.provenance === "mined") mined += 1;
    else if (task.provenance === "synthetic") synthetic += 1;
    else if (task.provenance === "manual") manual += 1;
  }
  return { mined, synthetic, manual };
}

/**
 * Render the split as `N=84 mined + 120 synthetic` (+ `+ M manual` when
 * present). Deliberately never emits `mined + synthetic` as one total.
 */
export function renderProvenanceSplit(counts: ProvenanceCounts): string {
  const segments = [`N=${counts.mined} mined`, `${counts.synthetic} synthetic`];
  if (counts.manual && counts.manual > 0) segments.push(`${counts.manual} manual`);
  return segments.join(" + ");
}
