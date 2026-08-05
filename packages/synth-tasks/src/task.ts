// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Task assembly — the inversion made concrete (steps 2 & 4).
 *
 * `buildSyntheticTask` maps an injection onto an `EvalTask` with the roles
 * inverted from the mining direction:
 *
 *   base_commit  = the injected (broken) throwaway ref
 *   gold_patch   = invertUnifiedDiff(injection.patch)   (the revert)
 *   fail_to_pass = injection.breaksTests                (pre-existing tests)
 *   test_patch   = noopTestPatch(id)                    (sentinel, see diff.ts)
 *   provenance   = 'synthetic'
 *
 * Extra metadata (generator version, injection class, symptom) is returned in
 * a SIDE `SyntheticTaskMeta`, never stamped onto the shared task schema.
 */

import { createHash } from "node:crypto";
import { TASK_SCHEMA_VERSION, type EvalTask, type TaskEnvironment } from "@outerlayer/task-format";
import { invertUnifiedDiff, noopTestPatch } from "./diff.js";
import type { BugInjection, SyntheticTaskMeta } from "./types.js";

export interface BuildTaskContext {
  repo: string;
  /** The injected (broken) throwaway ref — the task's `base_commit`. */
  baseCommit: string;
  /** The qualified env block (base_image / test_cmd / runner / …). */
  environment: TaskEnvironment;
  /** Unrelated pre-existing tests sampled to stay green (`pass_to_pass`). */
  passToPass: string[];
  /** Already leak-scrubbed problem statement. */
  problemStatement: string;
  generatorVersion: string;
}

export interface BuiltSyntheticTask {
  task: EvalTask;
  meta: SyntheticTaskMeta;
}

/** Deterministic lowercase slug id: `synth-<class>-<hash>` (matches the schema). */
export function syntheticTaskId(injection: BugInjection): string {
  const hash = createHash("sha256")
    .update(`${injection.path}::${injection.function}::${injection.patch}`)
    .digest("hex")
    .slice(0, 10);
  return `synth-${injection.injectionClass.replace(/_/g, "-")}-${hash}`;
}

export function buildSyntheticTask(
  injection: BugInjection,
  ctx: BuildTaskContext,
): BuiltSyntheticTask {
  const id = syntheticTaskId(injection);
  const failToPass = [...new Set(injection.breaksTests)];
  const f2pSet = new Set(failToPass);
  const passToPass = [...new Set(ctx.passToPass)].filter((testId) => !f2pSet.has(testId));

  const task: EvalTask = {
    schema_version: TASK_SCHEMA_VERSION,
    id,
    repo: ctx.repo,
    base_commit: ctx.baseCommit,
    problem_statement: ctx.problemStatement,
    test_patch: noopTestPatch(id),
    gold_patch: invertUnifiedDiff(injection.patch),
    fail_to_pass: failToPass,
    pass_to_pass: passToPass,
    environment: ctx.environment,
    quarantined: [],
    provenance: "synthetic",
  };

  const meta: SyntheticTaskMeta = {
    taskId: id,
    generatorVersion: ctx.generatorVersion,
    injectionClass: injection.injectionClass,
    targetPath: injection.path,
    targetFunction: injection.function,
    symptom: injection.symptom,
  };

  return { task, meta };
}
