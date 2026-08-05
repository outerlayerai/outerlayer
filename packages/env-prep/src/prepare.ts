// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * EnvPrepService — the `prepareEnv` implementation behind runner-core's seam,
 * and the `prepareEnvAll` warm-at-qualification entry repo-report calls so that
 * by card time every task is a warm boot. This is the object the task-format
 * gate and the trial harness
 * receive as their `envFactory`: `(task) => Promise<EnvRef>`.
 *
 * Contract highlights:
 * - Snapshot cache is content-addressed (key.ts). A cache hit re-runs
 *   nothing — the whole point is that card runs never build environments.
 * - Deterministic build → agentic repair ladder → escalation (repair.ts).
 * - A repaired setup is persisted back onto the task with env_source:
 *   'repaired' provenance so the next run is deterministic.
 * - Cache-index bookkeeping + LRU eviction seam (cache-index.ts).
 */

import type { EnvRef, SandboxProvider } from "@outerlayer/runner-core";
import type { EvalTask } from "@outerlayer/task-format";
import { buildWithRepairLadder, type RepairBudget, type RepairModel } from "./repair.js";
import { EnvCacheIndex, type CacheIndexEntry } from "./cache-index.js";
import { consoleEscalationSink, type EscalationSink } from "./escalation.js";
import { envKeyForTask } from "./key.js";
import type { MaterializeRepo } from "./build.js";
import {
  summarizeEnvResults,
  type EnvBuildReport,
  type EnvTaskResult,
  ENV_REPORT_SCHEMA_VERSION,
} from "./report.js";

export class EnvEscalatedError extends Error {
  constructor(readonly taskId: string) {
    super(`env prep escalated for task ${taskId} — no buildable environment`);
    this.name = "EnvEscalatedError";
  }
}

export interface EnvPrepOptions {
  provider: SandboxProvider;
  materializeRepo?: MaterializeRepo;
  repairModel?: RepairModel;
  budget?: Partial<RepairBudget>;
  escalationSink?: EscalationSink;
  index?: EnvCacheIndex;
  /** Called with the repaired setup so the caller can persist it to the task
   * file (default persistence is in-memory: the returned task is mutated). */
  onRepairedSetup?: (task: EvalTask, workingSetup: string) => void | Promise<void>;
  onPhase?: (taskId: string, phase: string) => void;
  /** Injects provider image sizes into the index for byte-budget eviction. */
  sizeOf?: (key: string) => Promise<number | undefined>;
}

export class EnvPrepService {
  private readonly index: EnvCacheIndex;
  private readonly escalation: EscalationSink;

  constructor(private readonly options: EnvPrepOptions) {
    this.index = options.index ?? new EnvCacheIndex();
    this.escalation = options.escalationSink ?? consoleEscalationSink();
  }

  /** The `envFactory` seam the gate and the harness consume. Throws EnvEscalatedError when no
   * environment can be built (the ladder escalated) — a typed signal callers
   * turn into an `env_fail`/escalation, never a silent skip. */
  readonly prepareEnv = async (task: EvalTask): Promise<EnvRef> => {
    const result = await this.prepareOne(task);
    if (result.outcome === "escalated" || !result.env) {
      throw new EnvEscalatedError(task.id);
    }
    return result.env;
  };

  /** Warm every task's env at qualification time. Failure-isolated:
   * one escalation never aborts the batch. */
  async prepareEnvAll(tasks: EvalTask[]): Promise<EnvBuildReport> {
    const startedAt = new Date().toISOString();
    const results: EnvTaskResult[] = [];
    for (const task of tasks) {
      const built = await this.prepareOne(task);
      results.push(built.result);
    }
    return {
      schemaVersion: ENV_REPORT_SCHEMA_VERSION,
      provider: this.options.provider.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
      summary: summarizeEnvResults(results),
    };
  }

  getIndex(): EnvCacheIndex {
    return this.index;
  }

  private async prepareOne(
    task: EvalTask,
  ): Promise<{ result: EnvTaskResult; env?: EnvRef; outcome: EnvTaskResult["outcome"] }> {
    const cacheKey = envKeyForTask(task);
    const cached = this.index.get(cacheKey);
    if (cached) {
      // Index hit: the provider still owns the bytes, but prepareEnv is
      // idempotent, so this is a no-build confirm + recency bump.
      this.index.touch(cacheKey);
      const env = await this.options.provider.prepareEnv({
        key: cacheKey,
        baseImage: task.environment.base_image,
      });
      const result: EnvTaskResult = {
        taskId: task.id,
        outcome: "cache_hit",
        envKey: env.key,
        imageRef: env.imageRef,
        setupSource: cached.source === "repaired" ? "repaired" : "original",
        repairAttempts: 0,
        costUsd: 0,
        buildMs: 0,
        probeMs: 0,
      };
      return { result, env, outcome: "cache_hit" };
    }

    const buildStart = Date.now();
    const ladder = await buildWithRepairLadder(task, {
      provider: this.options.provider,
      materializeRepo: this.options.materializeRepo,
      repairModel: this.options.repairModel,
      budget: this.options.budget,
      onPhase: this.options.onPhase,
    });
    const buildMs = Date.now() - buildStart;

    if (ladder.outcome === "escalated") {
      await this.escalation.report(ladder.item);
      const result: EnvTaskResult = {
        taskId: task.id,
        outcome: "escalated",
        setupSource: "original",
        repairAttempts: ladder.attempts,
        costUsd: ladder.costUsd,
        buildMs,
        probeMs: 0,
      };
      return { result, outcome: "escalated" };
    }

    // Trust the ladder's own verdict: repairAttempts>0 ⇒ "repaired" even when
    // the repaired setup happens to key an already-built env (e.g. it
    // converged on another task's setup — env.built is false but a repair DID
    // happen). Index-level cache hits are handled above, before the ladder.
    const outcome: EnvTaskResult["outcome"] = ladder.outcome;

    if (ladder.outcome === "repaired") {
      await this.persistRepairedSetup(task, ladder.setup);
    }

    const entry: CacheIndexEntry = {
      key: ladder.env.key,
      imageRef: ladder.env.imageRef,
      repo: task.repo,
      baseCommit: task.base_commit,
      source: ladder.outcome === "repaired" ? "repaired" : "deterministic",
      builtAtIso: ladder.env.createdAt,
      lastUsedAtIso: new Date().toISOString(),
      buildMs,
      probeMs: ladder.probeMs,
      sizeBytes: this.options.sizeOf ? await this.options.sizeOf(ladder.env.key) : undefined,
    };
    this.index.record(entry);

    const result: EnvTaskResult = {
      taskId: task.id,
      outcome,
      envKey: ladder.env.key,
      imageRef: ladder.env.imageRef,
      setupSource: ladder.outcome === "repaired" ? "repaired" : "original",
      repairAttempts: ladder.attempts,
      costUsd: ladder.costUsd,
      buildMs,
      probeMs: ladder.probeMs,
    };
    return { result, env: ladder.env, outcome };
  }

  /** Record the working setup back onto the task (in-memory mutation), then
   * hand off to the caller's persister (writes the YAML file in CLI mode). */
  private async persistRepairedSetup(task: EvalTask, workingSetup: string): Promise<void> {
    task.environment.setup = workingSetup;
    task.env_source = "repaired";
    await this.options.onRepairedSetup?.(task, workingSetup);
  }
}
