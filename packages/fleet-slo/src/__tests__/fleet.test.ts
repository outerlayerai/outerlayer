// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import type {
  EnvRef, EnvSpec, ExecOpts, ExecResult, FileMap, Sandbox, SandboxInfo, SandboxOpts, SandboxProvider,
} from "@outerlayer/runner-core";
import type { EvalTask } from "@outerlayer/task-format";
import { runTrial, type RunTrialDeps } from "@outerlayer/trial-harness";
import type { AgentLauncher } from "@outerlayer/trial-harness";
import { checkSlos, computeSlos, type RunTelemetry, type TrialTelemetry } from "../slo.js";
import { consecutiveGreenWeeks, evaluateLaunchGate, weekIsGreen, type WeeklySlo } from "../gate.js";
import { CHAOS_SCENARIOS, FaultInjectingProvider } from "../chaos.js";

// ---- SLO computation ------------------------------------------------------

const goodWeek = (): WeeklySlo => ({
  weekIso: "2026-W27",
  slos: computeSlos(
    [
      ...Array.from({ length: 98 }, () => ({ status: "graded" as const, hasTypedReason: true })),
      { status: "infra_error", hasTypedReason: true },
      { status: "agent_error", hasTypedReason: true },
    ],
    [
      { qualifyPassed: true, producedCard: true, humanTouches: 0, qualifyMs: 10 * 60_000, cardWallClockMs: 20 * 60_000, estimatedCostUsd: 40, measuredCostUsd: 44 },
      { qualifyPassed: true, producedCard: true, humanTouches: 0, qualifyMs: 12 * 60_000, cardWallClockMs: 25 * 60_000, estimatedCostUsd: 40, measuredCostUsd: 50 },
    ],
  ),
});

describe("computeSlos + checkSlos", () => {
  test("a healthy week passes every gate", () => {
    const slos = goodWeek().slos;
    expect(slos.infraErrorRate).toBeCloseTo(0.01, 5);
    expect(slos.unattendedCompletion).toBe(1);
    expect(slos.silentFailures).toBe(0);
    expect(checkSlos(slos).every((c) => c.pass)).toBe(true);
  });

  test("a silent failure (non-graded, no typed reason) trips the zero-silent-failure gate", () => {
    const slos = computeSlos(
      [{ status: "graded", hasTypedReason: true }, { status: "infra_error", hasTypedReason: false }],
      [],
    );
    expect(slos.silentFailures).toBe(1);
    const check = checkSlos(slos).find((c) => c.name === "silent_failures")!;
    expect(check.pass).toBe(false);
  });

  test("infra error rate above 3% fails its gate", () => {
    const trials: TrialTelemetry[] = [
      ...Array.from({ length: 95 }, () => ({ status: "graded" as const, hasTypedReason: true })),
      ...Array.from({ length: 5 }, () => ({ status: "infra_error" as const, hasTypedReason: true })),
    ];
    const slos = computeSlos(trials, []);
    expect(slos.infraErrorRate).toBe(0.05);
    expect(checkSlos(slos).find((c) => c.name === "infra_error_rate")!.pass).toBe(false);
  });

  test("cost predictability counts runs within ±40% of estimate", () => {
    const runs: RunTelemetry[] = [
      { qualifyPassed: true, producedCard: true, humanTouches: 0, qualifyMs: 1, cardWallClockMs: 1, estimatedCostUsd: 100, measuredCostUsd: 130 }, // +30% ✓
      { qualifyPassed: true, producedCard: true, humanTouches: 0, qualifyMs: 1, cardWallClockMs: 1, estimatedCostUsd: 100, measuredCostUsd: 160 }, // +60% ✗
    ];
    expect(computeSlos([], runs).costPredictability).toBe(0.5);
  });
});

// ---- GO/NO-GO gate --------------------------------------------------------

describe("launch gate", () => {
  test("GO requires two consecutive green weeks AND all sign-offs", () => {
    const weeks = [goodWeek(), goodWeek()];
    expect(consecutiveGreenWeeks(weeks)).toBe(2);
    const gate = evaluateLaunchGate(weeks, [{ name: "canary list", approved: true }]);
    expect(gate.decision).toBe("GO");
    expect(gate.reasons).toEqual([]);
  });

  test("one green week is NO_GO (encoded two-week requirement)", () => {
    const gate = evaluateLaunchGate([goodWeek()], [{ name: "canary list", approved: true }]);
    expect(gate.decision).toBe("NO_GO");
    expect(gate.reasons[0]).toContain("1/2 consecutive green weeks");
  });

  test("a red latest week breaks the streak and lists the failing SLO", () => {
    const redWeek: WeeklySlo = {
      weekIso: "2026-W28",
      slos: computeSlos([{ status: "infra_error", hasTypedReason: false }], []),
    };
    expect(weekIsGreen(redWeek.slos)).toBe(false);
    const gate = evaluateLaunchGate([goodWeek(), goodWeek(), redWeek], [{ name: "canary list", approved: true }]);
    expect(gate.decision).toBe("NO_GO");
    expect(gate.consecutiveGreenWeeks).toBe(0);
    expect(gate.reasons.some((r) => r.includes("silent_failures"))).toBe(true);
  });

  test("a pending founder sign-off blocks GO even with green weeks", () => {
    const gate = evaluateLaunchGate([goodWeek(), goodWeek()], [{ name: "canary list", approved: false }]);
    expect(gate.decision).toBe("NO_GO");
    expect(gate.manualBlockers).toEqual(["canary list"]);
  });
});

// ---- Chaos suite: drive the REAL trial harness, assert typed handling -----

const TASK: EvalTask = {
  schema_version: 1, id: "chaos-task", repo: "r", base_commit: "c",
  problem_statement: "Fix the thing so the divide-by-zero path returns None instead of raising.",
  test_patch: `--- /dev/null\n+++ b/tests/test_x.py\n@@ -0,0 +1,2 @@\n+def test_it():\n+    assert True\n`,
  gold_patch: `--- a/x.py\n+++ b/x.py\n@@ -1,1 +1,2 @@\n a = 1\n+b = 2\n`,
  fail_to_pass: ["tests/test_x.py::test_it"], pass_to_pass: [],
  environment: { base_image: "img", setup: "", test_cmd: "python -m pytest -q", runner: "pytest", timeout_s: 30 },
  quarantined: [],
};

class OkProvider implements SandboxProvider {
  readonly id = "ok";
  private n = 0;
  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    return { key: spec.key, imageRef: `img:${spec.key}`, providerId: this.id, createdAt: "t", built: true };
  }
  async create(env: EnvRef): Promise<Sandbox> {
    return { id: `sb-${++this.n}`, providerId: this.id, envKey: env.key, createdAt: "t" };
  }
  async exec(_s: Sandbox, cmd: string): Promise<ExecResult> {
    const ok = (o: Partial<ExecResult> = {}) => ({ code: 0, stdout: "", stderr: "", ms: 1, truncated: false, timedOut: false, ...o });
    if (cmd.includes("git diff --cached")) return ok({ stdout: "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1,2 @@\n a=1\n+b=2\n" });
    if (cmd.includes("grep -rF")) return ok({ code: 1 });
    return ok({ code: 0 });
  }
  async putFiles(): Promise<void> {}
  async getFile(): Promise<Buffer> { return Buffer.from(""); }
  async destroy(): Promise<void> {}
  async list(): Promise<SandboxInfo[]> { return []; }
}

const launcher: AgentLauncher = {
  id: "scripted",
  invoke: () => ({ command: "echo done", env: {}, transcriptPath: "/tmp/t.jsonl" }),
  parseTranscript: () => ({ launcher: "scripted", turns: 1, toolCalls: 0, toolErrors: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: null, wallClockMs: 0 }),
};

function deps(provider: SandboxProvider): RunTrialDeps {
  return {
    provider,
    envFactory: (task) => provider.prepareEnv({ key: `env-${task.id}`, baseImage: "img" }),
    resolveSecrets: async () => ({}),
    launcher: () => launcher,
  };
}

describe("chaos suite drives runTrial to typed outcomes (no hang, no silent loss)", () => {
  for (const scenario of CHAOS_SCENARIOS) {
    test(scenario.name, async () => {
      const provider = new FaultInjectingProvider(new OkProvider(), scenario.schedule);
      const config = { id: "c", launcher: "scripted", model: "m", budgets: { maxTurns: 3, maxTokens: 100, wallClockS: 30 } };
      const result = await runTrial(TASK, config, 0, deps(provider));
      // Every fault surfaces as a TYPED status in the allowed set — never a
      // throw out of runTrial, never a hang.
      expect(scenario.expectStatusIn).toContain(result.status);
      // Non-graded results always carry a typed reason (the zero-silent SLO).
      if (result.status !== "graded") expect(result.error).toBeTruthy();
    });
  }

  test("a killed agent sandbox is an infra_error (retryable class), not a crash", async () => {
    const provider = new FaultInjectingProvider(new OkProvider(), { faults: [{ kind: "create_throws", onNetwork: "default" }] });
    const config = { id: "c", launcher: "scripted", model: "m", budgets: { maxTurns: 3, maxTokens: 100, wallClockS: 30 } };
    const result = await runTrial(TASK, config, 0, deps(provider));
    expect(result.status).toBe("infra_error");
    expect(result.error).toContain("chaos");
  });
});
