// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The execution validation gate — no task enters a card
 * without passing it. Encodes the SWE-bench-Verified lesson: execution-valid
 * ≠ usable, so the gate EXECUTES the claim a task makes about itself:
 *
 *   env @ base_commit → apply test_patch → every fail_to_pass FAILS
 *   → apply gold_patch → every fail_to_pass PASSES, pass_to_pass PASSES
 *   → repeat the with-gold rounds (default 3×): mixed outcomes ⇒ quarantine
 *   → fresh sandbox from the env: assert the SNAPSHOT carries no patch
 *     content (the anti-leak invariant — grade materials must never be
 *     baked into agent-visible env state).
 *
 * Gate sandboxes run with network:none — a task whose tests need live
 * network can't grade a trial either (the supported-stack policy), and the
 * gate is where that surfaces as a diagnosis instead of a flaky card.
 *
 * Env building goes through runner-core's `prepareEnv` with a deterministic
 * build callback (clone → checkout → setup). env-prep replaces `envFactory` with the
 * full cache/repair/escalation ladder — same seam, richer implementation.
 */

import { createHash } from "node:crypto";
import type {
  EnvRef,
  ExecResult,
  Sandbox,
  SandboxOpts,
  SandboxProvider,
} from "@outerlayer/runner-core";
import { lintTask } from "./lints.js";
import {
  REPORT_SCHEMA_VERSION,
  summarize,
  type InvalidReason,
  type TaskDeterminism,
  type TaskReportEntry,
  type TaskValidationReport,
  type TestRunEvidence,
} from "./report.js";
import { runnerAdapter, type TestOutcome } from "./runners.js";
import type { EvalTask } from "./schema.js";

/** Repo checkout location inside every sandbox. */
export const REPO_DIR = "/work/repo";
const PATCH_DIR = "/tmp/outerlayer";

export interface ClarityJudge {
  assess(task: EvalTask): Promise<{ sufficiency: number; fairness: number; rationale: string }>;
}

export interface GateOptions {
  provider: SandboxProvider;
  /** Builds/reuses the task env. Default: deterministic clone+setup via
   * `prepareEnv`. env-prep supplies the caching/repair ladder through this seam. */
  envFactory?: (task: EvalTask) => Promise<EnvRef>;
  /** How the repo lands in the build sandbox. Default: `git clone` +
   * checkout of `task.repo`/`task.base_commit`. Tests inject fixtures. */
  materializeRepo?: (sandbox: Sandbox, provider: SandboxProvider, task: EvalTask) => Promise<void>;
  /** With-gold verification rounds; mixed outcomes quarantine (default 3). */
  flakeRounds?: number;
  sandboxOpts?: SandboxOpts;
  /** Optional LLM clarity/fairness judge (BYO key) — flags, never rejects. */
  judge?: ClarityJudge;
  /** Progress callback for CLI rendering. */
  onPhase?: (taskId: string, phase: string) => void;
}

class GateFailure extends Error {
  constructor(
    readonly reason: InvalidReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function taskEnvKey(task: EvalTask): string {
  // Content-addressed env identity. env-prep extends this with lockfile hashes +
  // resolved image digests; the fields here are what the gate can know statically.
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: task.repo,
        commit: task.base_commit,
        setup: task.environment.setup,
        image: task.environment.base_image,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function defaultMaterializeRepo() {
  return async (sandbox: Sandbox, provider: SandboxProvider, task: EvalTask): Promise<void> => {
    const result = await provider.exec(
      sandbox,
      `git clone --quiet ${shq(task.repo)} ${REPO_DIR} && cd ${REPO_DIR} && git checkout --quiet ${shq(task.base_commit)}`,
      { timeoutMs: 600_000 },
    );
    if (result.code !== 0) {
      throw new GateFailure("env_fail", `clone/checkout failed: ${excerpt(result)}`);
    }
  };
}

function defaultEnvFactory(options: GateOptions): (task: EvalTask) => Promise<EnvRef> {
  const materialize = options.materializeRepo ?? defaultMaterializeRepo();
  return async (task) =>
    options.provider.prepareEnv({
      key: taskEnvKey(task),
      baseImage: task.environment.base_image,
      buildOpts: options.sandboxOpts,
      build: async (sandbox, provider) => {
        await materialize(sandbox, provider, task);
        if (task.environment.setup.trim().length > 0) {
          const result = await provider.exec(
            sandbox,
            `cd ${REPO_DIR} && ${task.environment.setup}`,
            { timeoutMs: 900_000 },
          );
          if (result.code !== 0) {
            throw new GateFailure("env_fail", `setup failed: ${excerpt(result)}`);
          }
        }
      },
    });
}

function excerpt(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim().replace(/\s+/g, " ");
  return text.slice(0, 200) || `exit code ${result.code}`;
}

/** Lockfile names whose bytes pin dependency resolution. */
const LOCKFILE_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "requirements*.txt",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
];
const MAX_LOCKFILE_HASHES = 32;

/** Hash every lockfile in the checkout (busybox-compatible pipeline —
 * sandboxes are arbitrary Linux images). Depth-capped for monorepos; vendored
 * trees pruned. */
export function lockfileHashCommand(): string {
  const names = LOCKFILE_PATTERNS.map((pattern) => `-name ${shq(pattern)}`).join(" -o ");
  return (
    `cd ${REPO_DIR} && find . -maxdepth 4 ` +
    `\\( -name node_modules -o -name .git -o -name vendor -o -name .venv \\) -prune ` +
    `-o -type f \\( ${names} \\) -print0 | sort -z | xargs -0 -r sha256sum`
  );
}

/** `sha256sum` lines → { repo-relative path: hash }, capped and order-stable. */
export function parseLockfileHashes(stdout: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (Object.keys(hashes).length >= MAX_LOCKFILE_HASHES) break;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match) continue;
    hashes[match[2]!.replace(/^\.\//, "")] = match[1]!;
  }
  return hashes;
}

/** Capture what makes the env replayable — the base image's
 * resolved digest (when the provider can) and lockfile hashes — from a
 * sandbox still in PRE-PATCH state. Never fails the gate; a capture problem
 * is a flag, not a verdict. */
async function captureDeterminism(
  task: EvalTask,
  sandbox: Sandbox,
  runtime: GateRuntime,
  entry: TaskReportEntry,
): Promise<void> {
  runtime.onPhase(task.id, "determinism capture");
  try {
    const digest = await runtime.provider.resolveImageDigest?.(task.environment.base_image);
    const result = await runtime.provider.exec(sandbox, lockfileHashCommand(), {
      timeoutMs: 120_000,
    });
    const lockfiles = parseLockfileHashes(result.stdout);
    const determinism: TaskDeterminism = {
      ...(digest ? { image_digest: digest } : {}),
      ...(Object.keys(lockfiles).length > 0 ? { lockfile_hashes: lockfiles } : {}),
    };
    if (Object.keys(determinism).length > 0) entry.determinism = determinism;
  } catch (error) {
    entry.flags.push(
      `determinism:capture_failed (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`,
    );
  }
}

/** Distinctive content lines for the snapshot leak grep. */
export function leakMarkers(task: EvalTask, max = 3): string[] {
  const markers: string[] = [];
  for (const patch of [task.test_patch, task.gold_patch]) {
    let taken = 0;
    for (const line of patch.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const content = line.slice(1).trim();
      if (content.length < 12) continue; // too generic to be evidence
      markers.push(content);
      taken += 1;
      if (taken >= max) break;
    }
  }
  return markers;
}

interface GateRuntime extends Required<Pick<GateOptions, "provider" | "flakeRounds">> {
  envFactory: (task: EvalTask) => Promise<EnvRef>;
  sandboxOpts: SandboxOpts;
  judge?: ClarityJudge;
  onPhase: (taskId: string, phase: string) => void;
}

export async function validateTask(
  task: EvalTask,
  options: GateOptions,
): Promise<TaskReportEntry> {
  const runtime: GateRuntime = {
    provider: options.provider,
    envFactory: options.envFactory ?? defaultEnvFactory(options),
    flakeRounds: options.flakeRounds ?? 3,
    sandboxOpts: { ...options.sandboxOpts, network: "none" },
    judge: options.judge,
    onPhase: options.onPhase ?? (() => {}),
  };

  const entry: TaskReportEntry = {
    taskId: task.id,
    status: "valid",
    flags: [],
    quarantined: [],
    timings: { envMs: 0, gateMs: 0 },
  };

  // -- Static lints (no sandbox spend) ------------------------------------
  runtime.onPhase(task.id, "lint");
  const lint = lintTask(task);
  entry.flags.push(...lint.flags);
  const overlap = lint.errors[0];
  if (overlap) {
    entry.status = "invalid";
    entry.reason = overlap.reason;
    entry.detail = overlap.detail;
    return entry;
  }

  // -- Environment ---------------------------------------------------------
  runtime.onPhase(task.id, "env");
  const envStart = Date.now();
  let env: EnvRef;
  try {
    env = await runtime.envFactory(task);
  } catch (error) {
    entry.timings.envMs = Date.now() - envStart;
    entry.status = "invalid";
    if (error instanceof GateFailure) {
      entry.reason = error.reason;
      entry.detail = error.detail;
    } else {
      entry.reason = "env_fail";
      entry.detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    return entry;
  }
  entry.timings.envMs = Date.now() - envStart;
  entry.env = { key: env.key, imageRef: env.imageRef, built: env.built };

  // -- Execution gate --------------------------------------------------------
  const gateStart = Date.now();
  try {
    await runGatePhases(task, env, runtime, entry);
    await runLeakCheck(task, env, runtime);
  } catch (error) {
    if (error instanceof GateFailure) {
      entry.status = "invalid";
      entry.reason = error.reason;
      entry.detail = error.detail;
    } else {
      // Provider/transport trouble is an env problem, not a task verdict.
      entry.status = "invalid";
      entry.reason = "env_fail";
      entry.detail = `provider error: ${error instanceof Error ? error.message.slice(0, 180) : String(error)}`;
    }
  } finally {
    entry.timings.gateMs = Date.now() - gateStart;
  }
  if (entry.status === "invalid") {
    // A determinism block on a rejected task would invite replaying garbage.
    delete entry.determinism;
    return entry;
  }

  // -- Optional clarity judge (flags only, never rejects) -------------------
  if (runtime.judge) {
    runtime.onPhase(task.id, "judge");
    const verdict = await runtime.judge.assess(task);
    if (verdict.sufficiency <= 1) {
      entry.flags.push(`clarity:insufficient_statement (${verdict.rationale.slice(0, 120)})`);
    }
    if (verdict.fairness <= 1) {
      entry.flags.push(`clarity:unfair_tests (${verdict.rationale.slice(0, 120)})`);
    }
  }

  entry.flags.sort();
  if (entry.flags.some((flag) => flag.startsWith("statement_leak:") || flag.startsWith("clarity:"))) {
    entry.status = "needs_review";
  }
  return entry;
}

async function runGatePhases(
  task: EvalTask,
  env: EnvRef,
  runtime: GateRuntime,
  entry: TaskReportEntry,
): Promise<void> {
  const { provider } = runtime;
  const adapter = runnerAdapter(task.environment.runner);
  const timeoutMs = task.environment.timeout_s * 1000;
  const quarantinedIds = new Set(task.quarantined.map((quarantine) => quarantine.id));
  const f2pIds = task.fail_to_pass.filter((id) => !quarantinedIds.has(id));
  const p2pIds = task.pass_to_pass.filter((id) => !quarantinedIds.has(id));
  if (f2pIds.length === 0) {
    throw new GateFailure("flaky_f2p_exhausted", "every fail_to_pass test is quarantined");
  }

  const runs = {
    f2pPreGold: {} as TestRunEvidence,
    f2pWithGold: {} as TestRunEvidence,
    passToPass: {} as TestRunEvidence,
  };
  entry.runs = runs;

  const sandbox = await provider.create(env, runtime.sandboxOpts);
  try {
    // Pre-patch state is the env the block must describe — capture first.
    await captureDeterminism(task, sandbox, runtime, entry);

    const runTest = async (testId: string): Promise<TestOutcome> => {
      const command = `cd ${REPO_DIR} && ${adapter.buildCommand(task.environment.test_cmd, testId)}`;
      return adapter.classify(await provider.exec(sandbox, command, { timeoutMs }));
    };

    // Phase 1: test_patch applied, every F2P must FAIL (pre-gold).
    runtime.onPhase(task.id, "apply test_patch");
    await applyPatch(provider, sandbox, "test.patch", task.test_patch, "test_patch_apply_failed");
    runtime.onPhase(task.id, "fail_to_pass must fail (pre-gold)");
    for (const testId of f2pIds) {
      const outcome = await runTest(testId);
      (runs.f2pPreGold[testId] ??= []).push(outcome);
      if (outcome === "not_found") {
        throw new GateFailure("bad_test_id", `${testId} not found by ${adapter.id}`);
      }
      if (outcome === "pass") {
        throw new GateFailure(
          "f2p_pass_prefix",
          `${testId} already passes before gold_patch — it cannot grade a fix`,
        );
      }
    }

    // Phase 2: gold applied, F2P + P2P over N rounds; mixed ⇒ quarantine.
    runtime.onPhase(task.id, "apply gold_patch");
    await applyPatch(provider, sandbox, "gold.patch", task.gold_patch, "gold_apply_failed");
    for (let round = 0; round < runtime.flakeRounds; round++) {
      runtime.onPhase(task.id, `with-gold round ${round + 1}/${runtime.flakeRounds}`);
      for (const testId of f2pIds) {
        const outcome = await runTest(testId);
        (runs.f2pWithGold[testId] ??= []).push(outcome);
        if (outcome === "not_found") {
          throw new GateFailure("bad_test_id", `${testId} not found by ${adapter.id}`);
        }
      }
      for (const testId of p2pIds) {
        const outcome = await runTest(testId);
        (runs.passToPass[testId] ??= []).push(outcome);
        if (outcome === "not_found") {
          throw new GateFailure("bad_test_id", `${testId} not found by ${adapter.id}`);
        }
      }
    }

    const verdicts = (evidence: TestRunEvidence, testId: string) => {
      const outcomes = evidence[testId] ?? [];
      const passes = outcomes.filter((outcome) => outcome === "pass").length;
      if (passes === outcomes.length) return "stable_pass";
      if (passes === 0) return "stable_fail";
      return "mixed";
    };

    const quarantine = (testId: string, evidence: TestRunEvidence) => {
      entry.quarantined.push({
        id: testId,
        reason: "mixed outcomes across gate rounds",
        evidence: (evidence[testId] ?? []).join(","),
      });
    };

    let f2pStable = 0;
    for (const testId of f2pIds) {
      const verdict = verdicts(runs.f2pWithGold, testId);
      if (verdict === "stable_fail") {
        throw new GateFailure("gold_fails", `${testId} still fails with gold_patch applied`);
      }
      if (verdict === "mixed") quarantine(testId, runs.f2pWithGold);
      else f2pStable += 1;
    }
    if (f2pStable === 0) {
      throw new GateFailure(
        "flaky_f2p_exhausted",
        "no fail_to_pass test survived flake quarantine",
      );
    }
    for (const testId of p2pIds) {
      const verdict = verdicts(runs.passToPass, testId);
      if (verdict === "stable_fail") {
        throw new GateFailure("p2p_fail", `${testId} fails with gold_patch applied`);
      }
      if (verdict === "mixed") quarantine(testId, runs.passToPass);
    }
  } finally {
    await provider.destroy(sandbox);
  }
}

async function applyPatch(
  provider: SandboxProvider,
  sandbox: Sandbox,
  name: string,
  patch: string,
  reason: InvalidReason,
): Promise<void> {
  const path = `${PATCH_DIR}/${name}`;
  await provider.putFiles(sandbox, { [path]: patch.endsWith("\n") ? patch : `${patch}\n` });
  const result = await provider.exec(
    sandbox,
    `cd ${REPO_DIR} && git apply --whitespace=nowarn ${shq(path)}`,
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new GateFailure(reason, excerpt(result));
  }
}

/** The anti-leak invariant: a FRESH sandbox from the env snapshot must
 * contain no patch content — grade materials never bake into agent-visible
 * env state. Mirrors the trial harness's leak assertion. */
async function runLeakCheck(task: EvalTask, env: EnvRef, runtime: GateRuntime): Promise<void> {
  const markers = leakMarkers(task);
  if (markers.length === 0) return;
  runtime.onPhase(task.id, "snapshot leak check");
  const sandbox = await runtime.provider.create(env, runtime.sandboxOpts);
  try {
    const flags = markers.map((marker) => `-e ${shq(marker)}`).join(" ");
    const result = await runtime.provider.exec(
      sandbox,
      `grep -rF ${flags} ${REPO_DIR} 2>/dev/null | head -5`,
      { timeoutMs: 120_000 },
    );
    if (result.stdout.trim().length > 0) {
      throw new GateFailure(
        "leak",
        `env snapshot contains patch content: ${result.stdout.trim().slice(0, 160)}`,
      );
    }
  } finally {
    await runtime.provider.destroy(sandbox);
  }
}

export async function validateTasks(
  tasks: EvalTask[],
  options: GateOptions,
): Promise<TaskValidationReport> {
  const startedAt = new Date().toISOString();
  const entries: TaskReportEntry[] = [];
  for (const task of tasks) {
    entries.push(await validateTask(task, options));
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: options.provider.id,
    flakeRounds: options.flakeRounds ?? 3,
    tasks: entries,
    summary: summarize(entries),
  };
}

