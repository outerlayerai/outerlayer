// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// The proof that the inversion holds: a synthetic task (base_commit =
// injected state, gold_patch = revert, test_patch = sentinel no-op) passes
// The execution gate stays UNTOUCHED. We drive task-format's real `validateTask`
// with a scripted provider that mimics the injected repo: the fail_to_pass
// test fails at the injected base and passes once the revert is applied.

import { describe, expect, test } from "vitest";
import { validateTask } from "@outerlayer/task-format";
import { buildSyntheticTask } from "../task.js";
import { generateProblemStatement } from "../statement.js";
import { execResult, FAIL, FakeProvider, PASS, PAGINATION_INJECTION, PYTEST_ENV } from "./helpers.js";

const F2P_FRAGMENT = "test_last_page"; // the pre-existing test the injection breaks
const P2P_FRAGMENT = "test_first_page"; // an unrelated pre-existing test

function syntheticTask() {
  const statement = generateProblemStatement(
    { symptom: PAGINATION_INJECTION.symptom, failingTests: PAGINATION_INJECTION.breaksTests },
    { functionName: PAGINATION_INJECTION.function, filePath: PAGINATION_INJECTION.path },
  );
  return buildSyntheticTask(PAGINATION_INJECTION, {
    repo: "https://example.invalid/app.git",
    baseCommit: "injected-throwaway-ref",
    environment: PYTEST_ENV,
    passToPass: ["tests/test_pagination.py::test_first_page"],
    problemStatement: statement,
    generatorVersion: "synth-0.1.0",
  }).task;
}

/**
 * Scripted provider mirroring the injected repo: at the injected base the F2P
 * test fails (invocation 1, pre-gold); after the revert gold_patch it passes;
 * the unrelated P2P test always passes; the snapshot leak grep finds nothing.
 */
function injectedRepoProvider(): FakeProvider {
  return new FakeProvider((cmd, invocation) => {
    if (cmd.includes("grep -rF")) return execResult({ code: 1 }); // no leak
    if (cmd.includes("test.patch")) return PASS; // sentinel applies cleanly
    if (cmd.includes("gold.patch")) return PASS; // revert applies cleanly
    if (cmd.includes(F2P_FRAGMENT)) return invocation === 1 ? FAIL : PASS;
    if (cmd.includes(P2P_FRAGMENT)) return PASS;
    return PASS;
  });
}

describe("synthetic task passes the task-format gate untouched", () => {
  test("F2P fails at injected base, passes after the revert; P2P green; no leak", async () => {
    const provider = injectedRepoProvider();
    const task = syntheticTask();

    const entry = await validateTask(task, { provider });

    expect(entry.status).toBe("valid");
    expect(entry.reason).toBeUndefined();
    expect(entry.flags).toEqual([]);
    expect(entry.quarantined).toEqual([]);
    expect(entry.runs).toEqual({
      f2pPreGold: { "tests/test_pagination.py::test_last_page": ["fail"] },
      f2pWithGold: { "tests/test_pagination.py::test_last_page": ["pass", "pass", "pass"] },
      passToPass: { "tests/test_pagination.py::test_first_page": ["pass", "pass", "pass"] },
    });

    // Gate sandbox + fresh leak-check sandbox, both destroyed — no leaks.
    expect(provider.created).toBe(2);
    expect(provider.destroyed).toBe(2);
  });

  test("if the revert fails to restore green, the gate rejects with gold_fails (inversion broken)", async () => {
    // A provider where the F2P test keeps failing even after gold ⇒ the revert
    // did not actually fix the injected bug: the gate must catch it.
    const provider = new FakeProvider((cmd) => {
      if (cmd.includes("grep -rF")) return execResult({ code: 1 });
      if (cmd.includes("test.patch") || cmd.includes("gold.patch")) return PASS;
      if (cmd.includes(F2P_FRAGMENT)) return FAIL; // never recovers
      return PASS;
    });
    const entry = await validateTask(syntheticTask(), { provider });
    expect(entry.status).toBe("invalid");
    expect(entry.reason).toBe("gold_fails");
  });
});
