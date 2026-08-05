// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// The run backend end to end with a REAL coding agent — the seam the scripted
// loop (loop.live.test.ts) deliberately stubbed. Nothing here is simulated:
// the actual `claude` CLI runs headless inside a Docker sandbox, reads only the
// problem statement (it NEVER sees the hidden test — that's applied at grade
// time in a fresh sandbox), edits the repo, and its patch is graded by real
// pytest. Then real eval-stats → a real Report Card.
//
// Gated (needs Docker, the agent image, a key, and real spend):
//   OUTERLAYER_AGENT_LIVE=1 ANTHROPIC_API_KEY=sk-ant-… \
//   OUTERLAYER_LOOP_REPORT_DIR=/tmp/ol-agent yarn test:agent-live
//
// Knobs (env): OUTERLAYER_AGENT_MODEL_A / _B (default sonnet vs haiku),
//   OUTERLAYER_AGENT_TASKS (default 3), OUTERLAYER_AGENT_TRIALS (default 1),
//   OUTERLAYER_AGENT_IMAGE (default outerlayer-agent:py312).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalDockerProvider, type SandboxProvider, type Sandbox } from "@outerlayer/runner-core";
import { EnvPrepService } from "@outerlayer/env-prep";
import { REPO_DIR, type EvalTask } from "@outerlayer/task-format";
import type { TrialConfig } from "@outerlayer/trial-harness";
import { renderCardText } from "@outerlayer/report-card";
import { runEvaluation } from "../runner.js";

const LIVE = process.env.OUTERLAYER_AGENT_LIVE === "1";
const KEY = process.env.ANTHROPIC_API_KEY ?? "";
const IMAGE = process.env.OUTERLAYER_AGENT_IMAGE ?? "outerlayer-agent:py312";
const MODEL_A = process.env.OUTERLAYER_AGENT_MODEL_A ?? "claude-sonnet-5";
const MODEL_B = process.env.OUTERLAYER_AGENT_MODEL_B ?? "claude-haiku-4-5-20251001";
const NUM_TASKS = Number(process.env.OUTERLAYER_AGENT_TASKS ?? "3");
const TRIALS = Number(process.env.OUTERLAYER_AGENT_TRIALS ?? "1");

// Buggy functions — one bug-fix task each. The agent must infer the fix from
// the statement alone; the hidden test that decides pass/fail arrives only at
// grade time via test_patch.
const FUNCS = [
  { name: "divide", body: "def divide(a, b):\n    return a / b\n", call: "divide(1, 0)" },
  { name: "head", body: "def head(items):\n    return items[0]\n", call: "head([])" },
  { name: "percent", body: "def percent(part, whole):\n    return part / whole * 100.0\n", call: "percent(1, 0)" },
  { name: "last", body: "def last(items):\n    return items[-1]\n", call: "last([])" },
  { name: "average", body: "def average(nums):\n    return sum(nums) / len(nums)\n", call: "average([])" },
];
const CHOSEN = FUNCS.slice(0, Math.max(1, Math.min(FUNCS.length, NUM_TASKS)));
const BUGGY_CALC = FUNCS.map((f) => f.body).join("\n");

function taskFor(f: (typeof FUNCS)[number]): EvalTask {
  const testFile = `tests/test_${f.name}.py`;
  return {
    schema_version: 1,
    id: `fix-${f.name}`,
    repo: "fixture://calc",
    base_commit: "v1",
    problem_statement:
      `In calc.py, ${f.name}() crashes on an empty-or-zero edge case (e.g. \`${f.call}\`). ` +
      `Fix it so that instead of raising, it returns None on that edge case. Edit only calc.py.`,
    test_patch: `--- /dev/null\n+++ b/${testFile}\n@@ -0,0 +1,4 @@\n+from calc import ${f.name}\n+\n+def test_${f.name}_edge():\n+    assert ${f.call} is None\n`,
    gold_patch: `--- a/calc.py\n+++ b/calc.py\n@@ -1,1 +1,2 @@\n def ${f.name}(a, b):\n+    pass\n`,
    fail_to_pass: [`${testFile}::test_${f.name}_edge`],
    pass_to_pass: [],
    environment: { base_image: IMAGE, setup: "", test_cmd: "python -m pytest -q", runner: "pytest", timeout_s: 120 },
    quarantined: [],
  };
}

async function materializeFixture(sandbox: Sandbox, provider: SandboxProvider): Promise<void> {
  await provider.putFiles(sandbox, { [`${REPO_DIR}/calc.py`]: BUGGY_CALC });
  const r = await provider.exec(
    sandbox,
    `cd ${REPO_DIR} && git init -q && git add -A && git -c user.email=e@o.dev -c user.name=o commit -qm base`,
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error(`fixture init failed: ${r.stderr}`);
}

describe.skipIf(!LIVE)("run backend — full loop with a REAL claude-code agent", () => {
  test(
    "a real agent fixes real bugs in a sandbox; real pytest grades the patch → a real Report Card",
    async () => {
      expect(KEY, "ANTHROPIC_API_KEY must be set for the live agent run").not.toBe("");

      const provider = new LocalDockerProvider();
      const envService = new EnvPrepService({ provider, materializeRepo: materializeFixture });
      const tasks = CHOSEN.map(taskFor);

      const budgets = { maxTurns: 12, maxTokens: 200_000, wallClockS: 240 };
      const configs: [TrialConfig, TrialConfig] = [
        { id: MODEL_A, launcher: "claude-code", model: MODEL_A, budgets },
        { id: MODEL_B, launcher: "claude-code", model: MODEL_B, budgets },
      ];

      const result = await runEvaluation(tasks, configs, {
        provider,
        envFactory: envService.prepareEnv,
        // The real secrets path — injected per-exec into the agent sandbox only.
        resolveSecrets: async () => ({ ANTHROPIC_API_KEY: KEY }),
        // No custom launcher factory: config.launcher "claude-code" resolves to
        // the real claudeCodeLauncher by default. THAT is the point of this test.
        prices: {
          [MODEL_A]: { inputPerMTok: 3, outputPerMTok: 15 },
          [MODEL_B]: { inputPerMTok: 1, outputPerMTok: 5 },
        },
        repoLabel: "acme/calc (real agent)",
        trialsPerTask: TRIALS,
        seed: 7,
        concurrency: 2,
        methodologyUrl: "https://outerlayer.ai/docs/methodology",
      });

      const outDir = process.env.OUTERLAYER_LOOP_REPORT_DIR;
      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "agent-card.json"), JSON.stringify(result.card, null, 2));
        writeFileSync(join(outDir, "agent-card.txt"), renderCardText(result.card));
        writeFileSync(
          join(outDir, "agent-trials.txt"),
          result.trials
            .map(
              (t) =>
                `${t.taskId} ${t.configId} #${t.trialIndex} → ${t.status} resolved=${t.resolved} ` +
                `turns=${t.trajectory?.turns ?? "?"} tok=${(t.trajectory?.inputTokens ?? 0) + (t.trajectory?.outputTokens ?? 0)} $${t.cost.usd.toFixed(4)}` +
                (t.error ? ` err=${t.error.slice(0, 120)}` : ""),
            )
            .join("\n"),
        );
        // The first trial's actual agent-authored patch — proof the agent edited real code.
        const first = result.trials.find((t) => t.patch) ?? result.trials[0];
        if (first) writeFileSync(join(outDir, "agent-patch-sample.diff"), first.patch || "(empty patch)");
      }

      // -- The harness plumbing worked: no build/infra failures. --------------
      const infraFailed = result.trials.filter((t) => t.status === "build_error" || t.status === "infra_error");
      expect(infraFailed, `infra failures: ${infraFailed.map((t) => `${t.taskId}/${t.configId}:${t.error}`).join("; ")}`).toEqual([]);

      // -- THE PROOF: a real agent's real patch passed a real hidden test. -----
      const graded = result.trials.filter((t) => t.status === "graded");
      const resolved = result.trials.filter((t) => t.status === "graded" && t.resolved);
      expect(graded.length, "every trial reached a graded verdict").toBe(tasks.length * 2 * TRIALS);
      expect(resolved.length, "at least one real-agent patch resolved its task under real grading").toBeGreaterThan(0);

      // A real agent produced a real, non-empty unified diff that git applied.
      const withPatch = result.trials.find((t) => t.resolved);
      expect(withPatch?.patch ?? "").toContain("calc.py");
      expect(withPatch?.patchApplyOk).toBe(true);
      // Trajectory parsed from real claude-code stream-json (not the stub).
      expect((withPatch?.trajectory?.turns ?? 0)).toBeGreaterThan(0);

      // -- The card is real and internally consistent. ------------------------
      expect(result.card.stats.nTasks).toBe(tasks.length);
      expect(["clear", "directional", "underpowered"]).toContain(result.card.verdict);
      expect(result.card.mdeLine).toMatch(/can detect differences ≥ \d+pp/);
      expect(result.spentUsd).toBeGreaterThan(0);

      // No leaked sandboxes.
      expect(await provider.list()).toEqual([]);
    },
    1_800_000,
  );
});
