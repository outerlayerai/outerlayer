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
import type { EvalTask } from "@outerlayer/task-format";

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ms: 1, truncated: false, timedOut: false, ...overrides };
}
export const OK = execResult();

/**
 * Fake provider that runs the EnvSpec.build callback (so build.ts's real
 * materialize→setup→guard→probe sequence executes), routing each exec
 * through `onExec`. Tracks built keys so prepareEnv is genuinely idempotent.
 */
export class FakeProvider implements SandboxProvider {
  readonly id = "fake";
  readonly execLog: string[] = [];
  builds = 0;
  removed: string[] = [];
  private built = new Map<string, EnvRef>();

  constructor(private readonly onExec: (cmd: string) => ExecResult) {}

  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    const existing = this.built.get(spec.key);
    if (existing) return { ...existing, built: false };
    if (spec.build) {
      this.builds += 1;
      const sandbox = await this.create(
        { key: spec.key, imageRef: spec.baseImage, providerId: this.id, createdAt: "t", built: false },
        spec.buildOpts,
      );
      await spec.build(sandbox, this); // may throw EnvBuildError — propagates
    }
    const env: EnvRef = {
      key: spec.key,
      imageRef: `fake-env:${spec.key}`,
      providerId: this.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      built: true,
    };
    this.built.set(spec.key, env);
    return env;
  }

  async create(env: EnvRef, _opts?: SandboxOpts): Promise<Sandbox> {
    return { id: `sb-${env.key}`, providerId: this.id, envKey: env.key, createdAt: "t" };
  }

  async exec(_sandbox: Sandbox, cmd: string, _opts?: ExecOpts): Promise<ExecResult> {
    this.execLog.push(cmd);
    return this.onExec(cmd);
  }

  async putFiles(_sandbox: Sandbox, _files: FileMap): Promise<void> {}
  async getFile(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async destroy(): Promise<void> {}
  async list(): Promise<SandboxInfo[]> {
    return [];
  }
  async removeEnvImage(key: string): Promise<void> {
    this.removed.push(key);
    this.built.delete(key);
  }
}

/** Route the build sequence: git ops OK by default, setup/guard/probe scripted. */
export function envExec(script: {
  setup?: (cmd: string) => ExecResult | undefined;
  guard?: ExecResult;
  probe?: ExecResult;
} = {}): (cmd: string) => ExecResult {
  return (cmd) => {
    if (cmd.includes("git clone")) return OK;
    if (cmd.includes("git status --porcelain")) return script.guard ?? execResult({ stdout: "" });
    if (cmd.includes("--collect-only") || cmd.includes("--listTests") || cmd.includes("__outerlayer_probe__")) {
      return script.probe ?? OK;
    }
    // Everything else is the setup step.
    return script.setup?.(cmd) ?? OK;
  };
}

export function buildTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    schema_version: 1,
    id: "env-demo",
    repo: "https://example.invalid/fixture.git",
    base_commit: "abc123",
    problem_statement:
      "Dividing by zero crashes the calculator; it should return None so callers can handle missing results cleanly.",
    test_patch: `--- /dev/null
+++ b/tests/test_x.py
@@ -0,0 +1,2 @@
+def test_x():
+    assert True
`,
    gold_patch: `--- a/calc.py
+++ b/calc.py
@@ -1,1 +1,2 @@
 x = 1
+y = 2
`,
    fail_to_pass: ["tests/test_x.py::test_x"],
    pass_to_pass: [],
    environment: {
      base_image: "python:3.12-bookworm",
      setup: "pip install -q pytest==8.3.3",
      test_cmd: "python -m pytest -q",
      runner: "pytest",
      timeout_s: 60,
    },
    quarantined: [],
    ...overrides,
  };
}
