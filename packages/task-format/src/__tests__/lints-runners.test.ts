// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { lintTask } from "../lints.js";
import { runnerAdapter, splitTestId } from "../runners.js";
import { buildTask, execResult } from "./helpers.js";

describe("lintTask", () => {
  test("clean task carries no errors and no flags", () => {
    expect(lintTask(buildTask())).toEqual({ errors: [], flags: [] });
  });

  test("gold_patch touching a test file is the patch_overlap error", () => {
    const task = buildTask({
      gold_patch: `--- a/tests/test_divide_zero.py
+++ b/tests/test_divide_zero.py
@@ -1,2 +1,3 @@
 from calculator import divide
+# gold sneaking into the test file
 x = 1
`,
    });
    expect(lintTask(task).errors).toEqual([
      {
        reason: "patch_overlap",
        detail: "test_patch and gold_patch both touch: tests/test_divide_zero.py",
      },
    ]);
  });

  test("statement naming a symbol the gold patch defines is flagged, not rejected", () => {
    const task = buildTask({
      gold_patch: `--- a/calculator.py
+++ b/calculator.py
@@ -1,2 +1,5 @@
 def divide(a, b):
+    def safe_zero_guard(value):
+        return value == 0
     return a / b
`,
      problem_statement:
        "Division crashes on zero. I fixed this by adding safe_zero_guard to the calculator module so it returns None instead.",
    });
    const result = lintTask(task);
    expect(result.errors).toEqual([]);
    expect(result.flags).toContain("statement_leak:safe_zero_guard");
  });

  test("empty pass_to_pass and unpinned image are review flags", () => {
    const task = buildTask({
      pass_to_pass: [],
      environment: { ...buildTask().environment, base_image: "python:latest" },
    });
    expect(lintTask(task).flags).toEqual(["empty_pass_to_pass", "unpinned_base_image"]);
  });
});

describe("runner adapters", () => {
  test("pytest addresses node ids natively and shell-escapes them", () => {
    const adapter = runnerAdapter("pytest");
    const command = adapter.buildCommand("python -m pytest -q", "tests/test_x.py::test_o'brien");
    expect(command).toBe(`python -m pytest -q 'tests/test_x.py::test_o'\\''brien'`);
  });

  test("jest/vitest split file from name on the FIRST :: and pass -t", () => {
    expect(splitTestId("src/a.test.ts::renders: the empty state")).toEqual({
      file: "src/a.test.ts",
      name: "renders: the empty state",
    });
    const command = runnerAdapter("vitest").buildCommand(
      "npx vitest run",
      "src/a.test.ts::renders: the empty state",
    );
    expect(command).toBe(`npx vitest run 'src/a.test.ts' -t 'renders: the empty state'`);
  });

  test("probeHealthy: 'no tests' is healthy, import/config breakage is not", () => {
    const pytest = runnerAdapter("pytest");
    expect(pytest.probeHealthy(execResult({ code: 0 }))).toBe(true); // collected
    expect(pytest.probeHealthy(execResult({ code: 5 }))).toBe(true); // no tests collected — still healthy
    expect(pytest.probeHealthy(execResult({ code: 2, stderr: "ImportError: no module named httpx" }))).toBe(false); // collection error

    const jest = runnerAdapter("jest");
    expect(jest.probeHealthy(execResult({ code: 0 }))).toBe(true);
    expect(jest.probeHealthy(execResult({ code: 1, stderr: "No tests found, exiting with code 1" }))).toBe(true); // empty but healthy
    expect(jest.probeHealthy(execResult({ code: 1, stderr: "Cannot find module 'react'" }))).toBe(false); // real break

    const vitest = runnerAdapter("vitest");
    expect(vitest.probeHealthy(execResult({ code: 1, stderr: "No test files found" }))).toBe(true);
    expect(vitest.probeHealthy(execResult({ code: 1, stderr: "SyntaxError: Unexpected token" }))).toBe(false);
  });

  test("classification: exit codes, timeouts, and not-found markers", () => {
    const pytest = runnerAdapter("pytest");
    expect(pytest.classify(execResult({ code: 0 }))).toBe("pass");
    expect(pytest.classify(execResult({ code: 1 }))).toBe("fail");
    expect(pytest.classify(execResult({ code: 5, stderr: "no tests ran" }))).toBe("not_found");
    expect(pytest.classify(execResult({ code: 4 }))).toBe("not_found");
    expect(pytest.classify(execResult({ code: 124, timedOut: true }))).toBe("fail");

    const jest = runnerAdapter("jest");
    expect(jest.classify(execResult({ code: 1, stderr: "No tests found, exiting with code 1" }))).toBe(
      "not_found",
    );
    expect(jest.classify(execResult({ code: 0 }))).toBe("pass");
    expect(jest.classify(execResult({ code: 1, stdout: "2 failed" }))).toBe("fail");

    const vitest = runnerAdapter("vitest");
    expect(vitest.classify(execResult({ code: 1, stderr: "No test files found" }))).toBe("not_found");
    expect(vitest.classify(execResult({ code: 124, timedOut: true }))).toBe("fail");
  });
});
