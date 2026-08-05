// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Injection proposal + structural validation (step 1).
 *
 * The safety property that makes synthetic tasks trustworthy is enforced
 * STRUCTURALLY, not by trusting the model: an injection may never edit a test
 * file. If it could, the "gold_patch = revert" story would let grade materials
 * and agent-visible code share files (the gate's `patch_overlap` leak vector). We
 * reject any injection whose diff touches a test path, creates/deletes files,
 * exceeds the diff budget, or names no existing test to break — before it can
 * become a task.
 */

import { parseUnifiedDiff } from "@outerlayer/task-format";
import { changedLineCount } from "./diff.js";
import type { BugInjection, ModuleCandidate, ModuleEnumerator, InjectionModel } from "./types.js";

/** Default ceiling on how many `+`/`-` lines one injection may change. */
export const DEFAULT_MAX_CHANGED_LINES = 20;

export type InjectionRejectionReason =
  | "not_a_diff"
  | "touches_test_file"
  | "creates_or_deletes_file"
  | "diff_too_large"
  | "no_target_tests";

export interface InjectionRejection {
  ok: false;
  reason: InjectionRejectionReason;
  detail: string;
}

export type InjectionCheck = { ok: true } | InjectionRejection;

/**
 * Default test-path heuristic across pytest / jest / vitest layouts:
 * `tests/`, `test/`, `__tests__/`, `spec/` directories; `*.test.*` /
 * `*.spec.*`; `test_*.py`, `*_test.py`, `conftest.py`.
 */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|(^|\/)conftest\.py$/i;

export function defaultIsTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

export interface ValidateInjectionOptions {
  isTestPath?: (path: string) => boolean;
  maxChangedLines?: number;
}

/**
 * Structurally validate a proposed injection. Returns `{ ok: true }` only for
 * a bounded, modify-only, source-only diff that names at least one existing
 * test to break.
 */
export function validateInjection(
  injection: BugInjection,
  options: ValidateInjectionOptions = {},
): InjectionCheck {
  const isTestPath = options.isTestPath ?? defaultIsTestPath;
  const maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;

  const parsed = parseUnifiedDiff(injection.patch);
  if (!parsed.ok) {
    return { ok: false, reason: "not_a_diff", detail: parsed.error ?? "unparseable patch" };
  }

  const testFiles = parsed.files.filter((file) => isTestPath(file));
  if (testFiles.length > 0) {
    return {
      ok: false,
      reason: "touches_test_file",
      detail: `injection touches test path(s): ${testFiles.join(", ")}`,
    };
  }

  // Modify-only: a synthetic bug is an in-place regression in tested code, not
  // a new or deleted file (which would also dodge the revert story).
  if (/^\+\+\+ \/dev\/null/m.test(injection.patch) || /^--- \/dev\/null/m.test(injection.patch)) {
    return {
      ok: false,
      reason: "creates_or_deletes_file",
      detail: "injection must modify existing source in place (no file create/delete)",
    };
  }

  const changed = changedLineCount(injection.patch);
  if (changed > maxChangedLines) {
    return {
      ok: false,
      reason: "diff_too_large",
      detail: `${changed} changed lines exceeds max ${maxChangedLines}`,
    };
  }

  if (injection.breaksTests.length === 0) {
    return {
      ok: false,
      reason: "no_target_tests",
      detail: "injection names no existing tests to break (nothing to grade)",
    };
  }

  return { ok: true };
}

/**
 * A deterministic `InjectionModel` for tests: `respond` maps a candidate to
 * its scripted injections (the real model is a BYO-key LLM behind the seam).
 */
export class ScriptedInjectionModel implements InjectionModel {
  constructor(private readonly respond: (candidate: ModuleCandidate) => BugInjection[]) {}

  async propose(candidate: ModuleCandidate): Promise<BugInjection[]> {
    return this.respond(candidate);
  }
}

/** A `ModuleEnumerator` that yields a fixed candidate list (tests / dry runs). */
export function staticModuleEnumerator(candidates: ModuleCandidate[]): ModuleEnumerator {
  return {
    async enumerate() {
      return candidates;
    },
  };
}
