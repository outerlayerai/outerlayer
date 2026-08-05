// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Core types and seams for the synthesizer.
 *
 * The KEY INSIGHT is the SWE-smith inversion: we do NOT mine bugs from history.
 * We take a repo's PASSING state (the qualified env from env-prep) and INJECT a
 * semantic bug that breaks EXISTING, already-green tests. That inverts every
 * role the task-format gate expects:
 *
 *   - `base_commit`  = the INJECTED (broken) state, on a throwaway ref.
 *   - `gold_patch`   = the REVERT of the injection (restores the passing code).
 *   - `fail_to_pass` = the pre-existing tests the injection breaks.
 *   - `pass_to_pass` = unrelated pre-existing tests that stay green.
 *   - `test_patch`   = a no-op sentinel (the tests already exist at base).
 *
 * These are `provenance: 'synthetic'` — regression-fix tasks on your codebase,
 * NOT feature work — and are never silently merged into a mined headline.
 */

import type { EnvRef, SandboxProvider } from "@outerlayer/runner-core";

/** The semantic bug classes the InjectionModel proposes. */
export type InjectionClass =
  | "off_by_one"
  | "inverted_condition"
  | "dropped_await"
  | "boundary_regression";

export const INJECTION_CLASSES: readonly InjectionClass[] = [
  "off_by_one",
  "inverted_condition",
  "dropped_await",
  "boundary_regression",
];

/**
 * A well-tested, fast module in the qualified env — the injection surface.
 * Enumerated by a `ModuleEnumerator` (tests exist + run fast).
 */
export interface ModuleCandidate {
  /** Repo-relative source file path (the injection target — NEVER a test). */
  path: string;
  /** Function/symbol names in the module that are covered by fast tests. */
  functions: string[];
  /** Existing test ids (`<file>::<name>`) that exercise this module. */
  coveringTests: string[];
  /** Coarse median per-test runtime (ms) — fast modules are preferred. */
  medianTestMs?: number;
}

/**
 * A proposed bug injection for one function. `patch` applied to the ORIGINAL
 * passing source introduces the bug; its revert is the task's `gold_patch`.
 */
export interface BugInjection {
  /** Source file the injection modifies in place. */
  path: string;
  /** The targeted function/symbol. */
  function: string;
  injectionClass: InjectionClass;
  /**
   * Unified diff that, applied to the ORIGINAL passing source, introduces the
   * bug. MUST be modify-only, bounded, and touch NO test files (enforced
   * structurally by `validateInjection`).
   */
  patch: string;
  /** Existing tests expected to FAIL under the injection (→ `fail_to_pass`). */
  breaksTests: string[];
  /**
   * One-line observable symptom for the bug report. MUST describe behavior,
   * never the diff location/content — the statement is leak-scrubbed anyway.
   */
  symptom: string;
}

/**
 * Extra metadata that does NOT belong on the shared `EvalTask` schema. The
 * synthesizer returns this as a SIDE structure so the stats + card layers can render the
 * natural-vs-synthetic split without mutating the task format.
 */
export interface SyntheticTaskMeta {
  taskId: string;
  /** Version of the generator that produced the task (audit trail). */
  generatorVersion: string;
  injectionClass: InjectionClass;
  targetPath: string;
  targetFunction: string;
  symptom: string;
  /** Reference-config resolve rate, once calibrated (step 5). */
  resolveRate?: number;
  /** True when `resolveRate` lands in the target difficulty band. */
  inTargetBand?: boolean;
}

/**
 * Candidate-generation seam (step 1). Enumerates well-tested, fast modules in
 * a qualified env. The default is a live implementation; tests inject a fake.
 */
export interface ModuleEnumerator {
  enumerate(env: EnvRef, provider: SandboxProvider): Promise<ModuleCandidate[]>;
}

/**
 * Injection-proposal seam (step 1). A BYO-key LLM proposes semantic bug
 * injections per function. Tests inject a `ScriptedInjectionModel`.
 */
export interface InjectionModel {
  propose(candidate: ModuleCandidate): Promise<BugInjection[]>;
}
