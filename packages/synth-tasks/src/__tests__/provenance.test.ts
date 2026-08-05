// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import type { EvalTask } from "@outerlayer/task-format";
import {
  countByProvenance,
  renderProvenanceSplit,
  SYNTHETIC_HONESTY_CAPTION,
} from "../provenance.js";
import { buildSyntheticTask } from "../task.js";
import { PAGINATION_INJECTION, PYTEST_ENV } from "./helpers.js";

const base = buildSyntheticTask(PAGINATION_INJECTION, {
  repo: "https://example.invalid/app.git",
  baseCommit: "ref",
  environment: PYTEST_ENV,
  passToPass: [],
  problemStatement: "A recent change introduced a regression; restore the previous behavior.",
  generatorVersion: "synth-0.1.0",
}).task;

function withProvenance(provenance: EvalTask["provenance"]): EvalTask {
  return { ...base, provenance };
}

describe("renderProvenanceSplit", () => {
  test("renders the split verbatim and never a merged total", () => {
    const rendered = renderProvenanceSplit({ mined: 84, synthetic: 120 });
    expect(rendered).toBe("N=84 mined + 120 synthetic");
    // The merged headline (84 + 120 = 204) must never appear.
    expect(rendered).not.toContain("204");
  });

  test("includes a manual segment only when present", () => {
    expect(renderProvenanceSplit({ mined: 10, synthetic: 5, manual: 3 })).toBe(
      "N=10 mined + 5 synthetic + 3 manual",
    );
    expect(renderProvenanceSplit({ mined: 10, synthetic: 5, manual: 0 })).toBe(
      "N=10 mined + 5 synthetic",
    );
  });
});

describe("countByProvenance", () => {
  test("counts each provenance independently", () => {
    const tasks = [
      withProvenance("mined"),
      withProvenance("synthetic"),
      withProvenance("synthetic"),
      withProvenance("manual"),
      withProvenance(undefined),
    ];
    expect(countByProvenance(tasks)).toEqual({ mined: 1, synthetic: 2, manual: 1 });
    expect(renderProvenanceSplit(countByProvenance(tasks))).toBe("N=1 mined + 2 synthetic + 1 manual");
  });
});

describe("honesty caption", () => {
  test("captions synthetic sets as regression-fix work", () => {
    expect(SYNTHETIC_HONESTY_CAPTION).toBe("regression-fix tasks, not feature work");
  });
});
