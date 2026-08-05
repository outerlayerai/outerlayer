// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The synthesizer end-to-end (steps 1–6):
 *
 *   enumerate modules → propose injections → structurally reject test-touchers
 *   → generate a leak-scrubbed statement (+ optional judge spot-check)
 *   → commit the injected state (throwaway ref) → build the inverted task
 *   → validate the inversion via the task-format gate MECHANICS → dedup → calibrate band.
 *
 * Every seam that touches infrastructure (enumerator, injection model, injected
 * ref, inversion gate, reference resolve rate, judge) is injectable, so the
 * whole pipeline runs hermetically with fakes.
 *
 * ## Inversion ↔ gate mapping
 * The task-format gate runs: apply `test_patch` → every fail_to_pass FAILS → apply
 * `gold_patch` → fail_to_pass PASS, pass_to_pass PASS → snapshot leak check.
 * For a synthetic task the fail_to_pass tests already exist at `base_commit`
 * (the injected state) and fail there because the bug is present; the sentinel
 * `test_patch` adds only a throwaway marker, so the pre-gold phase sees the
 * same FAIL. The `gold_patch` (the revert) removes the bug, so fail_to_pass and
 * pass_to_pass go green. The one gate assumption this leans on: `test_patch` must
 * be a non-empty, parseable unified diff (a literally-empty one is not
 * expressible), which the sentinel satisfies without touching any test/source.
 */

import { validateTask, type EvalTask, type TaskEnvironment } from "@outerlayer/task-format";
import type { EnvRef, SandboxProvider } from "@outerlayer/runner-core";
import { EnvPrepService } from "@outerlayer/env-prep";
import { validateInjection, type InjectionRejectionReason } from "./injection.js";
import { generateProblemStatement, type LeakSpotCheck, type LeakTargets, type StatementInputs } from "./statement.js";
import { buildSyntheticTask, type BuiltSyntheticTask } from "./task.js";
import { dedupeSynthetic } from "./dedup.js";
import { calibrateDifficulty, type BandThresholds, type DiscardedTask } from "./calibration.js";
import type { BugInjection, InjectionModel, ModuleCandidate, ModuleEnumerator, SyntheticTaskMeta } from "./types.js";

/** Default ceiling on a judge's bug-location probability before we scrap the task. */
export const DEFAULT_MAX_LOCATE_PROBABILITY = 0.5;

export interface InversionResult {
  ok: boolean;
  /** Rejection reason when `ok` is false (e.g. a gate InvalidReason). */
  reason?: string;
  detail?: string;
}

export type RejectionReason = InjectionRejectionReason | "statement_leak" | "inversion_failed" | string;

export interface RejectedInjection {
  path: string;
  function: string;
  injectionClass: BugInjection["injectionClass"];
  reason: RejectionReason;
  detail: string;
}

export interface SynthesizeOptions {
  repo: string;
  /** The qualified env for the repo's PASSING state (from env-prep). */
  env: EnvRef;
  provider: SandboxProvider;
  /** The repo's env block, copied onto every synthetic task. */
  environment: TaskEnvironment;
  enumerator: ModuleEnumerator;
  injectionModel: InjectionModel;
  /** Commit an injection to a throwaway ref; returns the `base_commit`. */
  commitInjection: (injection: BugInjection) => Promise<string> | string;
  /** Reference-config resolve rate per task (calibration seam). */
  resolveRateOf: (task: EvalTask) => Promise<number> | number;
  generatorVersion: string;
  /** Override the inversion gate; default replays the task-format gate on the injected env. */
  validateInversion?: (task: EvalTask, injection: BugInjection) => Promise<InversionResult> | InversionResult;
  /** Build the statement inputs; default uses the injection symptom + broken tests. */
  statementInputsFor?: (candidate: ModuleCandidate, injection: BugInjection) => StatementInputs;
  /** Sample the pass_to_pass set; default draws from OTHER candidates' tests. */
  passToPassFor?: (
    candidate: ModuleCandidate,
    candidates: ModuleCandidate[],
    injection: BugInjection,
  ) => string[];
  isTestPath?: (path: string) => boolean;
  maxChangedLines?: number;
  band?: BandThresholds;
  /** Optional judge: reject a task whose bug is locatable from the statement. */
  spotCheck?: LeakSpotCheck;
  maxLocateProbability?: number;
}

export interface SynthesizeResult {
  tasks: EvalTask[];
  /** Side metadata aligned 1:1 with `tasks` (never merged into the schema). */
  meta: SyntheticTaskMeta[];
  rejected: RejectedInjection[];
  discardedByBand: DiscardedTask[];
}

/** Replay the task-format gate over a synthetic task with the injected env as `envFactory`. */
export async function gateInversion(
  task: EvalTask,
  opts: { provider: SandboxProvider; envFactory: (task: EvalTask) => Promise<EnvRef> },
): Promise<InversionResult> {
  const entry = await validateTask(task, { provider: opts.provider, envFactory: opts.envFactory });
  if (entry.status === "invalid") {
    return { ok: false, reason: entry.reason, detail: entry.detail };
  }
  return { ok: true };
}

/** Default inversion gate: the injected env is reused for the task's build. */
export function defaultValidateInversion(
  provider: SandboxProvider,
  env: EnvRef,
): (task: EvalTask) => Promise<InversionResult> {
  return (task) => gateInversion(task, { provider, envFactory: async () => env });
}

function defaultPassToPass(
  candidate: ModuleCandidate,
  candidates: ModuleCandidate[],
  injection: BugInjection,
): string[] {
  const broken = new Set(injection.breaksTests);
  const others = candidates
    .filter((other) => other.path !== candidate.path)
    .flatMap((other) => other.coveringTests);
  const pool = (others.length > 0 ? others : candidate.coveringTests).filter(
    (testId) => !broken.has(testId),
  );
  return [...new Set(pool)].slice(0, 10);
}

export async function synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
  const rejected: RejectedInjection[] = [];
  const built: BuiltSyntheticTask[] = [];
  const validateInversion =
    options.validateInversion ?? defaultValidateInversion(options.provider, options.env);
  const maxLocate = options.maxLocateProbability ?? DEFAULT_MAX_LOCATE_PROBABILITY;

  const candidates = await options.enumerator.enumerate(options.env, options.provider);
  for (const candidate of candidates) {
    const injections = await options.injectionModel.propose(candidate);
    for (const injection of injections) {
      const base = {
        path: injection.path,
        function: injection.function,
        injectionClass: injection.injectionClass,
      };

      // Step 1 (structural): reject test-file edits / oversized / no-target.
      const check = validateInjection(injection, {
        isTestPath: options.isTestPath,
        maxChangedLines: options.maxChangedLines,
      });
      if (!check.ok) {
        rejected.push({ ...base, reason: check.reason, detail: check.detail });
        continue;
      }

      // Step 3: leak-scrubbed statement + optional judge spot-check.
      const targets: LeakTargets = { functionName: injection.function, filePath: injection.path };
      const statementInputs =
        options.statementInputsFor?.(candidate, injection) ??
        ({ symptom: injection.symptom, failingTests: injection.breaksTests } satisfies StatementInputs);
      const problemStatement = generateProblemStatement(statementInputs, targets);
      if (options.spotCheck) {
        const locateProbability = await options.spotCheck.locate(problemStatement, targets);
        if (locateProbability > maxLocate) {
          rejected.push({
            ...base,
            reason: "statement_leak",
            detail: `judge can locate the bug from the statement (p=${locateProbability})`,
          });
          continue;
        }
      }

      // Step 2: injected ref → build the inverted task.
      const baseCommit = await options.commitInjection(injection);
      const passToPass = (options.passToPassFor ?? defaultPassToPass)(candidate, candidates, injection);
      const builtTask = buildSyntheticTask(injection, {
        repo: options.repo,
        baseCommit,
        environment: options.environment,
        passToPass,
        problemStatement,
        generatorVersion: options.generatorVersion,
      });

      // Step 2 (validation inversion): the task-format gate with inverted roles.
      const inversion = await validateInversion(builtTask.task, injection);
      if (!inversion.ok) {
        rejected.push({
          ...base,
          reason: inversion.reason ?? "inversion_failed",
          detail: inversion.detail ?? "inversion gate rejected the task",
        });
        continue;
      }

      built.push(builtTask);
    }
  }

  // Step 6: dedup, then Step 5: difficulty band.
  const deduped = dedupeSynthetic(built);
  const calibration = await calibrateDifficulty(deduped, {
    resolveRateOf: options.resolveRateOf,
    ...(options.band ?? {}),
  });

  return {
    tasks: calibration.kept.map((entry) => entry.task),
    meta: calibration.kept.map((entry) => entry.meta),
    rejected,
    discardedByBand: calibration.discarded,
  };
}

/**
 * Convenience: obtain the qualified env for a repo's PASSING state via env-prep.
 * Synthetic injection then happens against this env's checkout (throwaway ref).
 */
export function qualifiedEnv(service: EnvPrepService, passingTask: EvalTask): Promise<EnvRef> {
  return service.prepareEnv(passingTask);
}
