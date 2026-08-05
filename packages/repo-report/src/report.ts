// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The RepoReport model — composes the mining funnel, the
 * validation report, the env report, and the MDE into the
 * qualification artifact. NO agent runs happen here (cheap → free tier).
 *
 * The upstream contracts aren't imported: the report takes narrow structural
 * inputs so it composes whatever those packages emit. `mde` is injected —
 * eval-stats is the single source of truth for it.
 */

import type { StackVerdict } from "./matrix.js";

export const REPO_REPORT_SCHEMA_VERSION = 1;

export type Banner = "ready" | "ready_with_caveats" | "not_yet";

/** Structural view of task-miner's MiningReport. */
export interface MiningFunnel {
  prsScanned: number;
  candidates: number;
  validated: number;
  rejectedByReason: Record<string, number>;
  yieldPct: number;
}

/** Structural view of env-prep's EnvBuildReport summary. */
export interface EnvSummary {
  total: number;
  deterministic: number;
  repaired: number;
  escalated: number;
  cacheHitRate: number;
}

/** Structural view of task-format's validation — just what the banner/health need. */
export interface ValidationSummary {
  valid: number;
  needsReview: number;
  invalid: number;
  quarantinedTests: string[];
  suiteRuntimeMs?: number;
}

/** One row of the statistical-power table (from eval-stats' mde). */
export interface PowerRow {
  trials: number;
  mdePct: number;
}

export interface CostEstimate {
  lowUsd: number;
  highUsd: number;
  note: string;
}

export interface RepoReportInputs {
  repo: string;
  headCommit: string;
  stack: StackVerdict;
  mining: MiningFunnel;
  env: EnvSummary;
  validation: ValidationSummary;
  power: PowerRow[];
  /** Plain-language line under the power table stating the MDE assumption
   * (pre-run MDEs use an ASSUMED discordance, which must be stated). */
  powerNote?: string;
  cost: CostEstimate;
  /** Minimum validated tasks for a `ready` banner (spec default 20). */
  readyFloor?: number;
}

export interface RepoReport {
  schemaVersion: typeof REPO_REPORT_SCHEMA_VERSION;
  repo: string;
  headCommit: string;
  banner: Banner;
  bannerReason: string;
  stack: StackVerdict;
  mining: MiningFunnel;
  env: EnvSummary;
  validation: ValidationSummary;
  power: PowerRow[];
  powerNote?: string;
  cost: CostEstimate;
  /** Concrete next step — run card / add tests / concierge. */
  nextStep: string;
}

const READY_FLOOR_DEFAULT = 20;

export function buildRepoReport(inputs: RepoReportInputs): RepoReport {
  const floor = inputs.readyFloor ?? READY_FLOOR_DEFAULT;
  const { banner, bannerReason, nextStep } = decideBanner(inputs, floor);
  return {
    schemaVersion: REPO_REPORT_SCHEMA_VERSION,
    repo: inputs.repo,
    headCommit: inputs.headCommit,
    banner,
    bannerReason,
    stack: inputs.stack,
    mining: inputs.mining,
    env: inputs.env,
    validation: inputs.validation,
    power: inputs.power,
    ...(inputs.powerNote !== undefined ? { powerNote: inputs.powerNote } : {}),
    cost: inputs.cost,
    nextStep,
  };
}

function decideBanner(
  inputs: RepoReportInputs,
  floor: number,
): { banner: Banner; bannerReason: string; nextStep: string } {
  if (inputs.stack.support === "not_yet") {
    return {
      banner: "not_yet",
      bannerReason: inputs.stack.reason,
      nextStep: "Join the waitlist for this stack, or talk to us — we prioritize by demand.",
    };
  }
  const { valid } = inputs.validation;
  const envReady = inputs.env.escalated < inputs.env.total || inputs.env.total === 0;

  if (valid === 0) {
    return {
      banner: "not_yet",
      bannerReason: `No validated tasks yet (${inputs.mining.prsScanned} PRs scanned, ${inputs.mining.candidates} candidates).`,
      nextStep: nextStepForZeroYield(inputs),
    };
  }
  // `Ready` requires the task floor AND a buildable env AND (implicitly) a
  // supported stack. Anything less is caveats WITH specifics.
  if (valid >= floor && envReady && inputs.stack.support === "supported") {
    return {
      banner: "ready",
      bannerReason: `Ready — ${valid} validated tasks on a ${inputs.stack.reason} repo.`,
      nextStep: "Run a Report Card: pick two configs and compare them on your tasks.",
    };
  }
  const caveats: string[] = [];
  if (valid < floor) caveats.push(`only ${valid} validated tasks (< ${floor} for a confident card)`);
  if (inputs.stack.support === "partial") caveats.push(inputs.stack.reason);
  if (!envReady) caveats.push(`${inputs.env.escalated} env(s) need setup help`);
  return {
    banner: "ready_with_caveats",
    bannerReason: `Ready with caveats: ${caveats.join("; ")}.`,
    nextStep:
      valid < floor
        ? "You can run a card now, but it will likely be underpowered — grow N via more history or synthetic augmentation."
        : "Run a Report Card; note the caveats above.",
  };
}

function nextStepForZeroYield(inputs: RepoReportInputs): string {
  const noTests = inputs.mining.rejectedByReason.no_tests ?? 0;
  if (noTests > 0 && noTests >= inputs.mining.candidates / 2) {
    return "Your merged PRs rarely touch tests — add tests alongside fixes so future PRs become gradeable tasks, or talk to us about synthetic tasks.";
  }
  if ((inputs.env.escalated ?? 0) > 0) {
    return "Environments couldn't build headlessly — send us your setup and we'll get it qualified (concierge).";
  }
  return "No gradeable tasks mined yet — this is common for young or small repos; talk to us about synthetic augmentation.";
}
