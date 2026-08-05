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
import type { EvalTask } from "../schema.js";

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ms: 1, truncated: false, timedOut: false, ...overrides };
}

export const PASS = execResult();
export const FAIL = execResult({ code: 1, stdout: "1 failed" });
/** pytest "no tests collected". */
export const NOT_FOUND = execResult({ code: 5, stderr: "no tests ran" });

/**
 * Scripted SandboxProvider: `onExec` decides each command's result and sees
 * a per-command invocation count (flake simulation). Tracks lifecycle so
 * tests can assert the gate never leaks sandboxes.
 */
export class FakeProvider implements SandboxProvider {
  readonly id = "fake";
  readonly execLog: string[] = [];
  readonly putFilesLog: FileMap[] = [];
  created = 0;
  destroyed = 0;
  prepareEnvCalls = 0;
  /** When set, `resolveImageDigest` reports it (determinism-capture tests). */
  imageDigest?: string;
  private counts = new Map<string, number>();

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

  async resolveImageDigest(_imageRef: string): Promise<string | undefined> {
    return this.imageDigest;
  }

  async putFiles(_sandbox: Sandbox, files: FileMap): Promise<void> {
    this.putFilesLog.push(files);
  }

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

export const TEST_PATCH = `--- /dev/null
+++ b/tests/test_divide_zero.py
@@ -0,0 +1,6 @@
+from calculator import divide
+
+
+def test_divide_by_zero_returns_none():
+    assert divide(1, 0) is None
+`;

export const GOLD_PATCH = `--- a/calculator.py
+++ b/calculator.py
@@ -1,2 +1,4 @@
 def divide(a, b):
+    if b == 0:
+        return None
     return a / b
`;

export function buildTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    schema_version: 1,
    id: "demo-good",
    repo: "https://example.invalid/fixture.git",
    base_commit: "abc123",
    problem_statement:
      "Dividing by zero crashes the calculator with an unhandled ZeroDivisionError; it should return None so callers can handle missing results.",
    test_patch: TEST_PATCH,
    gold_patch: GOLD_PATCH,
    fail_to_pass: ["tests/test_divide_zero.py::test_divide_by_zero_returns_none"],
    pass_to_pass: ["tests/test_basic.py::test_subtract"],
    environment: {
      base_image: "python:3.12-bookworm",
      setup: "pip install --quiet pytest==8.3.3",
      test_cmd: "python -m pytest -q",
      runner: "pytest",
      timeout_s: 60,
    },
    quarantined: [],
    ...overrides,
  };
}
