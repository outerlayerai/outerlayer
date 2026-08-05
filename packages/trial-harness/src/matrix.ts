// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * runMatrix — concurrency-controlled fan-out over (task × config × trial)
 * Local mode = a p-limit pool; cloud mode swaps the same
 * shape onto queue infra. Enforces:
 *  - the retry policy: ONLY infra_error retries, max `maxInfraRetries`, with
 *    an idempotency key (task, config, trial, attempt);
 *  - a budget kill-switch: once accumulated measured cost crosses maxUsd, no
 *    new trials start (in-flight trials finish);
 *  - global concurrency + optional per-vendor caps (`vendorConcurrency`).
 */

import type { EvalTask } from "@outerlayer/task-format";
import { runTrial, type RunTrialDeps } from "./trial.js";
import { RETRYABLE_STATUSES, type TrialConfig, type TrialResult } from "./types.js";

/** Launcher → default rate-limit domain, when a config sets no `vendor` and
 * no `baseUrl` (a base URL's host identifies the vendor arm's endpoint). */
const LAUNCHER_DEFAULT_VENDOR: Record<string, string> = {
  "claude-code": "anthropic",
  codex: "openai",
};

/** The rate-limit domain one config's trials count against. */
export function vendorForConfig(config: TrialConfig): string {
  if (config.vendor) return config.vendor;
  if (config.baseUrl) {
    try {
      return new URL(config.baseUrl).host;
    } catch {
      return config.baseUrl;
    }
  }
  return LAUNCHER_DEFAULT_VENDOR[config.launcher] ?? config.launcher;
}

export interface MatrixOptions extends RunTrialDeps {
  trialsPerTask: number;
  concurrency?: number;
  maxInfraRetries?: number;
  /** Hard budget: once measured spend reaches this, no new trials start. */
  maxUsd?: number;
  /**
   * Max in-flight trials per vendor (key: {@link vendorForConfig} of the
   * config). Vendors absent from the map are bounded only by `concurrency`.
   * A capped vendor's excess trials wait for a slot — they are never skipped.
   */
  vendorConcurrency?: Record<string, number>;
  onResult?: (result: TrialResult) => void;
}

/** Counting semaphore per vendor. A release hands its slot to the oldest
 * waiter directly so the in-use count can never overshoot the cap. */
class VendorGate {
  private readonly inUse = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly caps: Record<string, number>) {}

  async acquire(vendor: string): Promise<void> {
    const cap = this.caps[vendor];
    if (cap === undefined) return;
    const used = this.inUse.get(vendor) ?? 0;
    if (used < cap) {
      this.inUse.set(vendor, used + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = this.waiters.get(vendor) ?? [];
      queue.push(resolve);
      this.waiters.set(vendor, queue);
    });
  }

  release(vendor: string): void {
    if (this.caps[vendor] === undefined) return;
    const next = this.waiters.get(vendor)?.shift();
    if (next) {
      next(); // slot transfers — inUse count unchanged
      return;
    }
    this.inUse.set(vendor, (this.inUse.get(vendor) ?? 1) - 1);
  }
}

export interface MatrixReport {
  results: TrialResult[];
  spentUsd: number;
  budgetStopped: boolean;
  /** Cells that never ran because the budget kill-switch fired. */
  skipped: { taskId: string; configId: string; trialIndex: number }[];
}

interface Cell {
  task: EvalTask;
  config: TrialConfig;
  trialIndex: number;
}

export async function runMatrix(
  tasks: EvalTask[],
  configs: TrialConfig[],
  options: MatrixOptions,
): Promise<MatrixReport> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const maxRetries = options.maxInfraRetries ?? 2;
  const maxUsd = options.maxUsd ?? Infinity;

  const cells: Cell[] = [];
  for (const task of tasks) {
    for (const config of configs) {
      for (let trialIndex = 0; trialIndex < options.trialsPerTask; trialIndex++) {
        cells.push({ task, config, trialIndex });
      }
    }
  }

  const results: TrialResult[] = [];
  const skipped: MatrixReport["skipped"] = [];
  const vendorGate = new VendorGate(options.vendorConcurrency ?? {});
  let spentUsd = 0;
  let budgetStopped = false;
  let cursor = 0;

  const runCell = async (cell: Cell): Promise<void> => {
    if (spentUsd >= maxUsd) {
      budgetStopped = true;
      skipped.push({ taskId: cell.task.id, configId: cell.config.id, trialIndex: cell.trialIndex });
      return;
    }
    const vendor = vendorForConfig(cell.config);
    await vendorGate.acquire(vendor);
    try {
      let attempt = 1;
      let result = await runTrial(cell.task, cell.config, cell.trialIndex, options);
      while (RETRYABLE_STATUSES.has(result.status) && attempt <= maxRetries) {
        attempt += 1;
        result = { ...(await runTrial(cell.task, cell.config, cell.trialIndex, options)), attempt };
      }
      spentUsd += result.cost.usd;
      results.push(result);
      options.onResult?.(result);
    } finally {
      vendorGate.release(vendor);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= cells.length) return;
      await runCell(cells[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, () => worker()));

  // Stable ordering (workers race): sort by task, config, trial.
  results.sort(
    (a, b) =>
      a.taskId.localeCompare(b.taskId) ||
      a.configId.localeCompare(b.configId) ||
      a.trialIndex - b.trialIndex,
  );
  return { results, spentUsd, budgetStopped, skipped };
}
