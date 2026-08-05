// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The GO/NO-GO launch gate. One page that says GO or NO-GO:
 * live SLO checks + manual founder sign-offs, AND the encoded requirement of
 * TWO CONSECUTIVE GREEN WEEKS (a single good week isn't a launch signal).
 */

import { checkSlos, type SloCheck, type SloValues } from "./slo.js";

export interface ManualSignoff {
  name: string;
  approved: boolean;
}

export interface WeeklySlo {
  weekIso: string;
  slos: SloValues;
}

export interface LaunchGate {
  decision: "GO" | "NO_GO";
  reasons: string[];
  latestChecks: SloCheck[];
  consecutiveGreenWeeks: number;
  manualBlockers: string[];
}

const REQUIRED_GREEN_WEEKS = 2;

export function weekIsGreen(slos: SloValues): boolean {
  return checkSlos(slos).every((check) => check.pass);
}

/** Count consecutive green weeks ending at the most recent (weeks in
 * chronological order). */
export function consecutiveGreenWeeks(weeks: WeeklySlo[]): number {
  let count = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (weekIsGreen(weeks[i]!.slos)) count += 1;
    else break;
  }
  return count;
}

export function evaluateLaunchGate(weeks: WeeklySlo[], signoffs: ManualSignoff[]): LaunchGate {
  const latest = weeks[weeks.length - 1];
  const latestChecks = latest ? checkSlos(latest.slos) : [];
  const green = consecutiveGreenWeeks(weeks);
  const manualBlockers = signoffs.filter((s) => !s.approved).map((s) => s.name);

  const reasons: string[] = [];
  if (green < REQUIRED_GREEN_WEEKS) {
    reasons.push(`${green}/${REQUIRED_GREEN_WEEKS} consecutive green weeks (need ${REQUIRED_GREEN_WEEKS})`);
  }
  for (const check of latestChecks) {
    if (!check.pass) reasons.push(`SLO ${check.name}: ${check.value} ${check.comparator} ${check.gate} FAILED`);
  }
  for (const blocker of manualBlockers) reasons.push(`manual sign-off pending: ${blocker}`);

  return {
    decision: reasons.length === 0 ? "GO" : "NO_GO",
    reasons,
    latestChecks,
    consecutiveGreenWeeks: green,
    manualBlockers,
  };
}

export function renderLaunchGateText(gate: LaunchGate): string {
  const lines: string[] = [];
  lines.push(`LAUNCH GATE: ${gate.decision}`);
  lines.push(`  consecutive green weeks: ${gate.consecutiveGreenWeeks}`);
  lines.push("  latest SLOs:");
  for (const check of gate.latestChecks) {
    lines.push(`    ${check.pass ? "✓" : "✗"} ${check.name}: ${check.value} ${check.comparator} ${check.gate}`);
  }
  if (gate.reasons.length > 0) {
    lines.push("  blockers:");
    for (const reason of gate.reasons) lines.push(`    • ${reason}`);
  }
  return lines.join("\n");
}
