// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { parseTask } from "../loader.js";
import { parseUnifiedDiff } from "../diff.js";
import { buildTask, GOLD_PATCH, TEST_PATCH } from "./helpers.js";

function parseYamlTask(overrides: Record<string, unknown>) {
  const { schema_version: _ignored, ...base } = buildTask();
  return parseTask(stringify({ ...base, ...overrides }));
}

describe("evalTaskSchema via parseTask", () => {
  test("a well-formed task round-trips with defaults applied", () => {
    const result = parseYamlTask({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task).toEqual(buildTask());
  });

  test("rejects with field-pathed messages: short statement, bad test id, dupes, unknown field", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ problem_statement: "too short" }, /problem_statement: .*too short/i],
      [{ fail_to_pass: ["no-double-colon"] }, /not a valid pytest test id/],
      [
        { pass_to_pass: ["tests/test_divide_zero.py::test_divide_by_zero_returns_none"] },
        /both fail_to_pass and pass_to_pass/,
      ],
      [{ mystery_field: true }, /mystery_field/],
      [{ id: "Has Spaces" }, /id: .*slug/],
      [{ fail_to_pass: [] }, /at least one fail_to_pass/],
    ];
    for (const [overrides, message] of cases) {
      const result = parseYamlTask(overrides);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatch(message);
    }
  });

  test("rejects a patch that is not a unified diff", () => {
    const result = parseYamlTask({ gold_patch: "just some prose, not a diff" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/gold_patch: not a unified diff/);
  });

  test("jest/vitest ids require a JS-flavored file path segment", () => {
    const jsEnv = {
      base_image: "node:22-bookworm",
      setup: "",
      test_cmd: "npx vitest run",
      runner: "vitest",
      timeout_s: 60,
    };
    const good = parseYamlTask({
      environment: jsEnv,
      fail_to_pass: ["src/calc.test.ts::divides by zero returns null"],
      pass_to_pass: [],
    });
    expect(good.ok).toBe(true);
    const bad = parseYamlTask({
      environment: jsEnv,
      fail_to_pass: ["src/calc.py::not a js file"],
      pass_to_pass: [],
    });
    expect(bad.ok).toBe(false);
  });

  test("YAML anchors are usable for shared environment blocks", () => {
    const yaml = `
env: &env
  base_image: python:3.12-bookworm
  setup: pip install pytest
  test_cmd: python -m pytest -q
  runner: pytest
id: anchored-task
repo: https://example.invalid/r.git
base_commit: abc
problem_statement: ${JSON.stringify(buildTask().problem_statement)}
test_patch: ${JSON.stringify(TEST_PATCH)}
gold_patch: ${JSON.stringify(GOLD_PATCH)}
fail_to_pass: ["tests/test_divide_zero.py::test_divide_by_zero_returns_none"]
environment: *env
`;
    // Top-level extra key `env` violates strict(); anchors belong in multi-doc
    // sets. Assert the anchor RESOLVES (error is about the extra key, not YAML).
    const result = parseTask(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(/YAML parse error/);
    expect(result.error).toMatch(/env/);
  });
});

describe("parseUnifiedDiff", () => {
  test("extracts touched files and added lines; new files attribute to the +++ side", () => {
    expect(parseUnifiedDiff(TEST_PATCH)).toEqual({
      ok: true,
      files: ["tests/test_divide_zero.py"],
      addedLines: [
        "from calculator import divide",
        "",
        "",
        "def test_divide_by_zero_returns_none():",
        "    assert divide(1, 0) is None",
        "",
      ],
    });
  });

  test("malformed hunk header is rejected with the offending line", () => {
    const result = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ nonsense @@\n+line\n");
    expect(result).toEqual({
      ok: false,
      error: "malformed hunk header: @@ nonsense @@",
      files: [],
      addedLines: [],
    });
  });
});
