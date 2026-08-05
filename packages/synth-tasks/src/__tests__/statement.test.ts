// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import {
  assertNoLeak,
  generateProblemStatement,
  scrubLeaks,
  statementLeaks,
  type LeakTargets,
} from "../statement.js";
import { PAGINATION_INJECTION } from "./helpers.js";

const targets: LeakTargets = {
  functionName: PAGINATION_INJECTION.function, // "paginate"
  filePath: PAGINATION_INJECTION.path, // "src/pagination.py"
};

describe("generateProblemStatement leak scrubbing", () => {
  test("never names the injected function, file, or basename verbatim", () => {
    // The symptom fixture deliberately plants the function name AND the file
    // path — a naive generator would leak them straight into the statement.
    const statement = generateProblemStatement(
      {
        symptom: PAGINATION_INJECTION.symptom,
        failingTests: PAGINATION_INJECTION.breaksTests,
        failingTestOutput: "src/pagination.py:4: in paginate\n    assert result == expected",
      },
      targets,
    );

    expect(statementLeaks(statement, targets)).toEqual([]);
    expect(statement).not.toContain("paginate");
    expect(statement).not.toContain("src/pagination.py");
    expect(statement).not.toContain("pagination"); // basename (>=4 chars) scrubbed too
    expect(statement.length).toBeGreaterThanOrEqual(40); // schema floor holds post-scrub
  });

  test("still reads as a bug report (keeps the observable symptom minus names)", () => {
    const statement = generateProblemStatement(
      { symptom: "returns one extra item on the final page", failingTests: [] },
      targets,
    );
    expect(statement).toContain("regression");
    expect(statement).toContain("returns one extra item on the final page");
  });
});

describe("scrubLeaks", () => {
  test("redacts every token, longest-first (path before basename before symbol)", () => {
    expect(
      scrubLeaks("paginate lives in src/pagination.py (see pagination.py, module pagination)", targets),
    ).toBe("[redacted] lives in [redacted] (see [redacted], module [redacted])");
  });

  test("does not scrub short (<4 char) basenames that could be common words", () => {
    const shortTargets: LeakTargets = { functionName: "go", filePath: "src/io.py" };
    // "io" (basename without ext, 2 chars) is left alone; only the full path,
    // full basename, and function name are redacted.
    expect(scrubLeaks("the go routine in src/io.py touches io buffers", shortTargets)).toBe(
      "the [redacted] routine in [redacted] touches io buffers",
    );
  });
});

describe("assertNoLeak", () => {
  test("throws when a leaked identifier survives", () => {
    expect(() => assertNoLeak("bug in paginate()", targets)).toThrow(/leaks injected identifiers: paginate/);
  });

  test("passes for a scrubbed statement", () => {
    const statement = generateProblemStatement({ symptom: PAGINATION_INJECTION.symptom }, targets);
    expect(() => assertNoLeak(statement, targets)).not.toThrow();
  });
});
