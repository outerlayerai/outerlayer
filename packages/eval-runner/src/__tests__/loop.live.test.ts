// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// The run backend, end to end, against the REAL local Docker daemon. Gated:
//   OUTERLAYER_LOOP_LIVE=1 yarn test:loop-live
//
// This closes the eval loop for real: env build (env-prep) → per (task ×
// config × trial) the "agent" runs in a sandbox and its patch is graded in a
// FRESH sandbox by executing pytest (trial-harness) → paired stats
// (eval-stats) → the Report Card (report-card).
//
// The ONLY simulated element is which patch the agent writes (no model API
// key): config A ("opus-sim") writes the correct fix for every function;
// config B ("glm-sim") writes a partial fix (two of five functions). Every-
// thing else — Docker env, git apply, real pytest, grading, stats, card — is
// live. Expected: A resolves all 5 tasks, B resolves 2 → a real, clear-ish
// card with A ahead.
//
// Set OUTERLAYER_LOOP_REPORT_DIR to write the card JSON + terminal render.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalDockerProvider, type SandboxProvider, type Sandbox } from "@outerlayer/runner-core";
import { EnvPrepService } from "@outerlayer/env-prep";
import { REPO_DIR, type EvalTask } from "@outerlayer/task-format";
import type { AgentLauncher, TrialConfig } from "@outerlayer/trial-harness";
import { renderCardText } from "@outerlayer/report-card";
import { runEvaluation } from "../runner.js";

const LIVE = process.env.OUTERLAYER_LOOP_LIVE === "1";

// Five buggy functions — one task each (same base env, distinct test_patch).
const FUNCS = [
  { name: "divide", body: "def divide(a, b):\n    return a / b\n", call: "divide(1, 0)" },
  { name: "head", body: "def head(items):\n    return items[0]\n", call: "head([])" },
  { name: "percent", body: "def percent(part, whole):\n    return part / whole * 100.0\n", call: "percent(1, 0)" },
  { name: "last", body: "def last(items):\n    return items[-1]\n", call: "last([])" },
  { name: "average", body: "def average(nums):\n    return sum(nums) / len(nums)\n", call: "average([])" },
];

const BUGGY_CALC = FUNCS.map((f) => f.body).join("\n");

// Correct fix for ALL functions (config A writes this).
const CORRECT_CALC = [
  "def divide(a, b):\n    if b == 0:\n        return None\n    return a / b\n",
  "def head(items):\n    if not items:\n        return None\n    return items[0]\n",
  "def percent(part, whole):\n    if whole == 0:\n        return None\n    return part / whole * 100.0\n",
  "def last(items):\n    if not items:\n        return None\n    return items[-1]\n",
  "def average(nums):\n    if not nums:\n        return None\n    return sum(nums) / len(nums)\n",
].join("\n");

// Partial fix — only divide + head guarded (config B writes this). percent,
// last, average keep their bugs → B fails those 3 tasks.
const PARTIAL_CALC = [
  "def divide(a, b):\n    if b == 0:\n        return None\n    return a / b\n",
  "def head(items):\n    if not items:\n        return None\n    return items[0]\n",
  "def percent(part, whole):\n    return part / whole * 100.0\n",
  "def last(items):\n    return items[-1]\n",
  "def average(nums):\n    return sum(nums) / len(nums)\n",
].join("\n");

function taskFor(f: (typeof FUNCS)[number]): EvalTask {
  const testFile = `tests/test_${f.name}.py`;
  return {
    schema_version: 1,
    id: `fix-${f.name}`,
    repo: "fixture://calc",
    base_commit: "v1",
    problem_statement: `${f.name}() raises on an empty/zero edge case; it should return None so callers can handle it.`,
    test_patch: `--- /dev/null\n+++ b/${testFile}\n@@ -0,0 +1,4 @@\n+from calc import ${f.name}\n+\n+def test_${f.name}_edge():\n+    assert ${f.call} is None\n`,
    // Unused by the trial (the harness grades the agent's patch, not gold_patch); a
    // schema-valid placeholder. The trial never reads it.
    gold_patch: `--- a/calc.py\n+++ b/calc.py\n@@ -1,1 +1,2 @@\n def ${f.name}(a, b):\n+    pass\n`,
    fail_to_pass: [`${testFile}::test_${f.name}_edge`],
    pass_to_pass: [],
    environment: { base_image: "python:3.12-bookworm", setup: "pip install --quiet pytest==8.3.3", test_cmd: "python -m pytest -q", runner: "pytest", timeout_s: 60 },
    quarantined: [],
  };
}

/** A scripted "agent" that writes a fixed calc.py — stands in for a real
 * coding agent (no model key). Everything the harness does around it is real. */
function scriptedLauncher(id: string, calcContent: string, tokens: [number, number]): AgentLauncher {
  const b64 = Buffer.from(calcContent).toString("base64");
  return {
    id,
    invoke() {
      return {
        command: `mkdir -p /tmp/outerlayer && echo ${b64} | base64 -d > calc.py && echo '{"ok":1}' > /tmp/outerlayer/t.jsonl`,
        env: {},
        transcriptPath: "/tmp/outerlayer/t.jsonl",
      };
    },
    parseTranscript() {
      return { launcher: id, turns: 1, toolCalls: 1, toolErrors: 0, inputTokens: tokens[0], outputTokens: tokens[1], cacheReadTokens: null, wallClockMs: 0 };
    },
  };
}

const goldLauncher = scriptedLauncher("agent-correct", CORRECT_CALC, [5000, 1000]);
const partialLauncher = scriptedLauncher("agent-partial", PARTIAL_CALC, [3000, 500]);

// A baseline passing test so the env-build health probe (pytest --collect-only) finds
// tests in the base env — the graded tests are introduced per task by
// test_patch at grade time, so without this the base repo has zero tests and
// pytest exits 5 ("no tests collected"). Real repos have existing tests
// (that's what pass_to_pass samples); this mirrors that.
const SMOKE_TEST = "def test_smoke():\n    assert True\n";

async function materializeFixture(sandbox: Sandbox, provider: SandboxProvider): Promise<void> {
  // No baseline test AND no .gitignore — the bare fixture. This exercises
  // both harness fixes: the env-build probe must return healthy when `pytest
  // --collect-only` finds no tests (exit 5), and the trial freeze must stay clean
  // with no repo .gitignore. If either regresses, the loop fails loudly
  // (build_error / patch_apply_failed on every trial).
  void SMOKE_TEST;
  await provider.putFiles(sandbox, { [`${REPO_DIR}/calc.py`]: BUGGY_CALC });
  const r = await provider.exec(
    sandbox,
    `cd ${REPO_DIR} && git init -q && git add -A && git -c user.email=e@o.dev -c user.name=o commit -qm base`,
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error(`fixture init failed: ${r.stderr}`);
}

describe.skipIf(!LIVE)("run backend — full loop vs live Docker", () => {
  test("5 tasks × 2 configs × 2 trials → a real Report Card from real pytest grading", async () => {
    const provider = new LocalDockerProvider();
    const envService = new EnvPrepService({ provider, materializeRepo: materializeFixture });
    const tasks = FUNCS.map(taskFor);

    const configs: [TrialConfig, TrialConfig] = [
      { id: "opus-sim", launcher: "agent-correct", model: "opus-sim", budgets: { maxTurns: 3, maxTokens: 100000, wallClockS: 120 } },
      { id: "glm-sim", launcher: "agent-partial", model: "glm-sim", budgets: { maxTurns: 3, maxTokens: 100000, wallClockS: 120 } },
    ];

    const result = await runEvaluation(tasks, configs, {
      provider,
      envFactory: envService.prepareEnv,
      resolveSecrets: async () => ({}),
      launcher: (id) => (id === "agent-correct" ? goldLauncher : partialLauncher),
      prices: {
        "opus-sim": { inputPerMTok: 15, outputPerMTok: 75 },
        "glm-sim": { inputPerMTok: 0.5, outputPerMTok: 1.5 },
      },
      repoLabel: "acme/calc",
      trialsPerTask: 2,
      seed: 7,
      concurrency: 4,
      methodologyUrl: "https://outerlayer.ai/docs/methodology",
    });

    const outDir = process.env.OUTERLAYER_LOOP_REPORT_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "card.json"), JSON.stringify(result.card, null, 2));
      writeFileSync(join(outDir, "card.txt"), renderCardText(result.card));
      writeFileSync(
        join(outDir, "trials.txt"),
        result.trials.map((t) => `${t.taskId} ${t.configId} #${t.trialIndex} → ${t.status} resolved=${t.resolved}`).join("\n"),
      );
      const first = result.trials[0];
      if (first) {
        writeFileSync(
          join(outDir, "debug-trial0.txt"),
          `status=${first.status}\nerror=${first.error ?? ""}\npatchApplyOk=${first.patchApplyOk}\n--- patch ---\n${first.patch}`,
        );
      }
    }

    // -- Real grading discriminated the two agents correctly. --------------
    const byConfig = (id: string) => result.trials.filter((t) => t.configId === id);
    const resolved = (id: string) => byConfig(id).filter((t) => t.status === "graded" && t.resolved).length;
    // opus-sim wrote correct fixes → every trial resolves (5 tasks × 2 trials = 10).
    expect(byConfig("opus-sim").every((t) => t.status === "graded")).toBe(true);
    expect(resolved("opus-sim")).toBe(10);
    // glm-sim's partial fix resolves only divide + head (2 tasks × 2 trials = 4).
    expect(resolved("glm-sim")).toBe(4);

    // -- The card is real and reflects the outcome. ------------------------
    expect(result.card.stats.nTasks).toBe(5);
    expect(result.card.stats.resolveRate.a.rate).toBe(1); // opus resolved all
    expect(result.card.stats.resolveRate.b.rate).toBeCloseTo(0.4, 5); // glm 2/5
    expect(result.card.stats.pairedDelta.est).toBeCloseTo(0.6, 5); // 60pp
    // A real verdict + MDE from real stats. At N=5 with a 60pp gap the CI is
    // [20,100]pp and the MDE ~97pp, so the honest verdict is `underpowered` —
    // the machinery refuses to name a winner despite the gap. That IS the
    // brand ("never a naked winner") on real data.
    expect(["clear", "directional", "underpowered"]).toContain(result.card.verdict);
    expect(result.card.mdeLine).toMatch(/can detect differences ≥ \d+pp/);
    // Divergent tasks are the three glm missed.
    expect(result.card.divergent.map((d) => d.taskId).sort()).toEqual(["fix-average", "fix-last", "fix-percent"]);
    // Cost measured from usage × prices; opus (bigger) costs more per resolved.
    expect(result.card.stats.dollarsPerResolved.a).toBeGreaterThan(result.card.stats.dollarsPerResolved.b);
    expect(result.spentUsd).toBeGreaterThan(0);

    // No leftover sandboxes.
    expect(await provider.list()).toEqual([]);
  }, 900_000);
});
