// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { synthesize, type SynthesizeOptions } from "../synthesize.js";
import { ScriptedInjectionModel, staticModuleEnumerator } from "../injection.js";
import { syntheticTaskId } from "../task.js";
import { statementLeaks } from "../statement.js";
import type { BugInjection } from "../types.js";
import {
  CLAMP_INJECTION,
  CLAMP_MODULE,
  PAGINATION_INJECTION,
  PAGINATION_MODULE,
  PYTEST_ENV,
  TEST_TOUCHING_INJECTION,
  fakeEnvRef,
  FakeProvider,
  PASS,
} from "./helpers.js";

function baseOptions(overrides: Partial<SynthesizeOptions> = {}): SynthesizeOptions {
  return {
    repo: "https://example.invalid/app.git",
    env: fakeEnvRef(),
    provider: new FakeProvider(() => PASS),
    environment: PYTEST_ENV,
    enumerator: staticModuleEnumerator([PAGINATION_MODULE, CLAMP_MODULE]),
    injectionModel: new ScriptedInjectionModel((candidate) =>
      candidate.path === PAGINATION_MODULE.path
        ? [PAGINATION_INJECTION]
        : [TEST_TOUCHING_INJECTION, CLAMP_INJECTION],
    ),
    commitInjection: (injection) => `injected-${injection.injectionClass}`,
    resolveRateOf: (task) =>
      ({
        [syntheticTaskId(PAGINATION_INJECTION)]: 0.5,
        [syntheticTaskId(CLAMP_INJECTION)]: 0.99,
      })[task.id] ?? 0.5,
    generatorVersion: "synth-0.1.0",
    // Fake the inversion gate — the gate mechanics are proven in gate.test.ts.
    validateInversion: () => ({ ok: true }),
    ...overrides,
  };
}

describe("synthesize end-to-end (hermetic)", () => {
  test("rejects test-touchers, band-discards the too-easy task, keeps the signal task", async () => {
    const result = await synthesize(baseOptions());

    // Structural rejection: the test-file-editing injection never becomes a task.
    expect(result.rejected).toEqual([
      {
        path: "tests/test_pagination.py",
        function: "test_last_page",
        injectionClass: "boundary_regression",
        reason: "touches_test_file",
        detail: "injection touches test path(s): tests/test_pagination.py",
      },
    ]);

    // Band filtering: clamp resolved at 0.99 (too easy) is discarded; pagination
    // at 0.5 survives.
    const paginationId = syntheticTaskId(PAGINATION_INJECTION);
    const clampId = syntheticTaskId(CLAMP_INJECTION);
    expect(result.tasks.map((task) => task.id)).toEqual([paginationId]);
    expect(result.discardedByBand.map((entry) => entry.task.id)).toEqual([clampId]);
    expect(result.discardedByBand[0]!.reason).toBe("above_ceiling");

    // Provenance + metadata: every kept task is synthetic; meta is 1:1 and
    // records the injection class + generator version + calibrated rate.
    expect(result.tasks.every((task) => task.provenance === "synthetic")).toBe(true);
    expect(result.meta).toEqual([
      {
        taskId: paginationId,
        generatorVersion: "synth-0.1.0",
        injectionClass: "off_by_one",
        targetPath: "src/pagination.py",
        targetFunction: "paginate",
        symptom: PAGINATION_INJECTION.symptom,
        resolveRate: 0.5,
        inTargetBand: true,
      },
    ]);

    // The kept task's statement carries no leaked identifier.
    expect(
      statementLeaks(result.tasks[0]!.problem_statement, {
        functionName: "paginate",
        filePath: "src/pagination.py",
      }),
    ).toEqual([]);

    // pass_to_pass is sampled from the OTHER module's tests (unrelated, green).
    expect(result.tasks[0]!.pass_to_pass).toEqual(["tests/test_mathx.py::test_clamp_high"]);
  });

  test("dedupes injections that break the same failing test into one task", async () => {
    const twoWaysToBreakLastPage: BugInjection[] = [
      PAGINATION_INJECTION,
      { ...PAGINATION_INJECTION, injectionClass: "boundary_regression", patch: PAGINATION_INJECTION.patch.replace("+ 1", "+ 2") },
    ];
    const result = await synthesize(
      baseOptions({
        enumerator: staticModuleEnumerator([PAGINATION_MODULE]),
        injectionModel: new ScriptedInjectionModel(() => twoWaysToBreakLastPage),
        resolveRateOf: () => 0.5,
      }),
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.fail_to_pass).toEqual(["tests/test_pagination.py::test_last_page"]);
  });

  test("a judge spot-check that locates the bug rejects the task", async () => {
    const result = await synthesize(
      baseOptions({
        enumerator: staticModuleEnumerator([PAGINATION_MODULE]),
        injectionModel: new ScriptedInjectionModel(() => [PAGINATION_INJECTION]),
        spotCheck: { locate: async () => 0.9 },
      }),
    );
    expect(result.tasks).toEqual([]);
    expect(result.rejected).toEqual([
      {
        path: "src/pagination.py",
        function: "paginate",
        injectionClass: "off_by_one",
        reason: "statement_leak",
        detail: "judge can locate the bug from the statement (p=0.9)",
      },
    ]);
  });

  test("an injection whose inversion fails the gate is rejected, not shipped", async () => {
    const result = await synthesize(
      baseOptions({
        enumerator: staticModuleEnumerator([PAGINATION_MODULE]),
        injectionModel: new ScriptedInjectionModel(() => [PAGINATION_INJECTION]),
        validateInversion: () => ({ ok: false, reason: "gold_fails", detail: "revert did not restore green" }),
      }),
    );
    expect(result.tasks).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["gold_fails"]);
  });
});
