// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { validateInjection } from "../injection.js";
import type { BugInjection } from "../types.js";
import { CLAMP_INJECTION, PAGINATION_INJECTION, TEST_TOUCHING_INJECTION } from "./helpers.js";

describe("validateInjection", () => {
  test("rejects an injection that edits a test file (the leak vector)", () => {
    expect(validateInjection(TEST_TOUCHING_INJECTION)).toEqual({
      ok: false,
      reason: "touches_test_file",
      detail: "injection touches test path(s): tests/test_pagination.py",
    });
  });

  test.each([
    ["jest __tests__ dir", "src/__tests__/pagination.test.ts"],
    ["vitest .spec file", "packages/x/foo.spec.tsx"],
    ["pytest test_ file", "pkg/tests/test_boundary.py"],
    ["conftest", "conftest.py"],
  ])("rejects a %s injection structurally", (_label, path) => {
    const injection: BugInjection = {
      ...TEST_TOUCHING_INJECTION,
      path,
      patch: [`--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", " a", "-b", "+c"].join("\n"),
    };
    const result = validateInjection(injection);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("touches_test_file");
  });

  test("accepts a bounded, source-only, modify-in-place injection", () => {
    expect(validateInjection(PAGINATION_INJECTION)).toEqual({ ok: true });
    expect(validateInjection(CLAMP_INJECTION)).toEqual({ ok: true });
  });

  test("rejects a file create/delete (must modify existing source in place)", () => {
    const injection: BugInjection = {
      ...PAGINATION_INJECTION,
      patch: ["--- /dev/null", "+++ b/src/new.py", "@@ -0,0 +1,1 @@", "+x = 1"].join("\n"),
    };
    expect(validateInjection(injection)).toEqual({
      ok: false,
      reason: "creates_or_deletes_file",
      detail: "injection must modify existing source in place (no file create/delete)",
    });
  });

  test("rejects an over-budget diff", () => {
    const body = Array.from({ length: 12 }, (_v, i) => `-old${i}\n+new${i}`).join("\n");
    const injection: BugInjection = {
      ...PAGINATION_INJECTION,
      patch: ["--- a/src/big.py", "+++ b/src/big.py", "@@ -1,12 +1,12 @@", body].join("\n"),
    };
    const result = validateInjection(injection, { maxChangedLines: 4 });
    expect(result).toEqual({
      ok: false,
      reason: "diff_too_large",
      detail: "24 changed lines exceeds max 4",
    });
  });

  test("rejects an injection that breaks no existing test", () => {
    expect(validateInjection({ ...PAGINATION_INJECTION, breaksTests: [] })).toEqual({
      ok: false,
      reason: "no_target_tests",
      detail: "injection names no existing tests to break (nothing to grade)",
    });
  });

  test("rejects a non-diff patch", () => {
    const result = validateInjection({ ...PAGINATION_INJECTION, patch: "not a diff at all" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not_a_diff");
  });
});
