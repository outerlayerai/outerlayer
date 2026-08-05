// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { dedupeSynthetic, failureSignature } from "../dedup.js";
import { buildSyntheticTask } from "../task.js";
import { CLAMP_INJECTION, PAGINATION_INJECTION, PAGINATION_INJECTION_ALT, PYTEST_ENV } from "./helpers.js";

function built(injection: typeof PAGINATION_INJECTION) {
  return buildSyntheticTask(injection, {
    repo: "https://example.invalid/app.git",
    baseCommit: `injected-${injection.injectionClass}`,
    environment: PYTEST_ENV,
    passToPass: [],
    problemStatement:
      "A recent change introduced a regression; restore the previously correct behavior.",
    generatorVersion: "synth-0.1.0",
  });
}

describe("dedupeSynthetic", () => {
  test("two injections hitting the same failing test collapse to one (first wins)", () => {
    const first = built(PAGINATION_INJECTION); // breaks tests/test_pagination.py::test_last_page
    const second = built(PAGINATION_INJECTION_ALT); // breaks the SAME test, different diff
    expect(first.task.id).not.toBe(second.task.id); // genuinely distinct injections
    expect(failureSignature(first.task)).toBe(failureSignature(second.task));

    const unique = dedupeSynthetic([first, second]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.meta.taskId).toBe(first.meta.taskId);
    expect(unique[0]!.meta.injectionClass).toBe("off_by_one");
  });

  test("injections breaking different tests are kept apart", () => {
    const pagination = built(PAGINATION_INJECTION);
    const clamp = built(CLAMP_INJECTION);
    const unique = dedupeSynthetic([pagination, clamp]);
    expect(unique.map((entry) => entry.task.id)).toEqual([pagination.task.id, clamp.task.id]);
  });
});
