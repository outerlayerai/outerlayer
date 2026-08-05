// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Detector } from "../types.js";
import { editRetryLoop } from "./edit-loops.js";
import { costOutlier } from "./cost.js";
import { apiErrorStall } from "./stall.js";
import { contextChurn } from "./churn.js";
import { toolErrorCluster } from "./clusters.js";

/**
 * The detector registry — 5 detectors, every one validated against a real
 * 6,976-session corpus AND market demand evidence before making the cut:
 *
 *  - edit-retry-loop   the flagship: stuck retrying an un-appliable edit
 *  - tool-error-cluster the team wedge: one recurring error, fix it once
 *  - cost-outlier       expensive AND a checkable waste cause (never "just big")
 *  - api-error-stall    provider-error bursts stalling the session
 *  - context-churn      repeated compaction: work outgrew the window
 *
 * Cut after validation (kept out deliberately — do not re-add without new
 * evidence): no-edit-spin (can't tell research from spin → FP factory),
 * premature-edit (Write-vs-Edit conflation; plan-mode covers it), budget-burn
 * (97% median cache ratio locally; shipped free elsewhere), wrong-file-thrash
 * (never fires at real edit-failure rates; the real pain there is data-loss,
 * not tokens).
 */
export const DETECTORS: Detector[] = [
  editRetryLoop,
  toolErrorCluster,
  costOutlier,
  apiErrorStall,
  contextChurn,
];

export { editRetryLoop, toolErrorCluster, costOutlier, apiErrorStall, contextChurn };
export { findEditRetryRun, type EditRetryRun } from "./edit-loops.js";
export { diagnoseCauses, type OutlierCause } from "./cost.js";

/** Auto-generated detector docs (the registry IS the docs source). */
export function detectorDocs(): { id: string; scope: string; severity: string; rationale: string; costFormula: string }[] {
  return DETECTORS.map((d) => ({ id: d.id, scope: d.scope, severity: d.severity, rationale: d.docs.rationale, costFormula: d.docs.costFormula }));
}
