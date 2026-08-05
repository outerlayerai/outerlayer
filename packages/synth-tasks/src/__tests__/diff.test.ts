// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "@outerlayer/task-format";
import { changedLineCount, invertUnifiedDiff, noopTestPatch } from "../diff.js";
import { PAGINATION_INJECTION } from "./helpers.js";

describe("invertUnifiedDiff", () => {
  test("reverts an off-by-one injection line-for-line", () => {
    expect(invertUnifiedDiff(PAGINATION_INJECTION.patch)).toBe(
      [
        "--- b/src/pagination.py",
        "+++ a/src/pagination.py",
        "@@ -3,3 +3,3 @@ def paginate(items, page, size):",
        "     start = page * size",
        "-    end = min(start + size + 1, len(items))",
        "+    end = min(start + size, len(items))",
        "     return items[start:end]",
      ].join("\n"),
    );
  });

  test("double inversion is the identity (revert of a revert is the injection)", () => {
    expect(invertUnifiedDiff(invertUnifiedDiff(PAGINATION_INJECTION.patch))).toBe(
      PAGINATION_INJECTION.patch,
    );
  });

  test("swaps asymmetric hunk ranges", () => {
    const patch = ["--- a/f.py", "+++ b/f.py", "@@ -10,2 +10,3 @@", " ctx", "+added", " tail"].join("\n");
    expect(invertUnifiedDiff(patch)).toBe(
      ["--- b/f.py", "+++ a/f.py", "@@ -10,3 +10,2 @@", " ctx", "-added", " tail"].join("\n"),
    );
  });
});

describe("noopTestPatch", () => {
  test("is a parseable new-file diff touching only a throwaway marker", () => {
    const parsed = parseUnifiedDiff(noopTestPatch("synth-off-by-one-abc123"));
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([".outerlayer/synthetic/synth-off-by-one-abc123.noop"]);
    // Marker content stays under 12 chars so the gate's leak grep never uses it.
    expect(parsed.addedLines).toEqual(["synthetic"]);
    expect(parsed.addedLines[0]!.length).toBeLessThan(12);
  });
});

describe("changedLineCount", () => {
  test("counts +/- body lines, excluding +++/--- file headers", () => {
    expect(changedLineCount(PAGINATION_INJECTION.patch)).toBe(2);
  });
});
