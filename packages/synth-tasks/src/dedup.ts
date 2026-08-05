// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Dedup (step 6). Different injections often break the SAME existing tests
 * (e.g. two ways to corrupt the same boundary). From a grading standpoint they
 * are one task — the same failing-test signature — so we collapse them,
 * keeping the first deterministically.
 */

import type { EvalTask } from "@outerlayer/task-format";
import type { BuiltSyntheticTask } from "./task.js";

/** The clustering signature: the sorted set of failing (fail_to_pass) tests. */
export function failureSignature(task: EvalTask): string {
  return [...task.fail_to_pass].sort().join("|");
}

/** Collapse tasks that share a failing-test signature; first occurrence wins. */
export function dedupeSynthetic(items: BuiltSyntheticTask[]): BuiltSyntheticTask[] {
  const seen = new Set<string>();
  const unique: BuiltSyntheticTask[] = [];
  for (const item of items) {
    const signature = failureSignature(item.task);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(item);
  }
  return unique;
}
