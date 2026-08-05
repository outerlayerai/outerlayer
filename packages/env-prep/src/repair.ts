// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The agentic repair ladder, budgeted HARD — a runaway repair
 * loop is a silent COGS leak with the same cost profile as a trial run.
 *
 * Architecture note: the repair model runs in the CONTROL PLANE and only
 * ever returns a replacement setup script. It never gets file-editing
 * access to the sandbox, so "edits ONLY setup steps, never source" is
 * structural, and the source guard in build.ts rejects any setup (model-
 * or human-written) that mutates tracked files. Each attempt is a full
 * fresh build under the new setup's OWN cache key — no residue can carry
 * between attempts.
 */

import type { EnvRef } from "@outerlayer/runner-core";
import type { EvalTask } from "@outerlayer/task-format";
import { buildTaskEnv, EnvBuildError, type BuildEnvOptions } from "./build.js";
import type { EscalationItem } from "./escalation.js";

export interface RepairContext {
  task: EvalTask;
  /** The setup that just failed. */
  previousSetup: string;
  failure: { stage: string; excerpt: string };
  /** 1-based repair attempt number. */
  attempt: number;
  /** Every setup already tried (deterministic first) — don't repeat them. */
  triedSetups: string[];
}

export interface RepairProposal {
  setup: string;
  /** Model-reported cost for this proposal, if known. */
  costUsd?: number;
}

export interface RepairModel {
  proposeSetup(context: RepairContext): Promise<RepairProposal>;
}

export interface RepairBudget {
  /** Repair attempts AFTER the deterministic build (spec default 10). */
  maxAttempts: number;
  /** Accumulated model cost ceiling (spec default $2). */
  maxCostUsd: number;
}

export const DEFAULT_REPAIR_BUDGET: RepairBudget = { maxAttempts: 10, maxCostUsd: 2 };

export type LadderResult =
  | {
      outcome: "deterministic" | "repaired";
      env: EnvRef;
      probeMs: number;
      /** The setup that produced the working env. */
      setup: string;
      attempts: number;
      costUsd: number;
    }
  | { outcome: "escalated"; item: EscalationItem; attempts: number; costUsd: number };

export interface LadderOptions extends Omit<BuildEnvOptions, "setup"> {
  repairModel?: RepairModel;
  budget?: Partial<RepairBudget>;
}

const ERROR_RING = 3;

export async function buildWithRepairLadder(
  task: EvalTask,
  options: LadderOptions,
): Promise<LadderResult> {
  const budget: RepairBudget = { ...DEFAULT_REPAIR_BUDGET, ...options.budget };
  const failures: EscalationItem["lastErrors"] = [];
  const triedSetups: string[] = [];
  let setup = task.environment.setup;
  let costUsd = 0;
  let repairAttempts = 0;

  for (;;) {
    triedSetups.push(setup);
    try {
      const { env, probeMs } = await buildTaskEnv(task, { ...options, setup });
      return {
        outcome: repairAttempts === 0 ? "deterministic" : "repaired",
        env,
        probeMs,
        setup,
        attempts: repairAttempts,
        costUsd,
      };
    } catch (error) {
      if (!(error instanceof EnvBuildError)) throw error; // provider/transport — not repairable here
      failures.unshift({ stage: error.stage, excerpt: error.excerpt, setup });
      failures.splice(ERROR_RING);

      // Budget stops the ladder once spend REACHES the ceiling. A proposal's
      // cost is only known after the model runs, so actual spend can overshoot
      // by at most one proposal — the cap bounds attempts, not a hard dollar
      // line. (Attempt count is the precise lever; cost is the soft one.)
      const exhausted =
        !options.repairModel || repairAttempts >= budget.maxAttempts || costUsd >= budget.maxCostUsd;
      if (exhausted) {
        return {
          outcome: "escalated",
          attempts: repairAttempts,
          costUsd,
          item: {
            repo: task.repo,
            baseCommit: task.base_commit,
            taskIds: [task.id],
            lastErrors: failures,
            attempts: repairAttempts,
            costUsd,
            suggestedNextSteps: suggestNextSteps(failures, options.repairModel !== undefined, budget),
            createdAt: new Date().toISOString(),
          },
        };
      }

      repairAttempts += 1;
      const proposal = await options.repairModel!.proposeSetup({
        task,
        previousSetup: setup,
        failure: { stage: error.stage, excerpt: error.excerpt },
        attempt: repairAttempts,
        triedSetups: [...triedSetups],
      });
      costUsd += proposal.costUsd ?? 0;
      setup = proposal.setup;
    }
  }
}

function suggestNextSteps(
  failures: EscalationItem["lastErrors"],
  hadModel: boolean,
  budget: RepairBudget,
): string {
  const last = failures[0];
  if (!last) return "no build attempted";
  const base = !hadModel
    ? "no repair model configured — set one (BYO key) or fix the setup by hand"
    : `repair budget exhausted (${budget.maxAttempts} attempts / $${budget.maxCostUsd})`;
  const hint =
    last.stage === "source_guard"
      ? "the setup mutates tracked source files — move generated files out of the repo or gitignore them"
      : last.stage === "probe"
        ? "the test suite fails to collect — check test_cmd and import errors in the excerpt"
        : last.stage === "materialize"
          ? "clone/checkout failed — check repo URL, auth, and that base_commit exists"
          : "setup exits nonzero — check the package/tool names in the excerpt";
  return `${base}; ${hint}`;
}
