// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Runner adapters — per-runner test-id addressing (pytest `::` vs
 * jest/vitest `-t` name matching differ; abstract it once, the trial harness
 * reuses it).
 *
 * The gate runs each test id as its OWN exec with its own timeout: precise
 * per-test outcomes with no suite-output parsing, and a hung test fails the
 * TEST (timeout ⇒ fail), never the gate run.
 */

import type { ExecResult } from "@outerlayer/runner-core";
import type { RunnerId } from "./schema.js";

export type TestOutcome = "pass" | "fail" | "not_found";

export interface RunnerAdapter {
  readonly id: RunnerId;
  /** Full shell command to run exactly one test id (cwd = repo root). */
  buildCommand(testCmd: string, testId: string): string;
  classify(result: ExecResult): TestOutcome;
  /** Cheap health probe for env builds: collect/list tests WITHOUT
   * running them — catches import/config breakage in seconds. Not a
   * substitute for the gate. */
  probeCommand(testCmd: string): string;
  /** True if the probe result means a HEALTHY env. Crucially, "no tests
   * collected" is healthy (the graded tests arrive via test_patch at grade
   * time) — only genuine import/config breakage is unhealthy. */
  probeHealthy(result: ExecResult): boolean;
}

/** POSIX single-quote escaping. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Split `<file>::<name>` on the FIRST `::` (names may contain colons). */
export function splitTestId(testId: string): { file: string; name: string } {
  const index = testId.indexOf("::");
  if (index < 0) return { file: testId, name: "" };
  return { file: testId.slice(0, index), name: testId.slice(index + 2) };
}

const pytestAdapter: RunnerAdapter = {
  id: "pytest",
  buildCommand(testCmd, testId) {
    // pytest addresses nodes natively: path/test_x.py::TestClass::test_name
    return `${testCmd} ${shq(testId)}`;
  },
  classify(result) {
    if (result.timedOut) return "fail";
    if (result.code === 0) return "pass";
    // 4 = usage error (bad node id), 5 = no tests collected.
    if (result.code === 4 || result.code === 5) return "not_found";
    if (/ERROR: not found:|no tests ran/i.test(result.stdout + result.stderr)) {
      return "not_found";
    }
    return "fail";
  },
  probeCommand(testCmd) {
    return `${testCmd} --collect-only`;
  },
  probeHealthy(result) {
    // 0 = tests collected, 5 = none collected — both mean the env imports
    // cleanly. 2 = collection/import error ⇒ the env is genuinely broken.
    return result.code === 0 || result.code === 5;
  },
};

function jestLikeClassify(result: ExecResult, notFoundMarkers: RegExp): TestOutcome {
  if (result.timedOut) return "fail";
  const output = result.stdout + result.stderr;
  if (notFoundMarkers.test(output)) return "not_found";
  return result.code === 0 ? "pass" : "fail";
}

const jestAdapter: RunnerAdapter = {
  id: "jest",
  buildCommand(testCmd, testId) {
    const { file, name } = splitTestId(testId);
    return `${testCmd} ${shq(file)} -t ${shq(name)}`;
  },
  classify(result) {
    // Jest exits 0 on "no tests found" only with --passWithNoTests; both
    // paths are covered by the marker scan.
    return jestLikeClassify(
      result,
      /No tests found|Your test suite must contain at least one test|0 matches/i,
    );
  },
  probeCommand(testCmd) {
    return `${testCmd} --listTests`;
  },
  probeHealthy(result) {
    // Healthy if it listed tests (exit 0) or ran fine but found none; a real
    // config/dep break exits non-zero WITHOUT a no-tests marker.
    return (
      result.code === 0 ||
      /No tests found|Your test suite must contain at least one test/i.test(result.stdout + result.stderr)
    );
  },
};

const vitestAdapter: RunnerAdapter = {
  id: "vitest",
  buildCommand(testCmd, testId) {
    const { file, name } = splitTestId(testId);
    return `${testCmd} ${shq(file)} -t ${shq(name)}`;
  },
  classify(result) {
    return jestLikeClassify(
      result,
      /No test files found|No test suite found|no tests? (?:were )?found/i,
    );
  },
  probeCommand(testCmd) {
    // vitest has no --collect-only; a never-matching -t with
    // --passWithNoTests imports every test file (catching broken imports)
    // while executing none.
    return `${testCmd} --passWithNoTests -t '__outerlayer_probe__'`;
  },
  probeHealthy(result) {
    return (
      result.code === 0 ||
      /No test files found|No test suite found|no tests? (?:were )?found/i.test(result.stdout + result.stderr)
    );
  },
};

const ADAPTERS: Record<RunnerId, RunnerAdapter> = {
  pytest: pytestAdapter,
  jest: jestAdapter,
  vitest: vitestAdapter,
};

export function runnerAdapter(id: RunnerId): RunnerAdapter {
  return ADAPTERS[id];
}
