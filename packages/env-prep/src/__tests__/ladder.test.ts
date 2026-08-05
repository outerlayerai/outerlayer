// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { EnvBuildError, buildTaskEnv } from "../build.js";
import { buildWithRepairLadder, type RepairModel } from "../repair.js";
import { EnvEscalatedError, EnvPrepService } from "../prepare.js";
import { EnvCacheIndex } from "../cache-index.js";
import { collectEscalationSink, type EscalationItem } from "../escalation.js";
import { envKeyForTask } from "../key.js";
import { buildTask, envExec, execResult, FakeProvider, OK } from "./helpers.js";

describe("buildTaskEnv deterministic path", () => {
  test("materialize → setup → guard → probe → snapshot, in order", async () => {
    const provider = new FakeProvider(envExec());
    const task = buildTask();
    const phases: string[] = [];
    const { env, probeMs } = await buildTaskEnv(task, {
      provider,
      onPhase: (_id, phase) => phases.push(phase),
    });

    expect(env.key).toBe(envKeyForTask(task));
    expect(env.built).toBe(true);
    expect(probeMs).toBeGreaterThanOrEqual(0);
    expect(phases).toEqual(["materialize repo", "run setup", "source guard", "health probe"]);
    expect(provider.execLog.some((cmd) => cmd.includes("--collect-only"))).toBe(true);
  });

  test("setup nonzero ⇒ EnvBuildError(setup) with the stderr excerpt", async () => {
    const provider = new FakeProvider(
      envExec({ setup: () => execResult({ code: 1, stderr: "No matching distribution found for pytest==999" }) }),
    );
    await expect(buildTaskEnv(buildTask(), { provider })).rejects.toMatchObject({
      stage: "setup",
      excerpt: expect.stringContaining("No matching distribution"),
    });
  });

  test("setup that dirties tracked source ⇒ EnvBuildError(source_guard) — the structural repair boundary", async () => {
    const provider = new FakeProvider(envExec({ guard: execResult({ stdout: " M calc.py\n M app/models.py" }) }));
    const error = await buildTaskEnv(buildTask(), { provider }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvBuildError);
    expect((error as EnvBuildError).stage).toBe("source_guard");
    expect((error as EnvBuildError).excerpt).toContain("calc.py");
  });

  test("probe failure (broken import) ⇒ EnvBuildError(probe)", async () => {
    const provider = new FakeProvider(
      envExec({ probe: execResult({ code: 2, stderr: "ModuleNotFoundError: No module named 'httpx'" }) }),
    );
    await expect(buildTaskEnv(buildTask(), { provider })).rejects.toMatchObject({ stage: "probe" });
  });
});

describe("buildWithRepairLadder", () => {
  /** Repair model that, on the Nth attempt, returns the setup that will pass. */
  function modelThatFixesOn(succeedSetup: string, costEach = 0.2): RepairModel {
    return {
      async proposeSetup(context) {
        expect(context.previousSetup).toBeTruthy();
        return { setup: `${succeedSetup} # attempt ${context.attempt}`, costUsd: costEach };
      },
    };
  }

  test("deterministic success: zero attempts, zero cost", async () => {
    const provider = new FakeProvider(envExec());
    const result = await buildWithRepairLadder(buildTask(), { provider });
    expect(result.outcome).toBe("deterministic");
    if (result.outcome === "escalated") throw new Error("unexpected");
    expect(result.attempts).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  test("repairs when the model's proposed setup passes; records the working setup", async () => {
    const GOOD = "pip install -q pytest==8.3.3 && apt-get install -y libpq-dev";
    let calls = 0;
    const provider = new FakeProvider((cmd) => {
      if (cmd.includes("git status --porcelain")) return execResult({ stdout: "" });
      if (cmd.includes("--collect-only")) return OK;
      if (cmd.includes("git clone")) return OK;
      // The setup command: fail until the model's GOOD setup shows up.
      calls += 1;
      return cmd.includes(GOOD) ? OK : execResult({ code: 1, stderr: "psql headers missing" });
    });
    const result = await buildWithRepairLadder(buildTask(), {
      provider,
      repairModel: modelThatFixesOn(GOOD),
    });
    expect(result.outcome).toBe("repaired");
    if (result.outcome === "escalated") throw new Error("unexpected");
    expect(result.attempts).toBe(1);
    expect(result.setup).toContain(GOOD);
    expect(result.costUsd).toBeCloseTo(0.2, 10);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("attempt budget exhausts ⇒ escalation with the last errors and a next-step", async () => {
    const provider = new FakeProvider(
      envExec({ setup: () => execResult({ code: 1, stderr: "still broken" }) }),
    );
    const result = await buildWithRepairLadder(buildTask(), {
      provider,
      repairModel: { async proposeSetup() { return { setup: "try harder", costUsd: 0.1 }; } },
      budget: { maxAttempts: 3, maxCostUsd: 99 },
    });
    expect(result.outcome).toBe("escalated");
    if (result.outcome !== "escalated") throw new Error("unexpected");
    expect(result.attempts).toBe(3);
    expect(result.item.lastErrors[0]).toMatchObject({ stage: "setup" });
    expect(result.item.suggestedNextSteps).toContain("budget exhausted");
    expect(result.costUsd).toBeCloseTo(0.3, 10);
  });

  test("cost budget stops the ladder well before the attempt budget", async () => {
    const provider = new FakeProvider(
      envExec({ setup: () => execResult({ code: 1, stderr: "broken" }) }),
    );
    const result = await buildWithRepairLadder(buildTask(), {
      provider,
      repairModel: { async proposeSetup() { return { setup: "x", costUsd: 1.5 }; } },
      budget: { maxAttempts: 10, maxCostUsd: 2 },
    });
    expect(result.outcome).toBe("escalated");
    if (result.outcome !== "escalated") throw new Error("unexpected");
    // $2 ceiling with $1.5/proposal: attempt 1 → $1.5 (<2, continue), attempt
    // 2 → $3.0 (>=2, stop). Cost stopped it at 2 attempts, far under the 10
    // attempt budget — spend overshoots the ceiling by one proposal, as
    // documented (proposal cost is only known after it runs).
    expect(result.attempts).toBe(2);
    expect(result.attempts).toBeLessThan(10);
    expect(result.costUsd).toBeCloseTo(3.0, 10);
  });

  test("no repair model ⇒ deterministic failure escalates immediately with a config hint", async () => {
    const provider = new FakeProvider(envExec({ setup: () => execResult({ code: 1, stderr: "broken" }) }));
    const result = await buildWithRepairLadder(buildTask(), { provider });
    expect(result.outcome).toBe("escalated");
    if (result.outcome !== "escalated") throw new Error("unexpected");
    expect(result.attempts).toBe(0);
    expect(result.item.suggestedNextSteps).toContain("no repair model configured");
  });
});

describe("EnvPrepService", () => {
  test("prepareEnv returns an EnvRef; second call is an index cache hit (no rebuild)", async () => {
    const provider = new FakeProvider(envExec());
    const service = new EnvPrepService({ provider });
    const task = buildTask();

    const first = await service.prepareEnv(task);
    expect(first.built).toBe(true);
    expect(provider.builds).toBe(1);

    const second = await service.prepareEnv(task);
    expect(second.key).toBe(first.key);
    expect(provider.builds).toBe(1); // index hit — build callback not re-run
  });

  test("escalated env throws EnvEscalatedError and reports to the sink", async () => {
    const items: EscalationItem[] = [];
    const provider = new FakeProvider(envExec({ setup: () => execResult({ code: 1, stderr: "nope" }) }));
    const service = new EnvPrepService({ provider, escalationSink: collectEscalationSink(items) });
    await expect(service.prepareEnv(buildTask())).rejects.toBeInstanceOf(EnvEscalatedError);
    expect(items).toHaveLength(1);
    expect(items[0]!.taskIds).toEqual(["env-demo"]);
  });

  test("repaired setup is persisted back onto the task with env_source provenance", async () => {
    const GOOD = "pip install -q pytest && apt-get install -y libpq-dev";
    const provider = new FakeProvider((cmd) => {
      if (cmd.includes("git status --porcelain")) return execResult({ stdout: "" });
      if (cmd.includes("--collect-only") || cmd.includes("git clone")) return OK;
      return cmd.includes(GOOD) ? OK : execResult({ code: 1, stderr: "broken" });
    });
    const persisted: string[] = [];
    const service = new EnvPrepService({
      provider,
      repairModel: { async proposeSetup() { return { setup: GOOD, costUsd: 0.1 }; } },
      onRepairedSetup: (_task, setup) => { persisted.push(setup); },
    });
    const task = buildTask();
    await service.prepareEnv(task);
    expect(task.env_source).toBe("repaired");
    expect(task.environment.setup).toBe(GOOD);
    expect(persisted).toEqual([GOOD]);
  });

  test("prepareEnvAll is failure-isolated and reports mixed outcomes", async () => {
    // Two tasks with distinct keys: one builds, one escalates.
    const good = buildTask({ id: "good" });
    const bad = buildTask({ id: "bad", base_commit: "different-commit", environment: { ...buildTask().environment, setup: "false" } });
    const provider = new FakeProvider((cmd) => {
      if (cmd.includes("git status --porcelain")) return execResult({ stdout: "" });
      if (cmd.includes("--collect-only") || cmd.includes("git clone")) return OK;
      if (cmd === `cd /work/repo && false`) return execResult({ code: 1, stderr: "false exits 1" });
      return OK;
    });
    const service = new EnvPrepService({ provider, escalationSink: collectEscalationSink([]) });
    const report = await service.prepareEnvAll([good, bad]);
    expect(report.summary).toMatchObject({ total: 2, deterministic: 1, escalated: 1, ready: 1 });
    expect(report.results.map((r) => [r.taskId, r.outcome])).toEqual([
      ["good", "deterministic"],
      ["bad", "escalated"],
    ]);
  });
});

describe("EnvCacheIndex LRU eviction", () => {
  test("evicts least-recently-used unpinned entries until under the byte budget", async () => {
    const index = new EnvCacheIndex();
    const mk = (key: string, lastUsed: string, size: number, pinned = false) =>
      index.record({
        key, imageRef: `img:${key}`, repo: "r", baseCommit: "c", source: "deterministic",
        builtAtIso: "t", lastUsedAtIso: lastUsed, buildMs: 1, probeMs: 1, sizeBytes: size, pinned,
      });
    mk("old", "2026-01-01T00:00:00Z", 100);
    mk("mid", "2026-02-01T00:00:00Z", 100);
    mk("pinnedOld", "2026-01-01T00:00:00Z", 100, true); // canary — never evicted
    mk("new", "2026-03-01T00:00:00Z", 100);

    const removed: string[] = [];
    const evicted = await index.evictLru(200, async (key) => { removed.push(key); });

    // Total 400 → target 200: drop oldest unpinned first (old, then mid),
    // skip pinnedOld, keep new. 400-100-100=200 ≤ 200 → stop.
    expect(evicted).toEqual(["old", "mid"]);
    expect(removed).toEqual(["old", "mid"]);
    expect(index.get("pinnedOld")).toBeDefined();
    expect(index.get("new")).toBeDefined();
  });
});
