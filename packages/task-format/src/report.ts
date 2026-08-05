// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * TaskValidationReport — the stable contract repo-report renders into the Repo
 * Report. Versioned; goldens pin it. Timings are real; goldens normalize
 * them (see __tests__/gate.test.ts).
 */

import type { EvalTask, QuarantineEntry } from "./schema.js";

/** The task file's `determinism` block — what the gate records
 * and env-prep's cache key consumes. */
export type TaskDeterminism = NonNullable<EvalTask["determinism"]>;

export const REPORT_SCHEMA_VERSION = 1;

/** Disqualifying reasons, exhaustive and exclusive (first failure wins). */
export type InvalidReason =
  | "schema_invalid"
  | "patch_overlap"
  | "env_fail"
  | "test_patch_apply_failed"
  | "bad_test_id"
  | "f2p_pass_prefix"
  | "gold_apply_failed"
  | "gold_fails"
  | "p2p_fail"
  | "flaky_f2p_exhausted"
  | "leak";

export type TaskStatus = "valid" | "invalid" | "needs_review";

export interface PhaseTiming {
  envMs: number;
  gateMs: number;
}

export interface TestRunEvidence {
  /** test id → outcome per round, e.g. { "tests/test_x.py::test_y": ["fail"] } */
  [testId: string]: string[];
}

export interface TaskReportEntry {
  taskId: string;
  status: TaskStatus;
  reason?: InvalidReason;
  detail?: string;
  /** Review-worthy, non-disqualifying (statement_leak:*, clarity:*, …). */
  flags: string[];
  /** Tests moved to quarantine by this run (mixed outcomes across rounds). */
  quarantined: QuarantineEntry[];
  /** Captured pre-patch on a green run; written back into the task file so
   * future runs replay identically. Never set on invalid tasks. */
  determinism?: TaskDeterminism;
  env?: { key: string; imageRef: string; built: boolean };
  runs?: {
    f2pPreGold: TestRunEvidence;
    f2pWithGold: TestRunEvidence;
    passToPass: TestRunEvidence;
  };
  timings: PhaseTiming;
}

export interface TaskValidationReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  startedAt: string;
  finishedAt: string;
  provider: string;
  flakeRounds: number;
  tasks: TaskReportEntry[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    needsReview: number;
    byReason: Partial<Record<InvalidReason, number>>;
  };
}

export function summarize(
  entries: TaskReportEntry[],
): TaskValidationReport["summary"] {
  const byReason: Partial<Record<InvalidReason, number>> = {};
  let valid = 0;
  let invalid = 0;
  let needsReview = 0;
  for (const entry of entries) {
    if (entry.status === "valid") valid += 1;
    else if (entry.status === "needs_review") needsReview += 1;
    else {
      invalid += 1;
      if (entry.reason) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
    }
  }
  return { total: entries.length, valid, invalid, needsReview, byReason };
}

const STATUS_GLYPH: Record<TaskStatus, string> = {
  valid: "✓",
  invalid: "✗",
  needs_review: "⚠",
};

/** Compact terminal rendering — the `outerlayer eval validate` output shape. */
export function renderReportText(report: TaskValidationReport): string {
  const lines: string[] = [];
  lines.push(
    `task validation — provider=${report.provider} rounds=${report.flakeRounds} tasks=${report.summary.total}`,
  );
  lines.push("");
  for (const entry of report.tasks) {
    const head = `${STATUS_GLYPH[entry.status]} ${entry.taskId}  [${entry.status}${entry.reason ? `: ${entry.reason}` : ""}]`;
    lines.push(head);
    if (entry.detail) lines.push(`    ${entry.detail}`);
    if (entry.env) {
      lines.push(
        `    env ${entry.env.key} (${entry.env.built ? "built" : "cache hit"})  env ${entry.timings.envMs}ms · gate ${entry.timings.gateMs}ms`,
      );
    }
    if (entry.determinism) {
      const parts: string[] = [];
      if (entry.determinism.image_digest) {
        parts.push(`digest ${entry.determinism.image_digest.slice(0, 19)}…`);
      }
      const lockfiles = Object.keys(entry.determinism.lockfile_hashes ?? {}).length;
      if (lockfiles > 0) parts.push(`${lockfiles} lockfile hash${lockfiles === 1 ? "" : "es"}`);
      lines.push(`    pinned: ${parts.join(" · ")}`);
    }
    for (const flag of entry.flags) lines.push(`    ⚑ ${flag}`);
    for (const quarantine of entry.quarantined) {
      lines.push(`    ⛔ quarantined ${quarantine.id} — ${quarantine.reason} (${quarantine.evidence})`);
    }
  }
  lines.push("");
  const { summary } = report;
  lines.push(
    `${summary.valid} valid · ${summary.invalid} invalid · ${summary.needsReview} needs_review`,
  );
  const reasons = Object.entries(summary.byReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  if (reasons) lines.push(`rejections: ${reasons}`);
  return lines.join("\n");
}
