// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type {
  EnvRef,
  EnvSpec,
  ExecOpts,
  ExecResult,
  FileMap,
  Sandbox,
  SandboxInfo,
  SandboxOpts,
  SandboxProvider,
} from "@outerlayer/runner-core";
import type { TaskEnvironment } from "@outerlayer/task-format";
import type { BugInjection, ModuleCandidate } from "../types.js";

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ms: 1, truncated: false, timedOut: false, ...overrides };
}

export const PASS = execResult();
export const FAIL = execResult({ code: 1, stdout: "1 failed" });

/**
 * Scripted SandboxProvider (same shape as task-format's gate fixture): `onExec`
 * decides each command's result and sees a per-command invocation count.
 */
export class FakeProvider implements SandboxProvider {
  readonly id = "fake";
  readonly execLog: string[] = [];
  created = 0;
  destroyed = 0;
  prepareEnvCalls = 0;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly onExec: (cmd: string, invocation: number) => ExecResult,
    private readonly envKeyed = new Map<string, EnvRef>(),
  ) {}

  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    this.prepareEnvCalls += 1;
    const cached = this.envKeyed.get(spec.key);
    if (cached) return { ...cached, built: false };
    const env: EnvRef = {
      key: spec.key,
      imageRef: `fake-env:${spec.key}`,
      providerId: this.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      built: true,
    };
    this.envKeyed.set(spec.key, env);
    return env;
  }

  async create(env: EnvRef, _opts?: SandboxOpts): Promise<Sandbox> {
    this.created += 1;
    return {
      id: `sb-${this.created}`,
      providerId: this.id,
      envKey: env.key,
      createdAt: "2026-07-07T00:00:00.000Z",
    };
  }

  async exec(_sandbox: Sandbox, cmd: string, _opts?: ExecOpts): Promise<ExecResult> {
    this.execLog.push(cmd);
    const invocation = (this.counts.get(cmd) ?? 0) + 1;
    this.counts.set(cmd, invocation);
    return this.onExec(cmd, invocation);
  }

  async putFiles(_sandbox: Sandbox, _files: FileMap): Promise<void> {}

  async getFile(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async destroy(_sandbox: Sandbox): Promise<void> {
    this.destroyed += 1;
  }

  async list(): Promise<SandboxInfo[]> {
    return [];
  }
}

export function fakeEnvRef(key = "qualified-env"): EnvRef {
  return {
    key,
    imageRef: `fake-env:${key}`,
    providerId: "fake",
    createdAt: "2026-07-07T00:00:00.000Z",
    built: false,
  };
}

export const PYTEST_ENV: TaskEnvironment = {
  base_image: "python:3.12-bookworm",
  setup: "pip install --quiet pytest==8.3.3",
  test_cmd: "python -m pytest -q",
  runner: "pytest",
  timeout_s: 60,
};

/** Two well-tested, fast modules in the qualified env. */
export const PAGINATION_MODULE: ModuleCandidate = {
  path: "src/pagination.py",
  functions: ["paginate"],
  coveringTests: [
    "tests/test_pagination.py::test_first_page",
    "tests/test_pagination.py::test_last_page",
  ],
  medianTestMs: 8,
};

export const CLAMP_MODULE: ModuleCandidate = {
  path: "src/mathx.py",
  functions: ["clamp"],
  coveringTests: ["tests/test_mathx.py::test_clamp_high"],
  medianTestMs: 5,
};

/**
 * An off-by-one injection on `paginate`: `+ size` becomes `+ size + 1`, so the
 * final page returns one extra item. Applied to the ORIGINAL source it
 * introduces the bug; its revert is the task's gold_patch.
 */
export const PAGINATION_INJECTION: BugInjection = {
  path: "src/pagination.py",
  function: "paginate",
  injectionClass: "off_by_one",
  patch: [
    "--- a/src/pagination.py",
    "+++ b/src/pagination.py",
    "@@ -3,3 +3,3 @@ def paginate(items, page, size):",
    "     start = page * size",
    "-    end = min(start + size, len(items))",
    "+    end = min(start + size + 1, len(items))",
    "     return items[start:end]",
  ].join("\n"),
  breaksTests: ["tests/test_pagination.py::test_last_page"],
  symptom:
    "The function paginate in src/pagination.py returns one extra item on the final page instead of stopping at the slice end.",
};

/** A second injection that breaks the SAME test (for the dedup test). */
export const PAGINATION_INJECTION_ALT: BugInjection = {
  path: "src/pagination.py",
  function: "paginate",
  injectionClass: "boundary_regression",
  patch: [
    "--- a/src/pagination.py",
    "+++ b/src/pagination.py",
    "@@ -3,3 +3,3 @@ def paginate(items, page, size):",
    "     start = page * size",
    "-    end = min(start + size, len(items))",
    "+    end = len(items)",
    "     return items[start:end]",
  ].join("\n"),
  breaksTests: ["tests/test_pagination.py::test_last_page"],
  symptom: "The final page includes every remaining item instead of a single page's worth.",
};

/** An inverted-condition injection on `clamp` (breaks a DIFFERENT test). */
export const CLAMP_INJECTION: BugInjection = {
  path: "src/mathx.py",
  function: "clamp",
  injectionClass: "inverted_condition",
  patch: [
    "--- a/src/mathx.py",
    "+++ b/src/mathx.py",
    "@@ -1,3 +1,3 @@ def clamp(value, lo, hi):",
    "-    if value > hi:",
    "+    if value < hi:",
    "         return hi",
    "     return value",
  ].join("\n"),
  breaksTests: ["tests/test_mathx.py::test_clamp_high"],
  symptom: "Clamping a value above the maximum no longer caps it at the maximum.",
};

/** An injection that illegally edits a TEST file — must be rejected structurally. */
export const TEST_TOUCHING_INJECTION: BugInjection = {
  path: "tests/test_pagination.py",
  function: "test_last_page",
  injectionClass: "boundary_regression",
  patch: [
    "--- a/tests/test_pagination.py",
    "+++ b/tests/test_pagination.py",
    "@@ -1,3 +1,3 @@",
    " def test_last_page():",
    "-    assert paginate(items, 2, 3) == items[6:9]",
    "+    assert paginate(items, 2, 3) == items[6:10]",
  ].join("\n"),
  breaksTests: ["tests/test_pagination.py::test_last_page"],
  symptom: "n/a",
};
