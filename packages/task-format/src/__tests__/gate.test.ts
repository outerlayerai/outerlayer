// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// The classification matrix: one seeded fixture per failure
// class, each classified with the correct reason — plus the invariants the
// spec calls sacred: no env spend on static rejects, no sandbox leaks, and
// the snapshot leak check.

import { describe, expect, test } from "vitest";
import type { ExecResult } from "@outerlayer/runner-core";
import {
  lockfileHashCommand,
  parseLockfileHashes,
  taskEnvKey,
  validateTask,
  validateTasks,
} from "../gate.js";
import { renderReportText } from "../report.js";
import { buildTask, execResult, FAIL, FakeProvider, NOT_FOUND, PASS } from "./helpers.js";

const F2P_FRAGMENT = "test_divide_by_zero_returns_none";
const P2P_FRAGMENT = "test_subtract";

interface Script {
  testPatchApply?: ExecResult;
  goldApply?: ExecResult;
  f2p?: (invocation: number) => ExecResult;
  p2p?: (invocation: number) => ExecResult;
  leakGrep?: ExecResult;
  /** Determinism-capture hash run; a function may throw to simulate provider
   * trouble. Default: empty output (no lockfiles found). */
  lockfiles?: ExecResult | (() => ExecResult);
}

function scripted(script: Script = {}): FakeProvider {
  return new FakeProvider((cmd, invocation) => {
    if (cmd.includes("sha256sum")) {
      return typeof script.lockfiles === "function"
        ? script.lockfiles()
        : (script.lockfiles ?? execResult());
    }
    // Leak-grep before the test branches: its marker arguments quote patch
    // lines that CONTAIN the test names, so those branches would shadow it.
    if (cmd.includes("grep -rF")) return script.leakGrep ?? execResult({ code: 1 });
    if (cmd.includes("test.patch")) return script.testPatchApply ?? PASS;
    if (cmd.includes("gold.patch")) return script.goldApply ?? PASS;
    if (cmd.includes(F2P_FRAGMENT)) {
      // Invocation 1 is the pre-gold run (must fail); 2..N are with-gold.
      return script.f2p ? script.f2p(invocation) : invocation === 1 ? FAIL : PASS;
    }
    if (cmd.includes(P2P_FRAGMENT)) return script.p2p ? script.p2p(invocation) : PASS;
    return PASS;
  });
}

describe("validateTask classification", () => {
  test("good task: valid, with per-round evidence, cached env on re-run, zero leaked sandboxes", async () => {
    const provider = scripted();
    const task = buildTask();
    const entry = await validateTask(task, { provider });

    expect(entry).toEqual({
      taskId: "demo-good",
      status: "valid",
      flags: [],
      quarantined: [],
      env: { key: taskEnvKey(task), imageRef: `fake-env:${taskEnvKey(task)}`, built: true },
      runs: {
        f2pPreGold: { [task.fail_to_pass[0]!]: ["fail"] },
        f2pWithGold: { [task.fail_to_pass[0]!]: ["pass", "pass", "pass"] },
        passToPass: { [task.pass_to_pass[0]!]: ["pass", "pass", "pass"] },
      },
      timings: { envMs: expect.any(Number), gateMs: expect.any(Number) },
    });
    // Gate sandbox + leak-check sandbox, both destroyed.
    expect(provider.created).toBe(2);
    expect(provider.destroyed).toBe(2);

    const second = await validateTask(task, { provider });
    expect(second.env).toEqual({
      key: taskEnvKey(task),
      imageRef: `fake-env:${taskEnvKey(task)}`,
      built: false, // idempotent prepareEnv — the cache-aware acceptance box
    });
  });

  test("F2P passing before gold ⇒ f2p_pass_prefix, and gold_patch is never applied", async () => {
    const provider = scripted({ f2p: () => PASS });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.status).toBe("invalid");
    expect(entry.reason).toBe("f2p_pass_prefix");
    expect(entry.detail).toContain(F2P_FRAGMENT);
    expect(provider.execLog.some((cmd) => cmd.includes("gold.patch"))).toBe(false);
    expect(provider.destroyed).toBe(provider.created);
  });

  test("F2P still failing with gold ⇒ gold_fails", async () => {
    const provider = scripted({ f2p: () => FAIL });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.reason).toBe("gold_fails");
    expect(entry.detail).toContain(F2P_FRAGMENT);
  });

  test("mixed P2P outcomes ⇒ test quarantined with evidence, task stays valid", async () => {
    const provider = scripted({
      p2p: (invocation) => (invocation === 2 ? FAIL : PASS),
    });
    const task = buildTask();
    const entry = await validateTask(task, { provider });
    expect(entry.status).toBe("valid");
    expect(entry.quarantined).toEqual([
      {
        id: task.pass_to_pass[0]!,
        reason: "mixed outcomes across gate rounds",
        evidence: "pass,fail,pass",
      },
    ]);
  });

  test("every F2P flaky ⇒ flaky_f2p_exhausted", async () => {
    const provider = scripted({
      // invocation 1 = pre-gold (fail ✓); with-gold rounds mixed.
      f2p: (invocation) => (invocation === 1 || invocation === 3 ? FAIL : PASS),
    });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.reason).toBe("flaky_f2p_exhausted");
  });

  test("P2P failing every round ⇒ p2p_fail", async () => {
    const provider = scripted({ p2p: () => FAIL });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.reason).toBe("p2p_fail");
    expect(entry.detail).toContain(P2P_FRAGMENT);
  });

  test("unknown test id ⇒ bad_test_id", async () => {
    const provider = scripted({ f2p: () => NOT_FOUND });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.reason).toBe("bad_test_id");
  });

  test("test_patch that does not apply ⇒ test_patch_apply_failed, no tests run", async () => {
    const provider = scripted({
      testPatchApply: execResult({ code: 1, stderr: "error: patch failed: tests/x.py:1" }),
    });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.reason).toBe("test_patch_apply_failed");
    expect(entry.detail).toContain("patch failed");
    expect(provider.execLog.some((cmd) => cmd.includes(F2P_FRAGMENT))).toBe(false);
  });

  test("env factory failure ⇒ env_fail with the build error, no sandboxes created", async () => {
    const provider = scripted();
    const entry = await validateTask(buildTask(), {
      provider,
      envFactory: async () => {
        throw new Error("pip install exploded: no matching distribution");
      },
    });
    expect(entry.status).toBe("invalid");
    expect(entry.reason).toBe("env_fail");
    expect(entry.detail).toContain("pip install exploded");
    expect(provider.created).toBe(0);
  });

  test("patch content found in a fresh snapshot sandbox ⇒ leak", async () => {
    const provider = scripted({
      leakGrep: execResult({ code: 0, stdout: "/work/repo/calculator.py:    if b == 0:" }),
    });
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.reason).toBe("leak");
    expect(entry.detail).toContain("calculator.py");
  });

  test("patch_overlap rejects statically — zero env or sandbox spend", async () => {
    const provider = scripted();
    const task = buildTask({
      gold_patch: `--- a/tests/test_divide_zero.py
+++ b/tests/test_divide_zero.py
@@ -1,1 +1,2 @@
 from calculator import divide
+cheat = True
`,
    });
    const entry = await validateTask(task, { provider });
    expect(entry.reason).toBe("patch_overlap");
    expect(provider.prepareEnvCalls).toBe(0);
    expect(provider.created).toBe(0);
  });

  test("statement_leak flag downgrades a passing task to needs_review, evidence intact", async () => {
    const provider = scripted();
    const task = buildTask({
      gold_patch: `--- a/calculator.py
+++ b/calculator.py
@@ -1,2 +1,4 @@
 def divide(a, b):
+    def zero_sentinel(value):
+        return value == 0
     return a / b
`,
      problem_statement:
        "Division crashes on zero — fix by introducing zero_sentinel in the calculator module and returning None from divide.",
    });
    const entry = await validateTask(task, { provider });
    expect(entry.status).toBe("needs_review");
    expect(entry.flags).toEqual(["statement_leak:zero_sentinel"]);
    expect(entry.runs?.f2pWithGold[task.fail_to_pass[0]!]).toEqual(["pass", "pass", "pass"]);
  });

  test("clarity judge flags mark needs_review but never reject", async () => {
    const provider = scripted();
    const entry = await validateTask(buildTask(), {
      provider,
      judge: {
        assess: async () => ({
          sufficiency: 1,
          fairness: 3,
          rationale: "statement does not say what correct behavior is",
        }),
      },
    });
    expect(entry.status).toBe("needs_review");
    expect(entry.flags).toEqual([
      "clarity:insufficient_statement (statement does not say what correct behavior is)",
    ]);
  });

  test("pre-quarantined F2P ids are excluded; all-quarantined ⇒ flaky_f2p_exhausted", async () => {
    const provider = scripted();
    const task = buildTask({
      quarantined: [
        {
          id: "tests/test_divide_zero.py::test_divide_by_zero_returns_none",
          reason: "mixed outcomes across gate rounds",
          evidence: "pass,fail,pass",
        },
      ],
    });
    const entry = await validateTask(task, { provider });
    expect(entry.reason).toBe("flaky_f2p_exhausted");
    expect(entry.detail).toBe("every fail_to_pass test is quarantined");
  });
});

describe("determinism capture", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);
  const DIGEST = `sha256:${"d".repeat(64)}`;

  test("green gate records base-image digest + lockfile hashes, captured pre-patch", async () => {
    const provider = scripted({
      lockfiles: execResult({
        stdout: `${HASH_A}  ./requirements.txt\n${HASH_B} *./services/api/uv.lock\n`,
      }),
    });
    provider.imageDigest = DIGEST;
    const entry = await validateTask(buildTask(), { provider });

    expect(entry.status).toBe("valid");
    expect(entry.determinism).toEqual({
      image_digest: DIGEST,
      lockfile_hashes: {
        "requirements.txt": HASH_A,
        "services/api/uv.lock": HASH_B,
      },
    });
    // The pre-patch invariant: the hash run is the FIRST exec in the gate
    // sandbox — before test_patch can touch the checkout.
    expect(provider.execLog[0]).toBe(lockfileHashCommand());
    expect(provider.execLog[1]).toContain("test.patch");
  });

  test("an invalid task never carries the block, even though capture ran", async () => {
    const provider = scripted({
      f2p: () => FAIL, // gold_fails
      lockfiles: execResult({ stdout: `${HASH_A}  ./yarn.lock\n` }),
    });
    provider.imageDigest = DIGEST;
    const entry = await validateTask(buildTask(), { provider });

    expect(entry.reason).toBe("gold_fails");
    expect(entry.determinism).toBeUndefined();
    expect(provider.execLog[0]).toBe(lockfileHashCommand());
  });

  test("capture trouble is a flag, never a verdict", async () => {
    const provider = scripted({
      lockfiles: () => {
        throw new Error("hash pipeline exploded");
      },
    });
    const entry = await validateTask(buildTask(), { provider });

    expect(entry.status).toBe("valid");
    expect(entry.flags).toEqual(["determinism:capture_failed (hash pipeline exploded)"]);
    expect(entry.determinism).toBeUndefined();
  });

  test("digest-only capture (no lockfiles in the checkout)", async () => {
    const provider = scripted();
    provider.imageDigest = DIGEST;
    const entry = await validateTask(buildTask(), { provider });
    expect(entry.determinism).toEqual({ image_digest: DIGEST });
  });

  test("the hash pipeline is the exact busybox-safe command (literal golden)", () => {
    expect(lockfileHashCommand()).toBe(
      "cd /work/repo && find . -maxdepth 4 " +
        "\\( -name node_modules -o -name .git -o -name vendor -o -name .venv \\) -prune " +
        "-o -type f \\( -name 'package-lock.json' -o -name 'yarn.lock' -o -name 'pnpm-lock.yaml' " +
        "-o -name 'bun.lockb' -o -name 'poetry.lock' -o -name 'uv.lock' -o -name 'Pipfile.lock' " +
        "-o -name 'requirements*.txt' -o -name 'Cargo.lock' -o -name 'go.sum' " +
        "-o -name 'Gemfile.lock' -o -name 'composer.lock' \\) -print0 | sort -z | xargs -0 -r sha256sum",
    );
  });

  test("parseLockfileHashes: strips ./, accepts the binary marker, skips garbage, caps at 32", () => {
    const flood = Array.from(
      { length: 40 },
      (_, index) => `${HASH_A}  ./pkg-${String(index).padStart(2, "0")}/go.sum`,
    );
    const parsed = parseLockfileHashes(
      ["not a hash line", `${HASH_B} *./bun.lockb`, "deadbeef  ./too-short.lock", ...flood].join(
        "\n",
      ),
    );
    expect(parsed["bun.lockb"]).toBe(HASH_B);
    expect(parsed["too-short.lock"]).toBeUndefined();
    expect(Object.keys(parsed)).toHaveLength(32);
    expect(parsed["pkg-30/go.sum"]).toBe(HASH_A); // 31 flood entries kept…
    expect(parsed["pkg-31/go.sum"]).toBeUndefined(); // …then the cap bites
  });
});

describe("validateTasks report", () => {
  test("renders the pinned line for entries carrying determinism", async () => {
    const provider = scripted({
      lockfiles: execResult({ stdout: `${"a".repeat(64)}  ./yarn.lock\n${"b".repeat(64)}  ./go.sum\n` }),
    });
    provider.imageDigest = `sha256:${"d".repeat(64)}`;
    const report = await validateTasks([buildTask()], { provider });
    for (const entry of report.tasks) entry.timings = { envMs: 0, gateMs: 0 };
    expect(renderReportText(report)).toContain(
      `    pinned: digest sha256:dddddddddddd… · 2 lockfile hashes`,
    );
  });

  test("assembles the versioned report with summary and renders the terminal view", async () => {
    const provider = scripted();
    const overlapping = buildTask({
      id: "demo-overlap",
      gold_patch: `--- a/tests/test_divide_zero.py
+++ b/tests/test_divide_zero.py
@@ -1,1 +1,2 @@
 from calculator import divide
+cheat = True
`,
    });
    const report = await validateTasks([buildTask(), overlapping], { provider });

    expect(report.schemaVersion).toBe(1);
    expect(report.provider).toBe("fake");
    expect(report.flakeRounds).toBe(3);
    expect(report.summary).toEqual({
      total: 2,
      valid: 1,
      invalid: 1,
      needsReview: 0,
      byReason: { patch_overlap: 1 },
    });

    // Golden terminal rendering (timings normalized — they're wall-clock).
    for (const entry of report.tasks) entry.timings = { envMs: 0, gateMs: 0 };
    expect(renderReportText(report)).toBe(
      [
        "task validation — provider=fake rounds=3 tasks=2",
        "",
        `✓ demo-good  [valid]`,
        `    env ${taskEnvKey(buildTask())} (built)  env 0ms · gate 0ms`,
        `✗ demo-overlap  [invalid: patch_overlap]`,
        "    test_patch and gold_patch both touch: tests/test_divide_zero.py",
        "",
        "1 valid · 1 invalid · 0 needs_review",
        "rejections: patch_overlap=1",
      ].join("\n"),
    );
  });
});
