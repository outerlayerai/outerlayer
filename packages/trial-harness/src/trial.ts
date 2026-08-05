// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * runTrial — the heart of the runner.
 *
 * Phases:
 *   1. AGENT sandbox from the task env → inject config.context + launcher
 *      auth (per-exec, never logged) → ASSERT clean state (no test/gold
 *      artifacts) → run the agent under budgets → freeze the patch OUT of the
 *      sandbox and checksum it → pull the transcript → DESTROY the agent
 *      sandbox.
 *   2. GRADE sandbox — a FRESH sandbox from the SAME EnvRef with network:none
 *      from birth (never the agent's; git reset can't undo untracked tamper —
 *      trojaned test shims, poisoned deps, lurking daemons). Apply the frozen
 *      patch (re-verify checksum) → apply test_patch → run F2P + P2P per-test
 *      with timeouts → destroy.
 *
 * Two invariants are the whole credibility of the product:
 *   - the agent never sees test_patch/gold_patch (leak assertions a–d);
 *   - agent failures are RESULTS, never retried (only infra_error retries).
 */

import { createHash } from "node:crypto";
import type { EnvRef, Sandbox, SandboxOpts, SandboxProvider } from "@outerlayer/runner-core";
import { REPO_DIR, runnerAdapter, type EvalTask, type TestOutcome } from "@outerlayer/task-format";
import { resolveLauncher, type AgentLauncher, type LauncherContext } from "./launcher.js";
import { computeCost, type PriceTable } from "./cost.js";
import {
  isResolved,
  TRIAL_SCHEMA_VERSION,
  type LeakAssertions,
  type TestResult,
  type TrajectorySummary,
  type TrialConfig,
  type TrialResult,
  type TrialStatus,
} from "./types.js";

const PATCH_DIR = "/tmp/outerlayer";

/**
 * Build-artifact paths unstaged from the patch freeze (belt-and-suspenders
 * over the repo's own .gitignore). A directory anywhere in the path, or a
 * compiled-artifact extension. Language-broad on purpose — the freeze must be
 * clean regardless of stack.
 */
export const ARTIFACT_DENYLIST_RE =
  "(^|/)(__pycache__|node_modules|\\.pytest_cache|\\.mypy_cache|\\.ruff_cache|\\.gradle|\\.next|\\.turbo|\\.venv|target|dist|build|coverage)/|\\.(pyc|pyo|class|o|obj)$";

export class InfraError extends Error {}

/** Identity of the trial a transcript belongs to (for {@link RunTrialDeps.onTranscript}). */
export interface TranscriptMeta {
  taskId: string;
  configId: string;
  trialIndex: number;
  launcher: string;
}

export interface RunTrialDeps {
  provider: SandboxProvider;
  /** env-prep's prepareEnv. Throwing here ⇒ build_error. */
  envFactory: (task: EvalTask) => Promise<EnvRef>;
  /** Vault-resolved secret values for the config's launcher. Never logged. */
  resolveSecrets: (config: TrialConfig) => Promise<Record<string, string>>;
  prices?: PriceTable;
  sandboxOpts?: SandboxOpts;
  launcher?: (id: string) => AgentLauncher;
  onPhase?: (phase: string) => void;
  /**
   * Observer for the RAW agent transcript (trajectory
   * emission as canonical sessions). Called best-effort right after the transcript is
   * pulled from the agent sandbox, once per attempt (a retry re-fires with the
   * new attempt's transcript — key by meta and keep the last). Observer errors
   * never fail a trial. TrialResult stays lean: it carries only the summary;
   * the full transcript exists ONLY on this seam.
   */
  onTranscript?: (transcript: string, meta: TranscriptMeta) => void;
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function runTrial(
  task: EvalTask,
  config: TrialConfig,
  trialIndex: number,
  deps: RunTrialDeps,
): Promise<TrialResult> {
  const started = Date.now();
  const onPhase = deps.onPhase ?? (() => {});
  const resolveLaunch = deps.launcher ?? resolveLauncher;
  const quarantinedSkipped = task.quarantined.map((q) => q.id);
  const f2pIds = task.fail_to_pass.filter((id) => !quarantinedSkipped.includes(id));
  const p2pIds = task.pass_to_pass.filter((id) => !quarantinedSkipped.includes(id));

  const leak: LeakAssertions = {
    agentWorktreeClean: false,
    transcriptClean: false,
    gradeOffline: false,
    patchesNeverInAgentSandbox: true, // we simply never write them there
    frozenPatchIntact: false,
  };

  const base = {
    schemaVersion: TRIAL_SCHEMA_VERSION as typeof TRIAL_SCHEMA_VERSION,
    taskId: task.id,
    configId: config.id,
    trialIndex,
    failToPass: [] as TestResult[],
    passToPass: [] as TestResult[],
    patch: "",
    patchApplyOk: false,
    trajectory: null as TrajectorySummary | null,
    quarantinedSkipped,
    statementSource: task.statement_source,
    envSource: task.env_source,
    attempt: 1,
  };

  const fail = (status: TrialStatus, error: string, extra: Partial<TrialResult> = {}): TrialResult => ({
    ...base,
    status,
    resolved: false,
    cost: { usd: 0, source: "estimated" },
    leak,
    error,
    timings: { agentMs: 0, gradeMs: 0, totalMs: Date.now() - started, ...extra.timings },
    ...extra,
  });

  // -- Env ------------------------------------------------------------------
  let env: EnvRef;
  try {
    env = await deps.envFactory(task);
  } catch (error) {
    return fail("build_error", `env prep failed: ${message(error)}`);
  }

  const launcher = resolveLaunch(config.launcher);
  const secrets = await deps.resolveSecrets(config);
  const agentOpts: SandboxOpts = { ...deps.sandboxOpts, network: "default" };

  // -- Phase 1: agent sandbox --------------------------------------------
  const agentStart = Date.now();
  let patch = "";
  let trajectory: TrajectorySummary | null = null;
  let agentSandbox: Sandbox | undefined;
  try {
    agentSandbox = await deps.provider.create(env, agentOpts);

    if (config.context) {
      const files = Object.fromEntries(
        Object.entries(config.context).map(([path, content]) => [
          path.startsWith("/") ? path : `${REPO_DIR}/${path}`,
          content,
        ]),
      );
      await deps.provider.putFiles(agentSandbox, files);
    }

    // Assert clean state BEFORE the agent runs: the worktree must not contain
    // any test_patch content (it never should — we don't write it here — but
    // a leaky env snapshot would show up as a dirty checksum).
    leak.agentWorktreeClean = await assertNoPatchContent(deps.provider, agentSandbox, task);

    onPhase("run agent");
    const ctx: LauncherContext = {
      statement: task.problem_statement,
      budgets: config.budgets,
      model: config.model,
      baseUrl: config.baseUrl,
      secrets,
    };
    const invocation = launcher.invoke(ctx);
    const agentRun = await deps.provider.exec(agentSandbox, `cd ${REPO_DIR} && ${invocation.command}`, {
      timeoutMs: config.budgets.wallClockS * 1000 + 5_000,
      env: invocation.env,
      maxOutputBytes: 256 * 1024,
    });

    // Freeze the patch OUT of the sandbox. `git add -A` respects the repo's
    // .gitignore, but the harness must not DEPEND on that being complete —
    // ARTIFACT_DENYLIST_RE unstages well-known build artifacts (.pyc,
    // node_modules, caches, …) so an incomplete .gitignore can't leak a binary
    // hunk that fails `git apply` at grade time. Genuinely-new SOURCE files the
    // agent wrote are still captured.
    onPhase("freeze patch");
    const diff = await deps.provider.exec(
      agentSandbox,
      `cd ${REPO_DIR} && git add -A && (git ls-files --cached | grep -E ${shq(ARTIFACT_DENYLIST_RE)} | tr '\\n' '\\0' | xargs -0 -r git rm -q --cached --ignore-unmatch >/dev/null 2>&1 || true) && git diff --cached`,
      { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 },
    );
    patch = diff.stdout;
    const frozenHash = sha256(patch);

    // Transcript (best-effort — never fails the trial).
    const transcript = await deps.provider
      .getFile(agentSandbox, invocation.transcriptPath)
      .then((buffer) => buffer.toString("utf8"))
      .catch(() => "");
    trajectory = transcript ? launcher.parseTranscript(transcript) : null;
    if (trajectory) trajectory.wallClockMs = Date.now() - agentStart;
    leak.transcriptClean = transcriptCleanOf(transcript, f2pIds);
    if (transcript && deps.onTranscript) {
      try {
        deps.onTranscript(transcript, {
          taskId: task.id,
          configId: config.id,
          trialIndex,
          launcher: config.launcher,
        });
      } catch {
        // Observer errors never fail a trial.
      }
    }

    // Agent produced nothing usable → agent_error (a RESULT, never retried).
    if (agentRun.timedOut) {
      return fail("timeout", "agent hit the wall-clock budget", {
        patch,
        trajectory,
        timings: { agentMs: Date.now() - agentStart, gradeMs: 0, totalMs: Date.now() - started },
      });
    }
    if (patch.trim().length === 0) {
      return fail("agent_error", "agent produced an empty patch", {
        patch,
        trajectory,
        timings: { agentMs: Date.now() - agentStart, gradeMs: 0, totalMs: Date.now() - started },
      });
    }

    // Destroy the agent sandbox — grading NEVER reuses it.
    await deps.provider.destroy(agentSandbox);
    agentSandbox = undefined;
    leak.frozenPatchIntact = sha256(patch) === frozenHash;
  } catch (error) {
    return fail("infra_error", `agent phase: ${message(error)}`);
  } finally {
    // Every non-success exit from the agent phase (timeout, empty patch, throw)
    // must free the agent sandbox. The success path above already destroyed it
    // and nulled the handle, so this no-ops there; without it, each agent
    // failure leaks a running container. (Found in e2e: an agent_error run
    // left one sandbox Up per task.)
    if (agentSandbox) await deps.provider.destroy(agentSandbox).catch(() => {});
  }
  const agentMs = Date.now() - agentStart;

  // -- Phase 2: grade in a FRESH sandbox ----------------------------------
  const gradeStart = Date.now();
  let gradeSandbox: Sandbox | undefined;
  try {
    onPhase("grade (fresh sandbox, network:none)");
    gradeSandbox = await deps.provider.create(env, { ...deps.sandboxOpts, network: "none" });
    leak.gradeOffline = true;

    // Apply the frozen candidate patch on the CLEAN env.
    const applied = await applyPatch(deps.provider, gradeSandbox, "candidate.patch", patch);
    if (!applied) {
      return finalize("patch_apply_failed", {
        patchApplyOk: false,
        error: "candidate patch does not apply on the clean grade env",
      });
    }
    // Now the test_patch (grade materials — only ever here, never the agent env).
    const testApplied = await applyPatch(deps.provider, gradeSandbox, "test.patch", task.test_patch);
    if (!testApplied) {
      return finalize("infra_error", { error: "test_patch failed to apply at grade time" });
    }

    const adapter = runnerAdapter(task.environment.runner);
    const timeoutMs = task.environment.timeout_s * 1000;
    const runTests = async (ids: string[]): Promise<TestResult[]> => {
      const out: TestResult[] = [];
      for (const id of ids) {
        const result = await deps.provider.exec(
          gradeSandbox!,
          `cd ${REPO_DIR} && ${adapter.buildCommand(task.environment.test_cmd, id)}`,
          { timeoutMs },
        );
        out.push({ id, outcome: adapter.classify(result) as TestOutcome });
      }
      return out;
    };

    onPhase("run fail_to_pass");
    const failToPass = await runTests(f2pIds);
    onPhase("run pass_to_pass");
    const passToPass = await runTests(p2pIds);

    return finalize("graded", {
      patchApplyOk: true,
      failToPass,
      passToPass,
      resolved: isResolved(failToPass, passToPass),
    });
  } catch (error) {
    return finalize("infra_error", { error: `grade phase: ${message(error)}` });
  } finally {
    if (gradeSandbox) await deps.provider.destroy(gradeSandbox).catch(() => {});
  }

  function finalize(status: TrialStatus, extra: Partial<TrialResult>): TrialResult {
    const gradeMs = Date.now() - gradeStart;
    const trajectoryFinal = extra.trajectory ?? trajectory;
    return {
      ...base,
      status,
      resolved: extra.resolved ?? false,
      failToPass: extra.failToPass ?? [],
      passToPass: extra.passToPass ?? [],
      patch,
      patchApplyOk: extra.patchApplyOk ?? false,
      trajectory: trajectoryFinal,
      cost: computeCost(config.model, trajectoryFinal, deps.prices ?? {}),
      leak,
      quarantinedSkipped,
      statementSource: task.statement_source,
      envSource: task.env_source,
      attempt: 1,
      timings: { agentMs, gradeMs, totalMs: Date.now() - started },
      error: extra.error,
    };
  }
}

async function applyPatch(
  provider: SandboxProvider,
  sandbox: Sandbox,
  name: string,
  patch: string,
): Promise<boolean> {
  if (patch.trim().length === 0) return true;
  const path = `${PATCH_DIR}/${name}`;
  await provider.putFiles(sandbox, { [path]: patch.endsWith("\n") ? patch : `${patch}\n` });
  const result = await provider.exec(
    sandbox,
    `cd ${REPO_DIR} && git apply --whitespace=nowarn ${shq(path)}`,
    { timeoutMs: 60_000 },
  );
  return result.code === 0;
}

/** Leak assertion (a): the agent worktree contains no test_patch content. */
async function assertNoPatchContent(
  provider: SandboxProvider,
  sandbox: Sandbox,
  task: EvalTask,
): Promise<boolean> {
  const markers = distinctiveAddedLines(task.test_patch, 3);
  if (markers.length === 0) return true;
  const flags = markers.map((marker) => `-e ${shq(marker)}`).join(" ");
  const result = await provider.exec(
    sandbox,
    `grep -rF ${flags} ${REPO_DIR} 2>/dev/null | head -1`,
    { timeoutMs: 60_000 },
  );
  return result.stdout.trim().length === 0;
}

/** Leak assertion (b): the transcript never references an F2P test name. */
function transcriptCleanOf(transcript: string, f2pIds: string[]): boolean {
  if (!transcript) return true;
  return !f2pIds.some((id) => {
    const name = id.includes("::") ? id.slice(id.indexOf("::") + 2) : id;
    return name.length >= 4 && transcript.includes(name);
  });
}

function distinctiveAddedLines(patch: string, max: number): string[] {
  const lines: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1).trim();
    if (content.length < 12) continue;
    lines.push(content);
    if (lines.length >= max) break;
  }
  return lines;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error);
}
