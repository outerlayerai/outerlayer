// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Static lints — the cheap checks that run before any sandbox is built.
 *
 * `errors` are disqualifying (the execution gate is skipped); `flags` mark
 * the task `needs_review` per the SWE-bench-Verified lesson: execution-valid
 * ≠ usable, but humans decide, we never auto-reject on a heuristic.
 */

import { parseUnifiedDiff } from "./diff.js";
import type { EvalTask } from "./schema.js";

export interface LintResult {
  /** Disqualifying — task is invalid, execution gate skipped. */
  errors: { reason: "patch_overlap"; detail: string }[];
  /** Review-worthy, not disqualifying. */
  flags: string[];
}

/** Definition-introducing tokens in gold-patch added lines: `def x`,
 * `class X`, `function x`, `const x = `, `let x`, `var x`. */
const DEFINITION_PATTERN =
  /(?:^|\s)(?:def|class|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{3,})/g;

export function lintTask(task: EvalTask): LintResult {
  const errors: LintResult["errors"] = [];
  const flags: string[] = [];

  const testPatch = parseUnifiedDiff(task.test_patch);
  const goldPatch = parseUnifiedDiff(task.gold_patch);

  // Overlap = the leak vector: a gold_patch touching a test file (or vice
  // versa) means grade materials and agent-visible code share files.
  const overlap = testPatch.files.filter((file) => goldPatch.files.includes(file));
  if (overlap.length > 0) {
    errors.push({
      reason: "patch_overlap",
      detail: `test_patch and gold_patch both touch: ${overlap.join(", ")}`,
    });
  }

  // Solution leakage: symbols the gold patch DEFINES that the statement
  // names verbatim suggest the statement describes the fix, not the problem.
  const definedSymbols = new Set<string>();
  for (const line of goldPatch.addedLines) {
    for (const match of line.matchAll(DEFINITION_PATTERN)) {
      const symbol = match[1];
      if (symbol) definedSymbols.add(symbol);
    }
  }
  for (const symbol of definedSymbols) {
    if (new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(task.problem_statement)) {
      flags.push(`statement_leak:${symbol}`);
    }
  }

  if (task.pass_to_pass.length === 0) {
    flags.push("empty_pass_to_pass");
  }
  const imageTag = task.environment.base_image.split(":")[1];
  if (!imageTag || imageTag === "latest") {
    flags.push("unpinned_base_image");
  }

  return { errors, flags: flags.sort() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
