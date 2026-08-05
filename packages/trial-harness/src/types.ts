// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The trial harness contract. One trial =
 * one (task × config × trial index): run the agent against the pre-fix repo,
 * freeze its patch, grade by executing the repo's tests.
 *
 * Two invariants ARE the product's credibility:
 * 1. the agent never sees test_patch/gold_patch;
 * 2. agent failures are RESULTS, never retried — only infra failures retry.
 */

/** Exhaustive, mutually-exclusive terminal statuses. */
export type TrialStatus =
  | "graded" // ran to completion, tests executed → resolved true/false
  | "agent_error" // agent exhausted budget / crashed producing no usable patch
  | "patch_apply_failed" // frozen patch does not apply on the clean grade env
  | "build_error" // env failed to materialize for this trial
  | "timeout" // wall-clock budget hit (agent-side) — a result, not infra
  | "infra_error"; // sandbox/provider/transport failure — the ONLY retryable class

/** Only infra_error retries. Everything else is a result. */
export const RETRYABLE_STATUSES: ReadonlySet<TrialStatus> = new Set(["infra_error"]);

export interface AgentBudgets {
  maxTurns: number;
  maxTokens: number;
  wallClockS: number;
}

export interface TrialConfig {
  /** Stable id used for pairing in the stats layer (e.g. "opus", "glm-4.6"). */
  id: string;
  /** Which agent CLI drives the trial — the multi-agent seam. */
  launcher: string; // 'claude-code' | 'codex' | …
  /** Model name passed to the launcher. */
  model: string;
  /** Anthropic-compatible base URL for vendor arms (undefined = default). */
  baseUrl?: string;
  /**
   * Rate-limit domain for the matrix's per-vendor caps.
   * Defaults derive from `baseUrl`'s host, else the launcher's default vendor
   * (claude-code → anthropic, codex → openai) — set explicitly when two
   * configs share a host but not a rate limit (or vice versa).
   */
  vendor?: string;
  /** In-sandbox context files injected before the agent runs (the A/B arm). */
  context?: Record<string, string>;
  budgets: AgentBudgets;
}

/** Per-test outcome in the grade phase. */
export interface TestResult {
  id: string;
  outcome: "pass" | "fail" | "not_found";
}

/** Trajectory summary parsed from the launcher's own transcript. Fields a
 * launcher can't provide degrade to null — never a crash. */
export interface TrajectorySummary {
  launcher: string;
  turns: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  wallClockMs: number;
}

export interface TrialCost {
  usd: number;
  /** measured from trajectory usage × prices, or estimated when usage is null. */
  source: "measured" | "estimated";
}

export interface LeakAssertions {
  /** Agent worktree never contained test_patch content (checksum sweep). */
  agentWorktreeClean: boolean;
  /** Agent transcript never referenced an F2P test name. */
  transcriptClean: boolean;
  /** Grade sandbox had no network. */
  gradeOffline: boolean;
  /** test/gold patches were never written into the AGENT sandbox. */
  patchesNeverInAgentSandbox: boolean;
  /** Applied candidate patch matched the freeze-time checksum. */
  frozenPatchIntact: boolean;
}

export const TRIAL_SCHEMA_VERSION = 1;

export interface TrialResult {
  schemaVersion: typeof TRIAL_SCHEMA_VERSION;
  taskId: string;
  configId: string;
  trialIndex: number;
  status: TrialStatus;
  /** Only meaningful when status === 'graded'. */
  resolved: boolean;
  failToPass: TestResult[];
  passToPass: TestResult[];
  /** Unified diff the agent produced (frozen out of its sandbox). */
  patch: string;
  patchApplyOk: boolean;
  trajectory: TrajectorySummary | null;
  cost: TrialCost;
  leak: LeakAssertions;
  /** How the statement/env came to be, carried from the task. */
  statementSource?: string;
  envSource?: string;
  quarantinedSkipped: string[];
  /** Retry bookkeeping — attempt is 1-based; >1 means an infra retry happened. */
  attempt: number;
  timings: { agentMs: number; gradeMs: number; totalMs: number };
  /** Populated on non-graded statuses — a typed reason, never a silent hole. */
  error?: string;
}

/** A trial resolves iff status graded AND every non-quarantined F2P passes
 * AND every P2P passes. Single source of truth used by the harness and the
 * stats layer. */
export function isResolved(failToPass: TestResult[], passToPass: TestResult[]): boolean {
  const allPass = (tests: TestResult[]) => tests.every((test) => test.outcome === "pass");
  return failToPass.length > 0 && allPass(failToPass) && allPass(passToPass);
}
