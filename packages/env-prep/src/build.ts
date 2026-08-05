// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The deterministic build path: materialize repo @ base_commit →
 * run setup → source guard → health probe → the provider snapshots under the
 * content-addressed key. Failures throw a typed, staged error the repair
 * ladder can reason about.
 *
 * Source guard: setup runs arbitrary shell (that's its job — installers,
 * codegen), but it must NOT modify tracked repo source. `git status
 * --porcelain -uno` must come back empty after setup — this is what makes
 * the repair ladder's "edits ONLY setup steps" promise STRUCTURAL: the
 * repair model only ever emits a setup script, and any setup that touches
 * source is rejected here regardless of who wrote it.
 */

import type { EnvRef, ExecResult, Sandbox, SandboxProvider } from "@outerlayer/runner-core";
import { REPO_DIR, runnerAdapter, type EvalTask } from "@outerlayer/task-format";
import { envKeyForTask } from "./key.js";

export type BuildStage = "materialize" | "setup" | "source_guard" | "probe";

export class EnvBuildError extends Error {
  constructor(
    readonly stage: BuildStage,
    readonly excerpt: string,
  ) {
    super(`[${stage}] ${excerpt}`);
    this.name = "EnvBuildError";
  }
}

export type MaterializeRepo = (
  sandbox: Sandbox,
  provider: SandboxProvider,
  task: EvalTask,
) => Promise<void>;

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function excerptOf(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim().replace(/\s+/g, " ");
  return text.slice(0, 300) || `exit code ${result.code}`;
}

/** Default materializer: full clone + checkout. A host-side bare-repo cache
 * is a possible cold-build optimization, but it needs a volume concept the
 * runner-core interface deliberately doesn't have — the snapshot cache already
 * reduces clones to once per (repo, commit, setup, image). */
export function cloneMaterializer(): MaterializeRepo {
  return async (sandbox, provider, task) => {
    const result = await provider.exec(
      sandbox,
      `git clone --quiet ${shq(task.repo)} ${REPO_DIR} && cd ${REPO_DIR} && git checkout --quiet ${shq(task.base_commit)}`,
      { timeoutMs: 600_000 },
    );
    if (result.code !== 0) {
      throw new EnvBuildError("materialize", excerptOf(result));
    }
  };
}

export interface BuildEnvOptions {
  provider: SandboxProvider;
  materializeRepo?: MaterializeRepo;
  /** Override the task's setup (repair attempts build under their own key). */
  setup?: string;
  setupTimeoutMs?: number;
  probeTimeoutMs?: number;
  onPhase?: (taskId: string, phase: string) => void;
}

export interface BuildResult {
  env: EnvRef;
  /** Wall-clock of the probe inside the build (0 on cache hit). */
  probeMs: number;
}

export async function buildTaskEnv(task: EvalTask, options: BuildEnvOptions): Promise<BuildResult> {
  const setup = options.setup ?? task.environment.setup;
  const materialize = options.materializeRepo ?? cloneMaterializer();
  const onPhase = options.onPhase ?? (() => {});
  let probeMs = 0;

  const env = await options.provider.prepareEnv({
    key: envKeyForTask(task, setup),
    baseImage: task.environment.base_image,
    build: async (sandbox, provider) => {
      onPhase(task.id, "materialize repo");
      await materialize(sandbox, provider, task);

      if (setup.trim().length > 0) {
        onPhase(task.id, "run setup");
        const result = await provider.exec(sandbox, `cd ${REPO_DIR} && ${setup}`, {
          timeoutMs: options.setupTimeoutMs ?? 900_000,
        });
        if (result.code !== 0) {
          throw new EnvBuildError("setup", excerptOf(result));
        }
      }

      onPhase(task.id, "source guard");
      const guard = await provider.exec(
        sandbox,
        `cd ${REPO_DIR} && git status --porcelain -uno 2>/dev/null || echo __no_git__`,
        { timeoutMs: 60_000 },
      );
      const guardOut = guard.stdout.trim();
      if (guardOut !== "" && guardOut !== "__no_git__") {
        throw new EnvBuildError(
          "source_guard",
          `setup modified tracked source files: ${guardOut.split("\n").slice(0, 5).join("; ").slice(0, 240)}`,
        );
      }

      onPhase(task.id, "health probe");
      const adapter = runnerAdapter(task.environment.runner);
      const probeStart = Date.now();
      const probe = await provider.exec(
        sandbox,
        `cd ${REPO_DIR} && ${adapter.probeCommand(task.environment.test_cmd)}`,
        { timeoutMs: options.probeTimeoutMs ?? 300_000 },
      );
      probeMs = Date.now() - probeStart;
      // "No tests collected" is a HEALTHY env (graded tests arrive via
      // test_patch at grade time) — only genuine import/config breakage
      // escalates. The runner adapter owns that distinction.
      if (!adapter.probeHealthy(probe)) {
        throw new EnvBuildError("probe", excerptOf(probe));
      }
    },
  });

  return { env, probeMs };
}
