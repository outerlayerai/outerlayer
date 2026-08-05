// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { parseTask } from "@outerlayer/task-format";
import { invertUnifiedDiff, noopTestPatch } from "../diff.js";
import { buildSyntheticTask, syntheticTaskId } from "../task.js";
import { generateProblemStatement } from "../statement.js";
import { PAGINATION_INJECTION, PYTEST_ENV } from "./helpers.js";

const statement = generateProblemStatement(
  { symptom: PAGINATION_INJECTION.symptom, failingTests: PAGINATION_INJECTION.breaksTests },
  { functionName: PAGINATION_INJECTION.function, filePath: PAGINATION_INJECTION.path },
);

function build() {
  return buildSyntheticTask(PAGINATION_INJECTION, {
    repo: "https://example.invalid/app.git",
    baseCommit: "injected-throwaway-ref-9f1c",
    environment: PYTEST_ENV,
    passToPass: ["tests/test_mathx.py::test_clamp_high"],
    problemStatement: statement,
    generatorVersion: "synth-0.1.0",
  });
}

describe("buildSyntheticTask inversion roles", () => {
  test("base_commit=injected, gold_patch=revert, test_patch=sentinel, provenance=synthetic", () => {
    const { task, meta } = build();
    const id = syntheticTaskId(PAGINATION_INJECTION);

    expect(task.id).toBe(id);
    expect(task.base_commit).toBe("injected-throwaway-ref-9f1c"); // injected state
    expect(task.gold_patch).toBe(invertUnifiedDiff(PAGINATION_INJECTION.patch)); // the revert
    expect(task.test_patch).toBe(noopTestPatch(id)); // sentinel no-op
    expect(task.fail_to_pass).toEqual(["tests/test_pagination.py::test_last_page"]); // pre-existing
    expect(task.pass_to_pass).toEqual(["tests/test_mathx.py::test_clamp_high"]);
    expect(task.provenance).toBe("synthetic");

    // The gold_patch reverts to the ORIGINAL line and removes the injected one —
    // this is what restores green at gate time.
    expect(task.gold_patch).toContain("+    end = min(start + size, len(items))");
    expect(task.gold_patch).toContain("-    end = min(start + size + 1, len(items))");

    // Side metadata carries injection provenance without touching the schema.
    expect(meta).toEqual({
      taskId: id,
      generatorVersion: "synth-0.1.0",
      injectionClass: "off_by_one",
      targetPath: "src/pagination.py",
      targetFunction: "paginate",
      symptom: PAGINATION_INJECTION.symptom,
    });
  });

  test("the synthetic task re-parses cleanly via evalTaskSchema (parseTask)", () => {
    const { task } = build();
    const result = parseTask(stringify(task));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    // The inversion roles survive a full YAML → evalTaskSchema round-trip.
    expect(result.task.base_commit).toBe(task.base_commit);
    expect(result.task.provenance).toBe("synthetic");
    expect(result.task.fail_to_pass).toEqual(task.fail_to_pass);
    expect(result.task.pass_to_pass).toEqual(task.pass_to_pass);
    expect(result.task.gold_patch.trimEnd()).toBe(task.gold_patch.trimEnd());
    expect(result.task.test_patch.trimEnd()).toBe(task.test_patch.trimEnd());
    expect(result.task.schema_version).toBe(1);
  });
});
