// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Live execution-gate run against the real local Docker daemon. Gated:
//   OUTERLAYER_GATE_LIVE=1 yarn test:gate-live
//
// One fixture repo (python + pytest), seven tasks — the good path plus one
// task per failure class — validated end to end through runner-core's
// LocalDockerProvider: env built once (clone-less fixture materializer +
// pip install at build), every task after the first is a snapshot cache
// hit, gate sandboxes run network:none.
//
// Set OUTERLAYER_GATE_REPORT_DIR to also write report.json + report.txt
// (used for the PR evidence screenshots).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalDockerProvider } from "@outerlayer/runner-core";
import type { Sandbox, SandboxProvider } from "@outerlayer/runner-core";
import { taskEnvKey, validateTasks } from "../gate.js";
import { renderReportText } from "../report.js";
import type { EvalTask } from "../schema.js";
import { buildTask, GOLD_PATCH, TEST_PATCH } from "./helpers.js";

const LIVE = process.env.OUTERLAYER_GATE_LIVE === "1";

const CALCULATOR_PY = `def divide(a, b):
    return a / b


def subtract(a, b):
    return a - b
`;

const TEST_BASIC_PY = `import os

from calculator import subtract


def test_subtract():
    assert subtract(5, 3) == 2


def test_flaky_counter():
    path = os.path.join(os.path.dirname(__file__), "..", "flake_counter.txt")
    count = 0
    if os.path.exists(path):
        with open(path) as handle:
            count = int(handle.read().strip() or "0")
    with open(path, "w") as handle:
        handle.write(str(count + 1))
    assert count % 2 == 0
`;

/** Fixture materializer: the repo lands via putFiles + git init — no remote
 * clone, so the live run exercises everything except network fetch. */
async function materializeFixtureRepo(
  sandbox: Sandbox,
  provider: SandboxProvider,
): Promise<void> {
  await provider.putFiles(sandbox, {
    "/work/repo/calculator.py": CALCULATOR_PY,
    "/work/repo/tests/test_basic.py": TEST_BASIC_PY,
  });
  const result = await provider.exec(
    sandbox,
    "cd /work/repo && git init -q && git add -A && git -c user.email=gate@outerlayer.dev -c user.name=gate commit -qm base",
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) throw new Error(`fixture git init failed: ${result.stderr}`);
}

const NON_FIXING_GOLD = `--- a/calculator.py
+++ b/calculator.py
@@ -5,2 +5,3 @@
 def subtract(a, b):
+    # does not touch divide at all
     return a - b
`;

const OVERLAPPING_GOLD = `--- a/tests/test_divide_zero.py
+++ b/tests/test_divide_zero.py
@@ -1,1 +1,2 @@
 from calculator import divide
+cheat = True
`;

const SENTINEL_GOLD = `--- a/calculator.py
+++ b/calculator.py
@@ -1,2 +1,6 @@
 def divide(a, b):
+    def zero_sentinel(value):
+        return value == 0
+    if zero_sentinel(b):
+        return None
     return a / b
`;

const ALREADY_PASSING_TEST_PATCH = `--- /dev/null
+++ b/tests/test_already_passing.py
@@ -0,0 +1,5 @@
+from calculator import divide
+
+
+def test_divide_works_for_even_numbers():
+    assert divide(4, 2) == 2
+`;

function fixtureTask(overrides: Partial<EvalTask>): EvalTask {
  return buildTask({ repo: "fixture://calculator", base_commit: "fixture-v1", ...overrides });
}

describe.skipIf(!LIVE)("execution gate vs live local Docker", () => {
  test("seven-task matrix: good path + one task per failure class, one env build", async () => {
    const provider = new LocalDockerProvider();
    // The matrix asserts a cold first build; drop whatever snapshot a
    // previous local run committed so the suite is re-runnable per machine.
    await provider.removeEnvImage(taskEnvKey(fixtureTask({})));
    const tasks: EvalTask[] = [
      fixtureTask({ id: "demo-good" }),
      fixtureTask({ id: "demo-f2p-already-passing", test_patch: ALREADY_PASSING_TEST_PATCH, fail_to_pass: ["tests/test_already_passing.py::test_divide_works_for_even_numbers"] }),
      fixtureTask({ id: "demo-gold-does-not-fix", gold_patch: NON_FIXING_GOLD }),
      fixtureTask({
        id: "demo-flaky-p2p",
        pass_to_pass: ["tests/test_basic.py::test_subtract", "tests/test_basic.py::test_flaky_counter"],
      }),
      fixtureTask({ id: "demo-bad-test-id", fail_to_pass: ["tests/test_divide_zero.py::test_nope"] }),
      fixtureTask({ id: "demo-patch-overlap", gold_patch: OVERLAPPING_GOLD }),
      fixtureTask({
        id: "demo-leaky-statement",
        gold_patch: SENTINEL_GOLD,
        problem_statement:
          "Division crashes on zero — fix by introducing zero_sentinel in the calculator module and returning None from divide.",
      }),
    ];

    const phases: string[] = [];
    const report = await validateTasks(tasks, {
      provider,
      materializeRepo: (sandbox, sandboxProvider) =>
        materializeFixtureRepo(sandbox, sandboxProvider),
      onPhase: (taskId, phase) => phases.push(`${taskId}: ${phase}`),
    });

    const outDir = process.env.OUTERLAYER_GATE_REPORT_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
      writeFileSync(join(outDir, "report.txt"), renderReportText(report));
      writeFileSync(join(outDir, "phases.txt"), phases.join("\n"));
    }

    expect(report.tasks.map((entry) => [entry.taskId, entry.status, entry.reason ?? null])).toEqual([
      ["demo-good", "valid", null],
      ["demo-f2p-already-passing", "invalid", "f2p_pass_prefix"],
      ["demo-gold-does-not-fix", "invalid", "gold_fails"],
      ["demo-flaky-p2p", "valid", null],
      ["demo-bad-test-id", "invalid", "bad_test_id"],
      ["demo-patch-overlap", "invalid", "patch_overlap"],
      ["demo-leaky-statement", "needs_review", null],
    ]);

    // Real pytest produced the flake pattern; the gate quarantined it.
    const flaky = report.tasks.find((entry) => entry.taskId === "demo-flaky-p2p")!;
    expect(flaky.quarantined).toEqual([
      {
        id: "tests/test_basic.py::test_flaky_counter",
        reason: "mixed outcomes across gate rounds",
        evidence: "pass,fail,pass",
      },
    ]);

    // One env build for the whole matrix — every later task is a cache hit.
    const envEntries = report.tasks.filter((entry) => entry.env);
    expect(envEntries[0]!.env!.built).toBe(true);
    for (const entry of envEntries.slice(1)) expect(entry.env!.built).toBe(false);

    // Determinism capture against the real daemon: every green entry pins the base
    // image's registry digest; rejected tasks never carry the block. (The
    // fixture repo has no lockfiles, so the block is digest-only.)
    for (const entry of report.tasks) {
      if (entry.status === "invalid") expect(entry.determinism).toBeUndefined();
      else expect(entry.determinism).toEqual({ image_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    }

    // Acceptance: warm re-validate of an unchanged task under 60s.
    const rerunStart = Date.now();
    const rerun = await validateTasks([tasks[0]!], {
      provider,
      materializeRepo: (sandbox, sandboxProvider) =>
        materializeFixtureRepo(sandbox, sandboxProvider),
    });
    const rerunMs = Date.now() - rerunStart;
    expect(rerun.tasks[0]!.status).toBe("valid");
    expect(rerun.tasks[0]!.env!.built).toBe(false);
    expect(rerunMs).toBeLessThan(60_000);
    if (outDir) {
      writeFileSync(
        join(outDir, "rerun.txt"),
        `warm re-validate of demo-good: ${rerunMs}ms (cache hit, <60s acceptance)\n`,
      );
    }

    // Zero leftovers: nothing labeled ours is still alive.
    expect(await provider.list()).toEqual([]);
  }, 900_000);
});
