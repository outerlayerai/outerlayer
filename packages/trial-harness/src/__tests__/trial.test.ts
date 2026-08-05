// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import type {
  EnvRef, EnvSpec, ExecOpts, ExecResult, FileMap, Sandbox, SandboxInfo, SandboxOpts, SandboxProvider,
} from "@outerlayer/runner-core";
import type { EvalTask } from "@outerlayer/task-format";
import { ARTIFACT_DENYLIST_RE, runTrial, type RunTrialDeps } from "../trial.js";
import { runMatrix, vendorForConfig } from "../matrix.js";
import { resolveLauncher } from "../launcher.js";
import type { TrialConfig } from "../types.js";

function execResult(o: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ms: 1, truncated: false, timedOut: false, ...o };
}

const CANDIDATE_PATCH = `diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,4 @@
 def divide(a, b):
+    if b == 0:
+        return None
     return a / b
`;

/** Scriptable provider driving the real runTrial phase sequence. */
class TrialProvider implements SandboxProvider {
  readonly id = "fake";
  readonly execLog: { sandbox: string; cmd: string }[] = [];
  readonly created: { id: string; network?: string }[] = [];
  readonly destroyed: string[] = [];
  private n = 0;
  constructor(private readonly onExec: (cmd: string, sandboxId: string) => ExecResult) {}
  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    return { key: spec.key, imageRef: `img:${spec.key}`, providerId: this.id, createdAt: "t", built: true };
  }
  async create(env: EnvRef, opts?: SandboxOpts): Promise<Sandbox> {
    const id = `sb-${++this.n}`;
    this.created.push({ id, network: opts?.network });
    return { id, providerId: this.id, envKey: env.key, createdAt: "t" };
  }
  async exec(sandbox: Sandbox, cmd: string, _o?: ExecOpts): Promise<ExecResult> {
    this.execLog.push({ sandbox: sandbox.id, cmd });
    return this.onExec(cmd, sandbox.id);
  }
  async putFiles(_s: Sandbox, _f: FileMap): Promise<void> {}
  async getFile(): Promise<Buffer> { return Buffer.from(""); }
  async destroy(s: Sandbox): Promise<void> { this.destroyed.push(s.id); }
  async list(): Promise<SandboxInfo[]> { return []; }
}

const TASK: EvalTask = {
  schema_version: 1, id: "t1", repo: "r", base_commit: "c",
  problem_statement: "Dividing by zero throws; it should return None so callers can handle it.",
  test_patch: `--- /dev/null\n+++ b/tests/test_div.py\n@@ -0,0 +1,2 @@\n+def test_divide_by_zero_returns_none():\n+    assert divide(1, 0) is None\n`,
  gold_patch: `--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,3 @@\n def divide(a, b):\n+    pass\n`,
  fail_to_pass: ["tests/test_div.py::test_divide_by_zero_returns_none"],
  pass_to_pass: ["tests/test_basic.py::test_add"],
  environment: { base_image: "python:3.12", setup: "", test_cmd: "python -m pytest -q", runner: "pytest", timeout_s: 30 },
  quarantined: [],
};

const CONFIG: TrialConfig = {
  id: "opus", launcher: "claude-code", model: "claude-opus-4-8",
  budgets: { maxTurns: 20, maxTokens: 100000, wallClockS: 300 },
};

const TRANSCRIPT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use" }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 } },
});

function deps(over: Partial<RunTrialDeps> = {}, onExec?: (cmd: string, sb: string) => ExecResult): RunTrialDeps & { provider: TrialProvider } {
  const provider = new TrialProvider(onExec ?? (() => execResult()));
  return {
    provider,
    envFactory: async (task) => provider.prepareEnv({ key: `env-${task.id}`, baseImage: "python:3.12" }),
    resolveSecrets: async () => ({ ANTHROPIC_API_KEY: "sk-test" }),
    prices: { "claude-opus-4-8": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 } },
    ...over,
    ...({ provider } as object),
  } as RunTrialDeps & { provider: TrialProvider };
}

/** Script: agent writes a patch (git diff --cached returns it + transcript),
 * grade runs each test to `outcome`. */
function scripted(opts: {
  diff?: string; f2p?: ExecResult; p2p?: ExecResult; candidateApply?: ExecResult; transcript?: string; timedOut?: boolean;
}) {
  const d = new TrialProvider((cmd) => {
    if (cmd.includes("git diff --cached")) return execResult({ stdout: opts.diff ?? CANDIDATE_PATCH });
    if (cmd.includes("grep -rF")) return execResult({ code: 1 }); // clean worktree
    if (cmd.includes("git apply") && cmd.includes("candidate.patch")) return opts.candidateApply ?? execResult();
    if (cmd.includes("git apply")) return execResult(); // test.patch applies
    if (cmd.includes("test_divide_by_zero")) return opts.f2p ?? execResult();
    if (cmd.includes("test_add")) return opts.p2p ?? execResult();
    if (cmd.includes("claude ")) return execResult({ timedOut: opts.timedOut ?? false });
    return execResult();
  });
  return d;
}

describe("runTrial", () => {
  test("graded+resolved: agent sandbox has network, grade sandbox is fresh + network:none, agent sandbox destroyed before grade", async () => {
    const provider = scripted({ f2p: execResult({ code: 0 }), p2p: execResult({ code: 0 }) });
    // Patch the getFile to return a transcript for trajectory/cost.
    provider.getFile = async () => Buffer.from(TRANSCRIPT);
    const d = { ...deps({ provider }), provider } as RunTrialDeps & { provider: TrialProvider };
    const result = await runTrial(TASK, CONFIG, 0, d);

    expect(result.status).toBe("graded");
    expect(result.resolved).toBe(true);
    expect(result.failToPass).toEqual([{ id: TASK.fail_to_pass[0], outcome: "pass" }]);
    expect(result.passToPass).toEqual([{ id: TASK.pass_to_pass[0], outcome: "pass" }]);

    // Two DISTINCT sandboxes: agent (network default), grade (network none).
    expect(provider.created).toHaveLength(2);
    expect(provider.created[0]!.network).toBe("default");
    expect(provider.created[1]!.network).toBe("none");
    // Agent sandbox destroyed BEFORE the grade sandbox was created.
    const agentId = provider.created[0]!.id;
    const gradeId = provider.created[1]!.id;
    const agentDestroyOrder = provider.destroyed.indexOf(agentId);
    const gradeCreatedAfter = provider.execLog.findIndex((e) => e.sandbox === gradeId);
    expect(agentDestroyOrder).toBeGreaterThanOrEqual(0);
    expect(provider.destroyed).toContain(gradeId);
    expect(gradeCreatedAfter).toBeGreaterThan(0);

    // Grade materials (test.patch) only ever touched the grade sandbox.
    const testPatchExecs = provider.execLog.filter((e) => e.cmd.includes("test.patch"));
    expect(testPatchExecs.every((e) => e.sandbox === gradeId)).toBe(true);

    // Leak assertions all green.
    expect(result.leak).toEqual({
      agentWorktreeClean: true, transcriptClean: true, gradeOffline: true,
      patchesNeverInAgentSandbox: true, frozenPatchIntact: true,
    });
    // Cost measured from the transcript usage.
    expect(result.cost.source).toBe("measured");
    expect(result.cost.usd).toBeCloseTo((1000 / 1e6) * 15 + (200 / 1e6) * 75 + (50 / 1e6) * 1.5, 9);
  });

  test("onTranscript observes the raw transcript with the trial's exact identity", async () => {
    const provider = scripted({});
    provider.getFile = async () => Buffer.from(TRANSCRIPT);
    const seen: Array<{ transcript: string; meta: Record<string, unknown> }> = [];
    const d = {
      ...deps({ provider, onTranscript: (transcript, meta) => seen.push({ transcript, meta }) }),
      provider,
    } as RunTrialDeps & { provider: TrialProvider };

    const result = await runTrial(TASK, CONFIG, 3, d);

    expect(result.status).toBe("graded");
    expect(seen).toEqual([
      {
        transcript: TRANSCRIPT,
        meta: { taskId: "t1", configId: "opus", trialIndex: 3, launcher: "claude-code" },
      },
    ]);
  });

  test("a throwing onTranscript observer never fails the trial", async () => {
    const provider = scripted({});
    provider.getFile = async () => Buffer.from(TRANSCRIPT);
    const d = {
      ...deps({
        provider,
        onTranscript: () => {
          throw new Error("observer exploded");
        },
      }),
      provider,
    } as RunTrialDeps & { provider: TrialProvider };

    const result = await runTrial(TASK, CONFIG, 0, d);
    expect(result.status).toBe("graded");
    expect(result.resolved).toBe(true);
  });

  test("onTranscript is not called when no transcript was captured", async () => {
    const provider = scripted({}); // getFile returns empty buffer by default
    const onTranscript = ((..._args: unknown[]) => {
      throw new Error("must not be called");
    }) as unknown as RunTrialDeps["onTranscript"];
    const d = { ...deps({ provider, onTranscript }), provider } as RunTrialDeps & {
      provider: TrialProvider;
    };

    const result = await runTrial(TASK, CONFIG, 0, d);
    expect(result.status).toBe("graded");
    expect(result.trajectory).toBeNull();
  });

  test("the freeze strips build artifacts (belt-and-suspenders over .gitignore)", async () => {
    const provider = scripted({ f2p: execResult({ code: 0 }), p2p: execResult({ code: 0 }) });
    await runTrial(TASK, CONFIG, 0, { ...deps({ provider }), provider });
    const freeze = provider.execLog.find((e) => e.cmd.includes("git diff --cached"))!;
    expect(freeze).toBeDefined();
    // The freeze pipeline unstages the artifact denylist before diffing.
    expect(freeze.cmd).toContain("git add -A");
    expect(freeze.cmd).toContain("git rm");
    expect(freeze.cmd).toContain("--cached");
    expect(freeze.cmd).toContain(ARTIFACT_DENYLIST_RE);
    // Denylist actually matches common artifacts and not source.
    const re = new RegExp(ARTIFACT_DENYLIST_RE);
    expect(re.test("tests/__pycache__/x.cpython-312.pyc")).toBe(true);
    expect(re.test("src/node_modules/foo/index.js")).toBe(true);
    expect(re.test("build/out.o")).toBe(true);
    expect(re.test("src/calc.py")).toBe(false);
    expect(re.test("tests/test_divide.py")).toBe(false);
  });

  test("not-resolved when a pass_to_pass regresses", async () => {
    const provider = scripted({ f2p: execResult({ code: 0 }), p2p: execResult({ code: 1 }) });
    const result = await runTrial(TASK, CONFIG, 0, { ...deps({ provider }), provider });
    expect(result.status).toBe("graded");
    expect(result.resolved).toBe(false);
    expect(result.passToPass[0]!.outcome).toBe("fail");
  });

  test("empty patch ⇒ agent_error (a result), grade sandbox never created", async () => {
    const provider = scripted({ diff: "" });
    const result = await runTrial(TASK, CONFIG, 0, { ...deps({ provider }), provider });
    expect(result.status).toBe("agent_error");
    expect(result.error).toContain("empty patch");
    expect(provider.created).toHaveLength(1); // only the agent sandbox
    // ...and it is destroyed, not leaked (regression: agent-failure paths once
    // returned before the destroy, leaving a running sandbox per failed trial).
    expect(provider.destroyed).toContain(provider.created[0]!.id);
  });

  test("agent timeout ⇒ timeout status (a result), not infra", async () => {
    const provider = scripted({ timedOut: true });
    const result = await runTrial(TASK, CONFIG, 0, { ...deps({ provider }), provider });
    expect(result.status).toBe("timeout");
    // The agent sandbox is freed on the timeout path too (no leak).
    expect(provider.destroyed).toContain(provider.created[0]!.id);
  });

  test("candidate patch that does not apply on the clean env ⇒ patch_apply_failed", async () => {
    const provider = scripted({ candidateApply: execResult({ code: 1, stderr: "patch does not apply" }) });
    const result = await runTrial(TASK, CONFIG, 0, { ...deps({ provider }), provider });
    expect(result.status).toBe("patch_apply_failed");
    expect(result.patchApplyOk).toBe(false);
  });

  test("env factory failure ⇒ build_error, no sandboxes", async () => {
    const provider = scripted({});
    const result = await runTrial(TASK, CONFIG, 0, {
      ...deps({ provider }), provider,
      envFactory: async () => { throw new Error("escalated: unbuildable"); },
    });
    expect(result.status).toBe("build_error");
    expect(result.error).toContain("unbuildable");
    expect(provider.created).toHaveLength(0);
  });

  test("quarantined F2P/P2P ids are skipped and recorded", async () => {
    const task: EvalTask = {
      ...TASK,
      quarantined: [{ id: "tests/test_basic.py::test_add", reason: "flaky", evidence: "pass,fail,pass" }],
    };
    const provider = scripted({ f2p: execResult({ code: 0 }) });
    const result = await runTrial(task, CONFIG, 0, { ...deps({ provider }), provider });
    expect(result.quarantinedSkipped).toEqual(["tests/test_basic.py::test_add"]);
    expect(result.passToPass).toEqual([]); // the only p2p was quarantined
    expect(result.resolved).toBe(true);
  });
});

describe("launcher seam", () => {
  test("claude-code and codex build distinct commands + auth envs; unknown throws", () => {
    const ctx = { statement: "fix the bug", budgets: CONFIG.budgets, model: "m", secrets: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" } };
    const claude = resolveLauncher("claude-code").invoke(ctx);
    expect(claude.command).toContain("claude -p 'fix the bug'");
    expect(claude.command).toContain("--dangerously-skip-permissions");
    // IS_SANDBOX is required or claude-code refuses --dangerously-skip-permissions as root.
    expect(claude.env).toEqual({ ANTHROPIC_API_KEY: "a", IS_SANDBOX: "1" });

    const codex = resolveLauncher("codex").invoke(ctx);
    expect(codex.command).toContain("codex exec");
    expect(codex.env).toEqual({ OPENAI_API_KEY: "o" });

    expect(() => resolveLauncher("nope")).toThrow(/unknown agent launcher/);
  });

  test("claude stream-json transcript → turns/tools/usage; codex rollout → its own shape; both degrade unknown fields to null", () => {
    const claudeRaw = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }], usage: { input_tokens: 500, output_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_result", is_error: true }] } }),
      "not json — a stray log line",
    ].join("\n");
    expect(resolveLauncher("claude-code").parseTranscript(claudeRaw)).toEqual({
      launcher: "claude-code", turns: 2, toolCalls: 1, toolErrors: 1,
      inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, wallClockMs: 0,
    });

    const codexRaw = [
      JSON.stringify({ type: "agent_message" }),
      JSON.stringify({ type: "exec_command" }),
      JSON.stringify({ type: "token_count", info: { input_tokens: 300, output_tokens: 80 } }),
    ].join("\n");
    expect(resolveLauncher("codex").parseTranscript(codexRaw)).toEqual({
      launcher: "codex", turns: 1, toolCalls: 1, toolErrors: null,
      inputTokens: 300, outputTokens: 80, cacheReadTokens: null, wallClockMs: 0,
    });
  });
});

describe("runMatrix", () => {
  test("fans out task×config×trial, sorts stably, sums cost", async () => {
    const provider = scripted({ f2p: execResult({ code: 0 }), p2p: execResult({ code: 0 }) });
    provider.getFile = async () => Buffer.from(TRANSCRIPT);
    const report = await runMatrix([TASK], [CONFIG, { ...CONFIG, id: "glm" }], {
      ...deps({ provider }), provider, trialsPerTask: 2, concurrency: 2,
    });
    expect(report.results).toHaveLength(4); // 1 task × 2 configs × 2 trials
    expect(report.results.map((r) => `${r.configId}:${r.trialIndex}`)).toEqual([
      "glm:0", "glm:1", "opus:0", "opus:1",
    ]);
    expect(report.spentUsd).toBeGreaterThan(0);
  });

  test("ONLY infra_error retries (max 2); agent_error never retried", async () => {
    let calls = 0;
    // Fail the agent phase (create throws) the first two times, succeed the third.
    const provider = new TrialProvider(() => execResult());
    const origCreate = provider.create.bind(provider);
    provider.create = async (env, opts) => {
      // Only the AGENT sandbox (network default) is flaky; grade is fine.
      if (opts?.network !== "none") {
        calls += 1;
        if (calls <= 2) throw new Error("docker daemon hiccup");
      }
      return origCreate(env, opts);
    };
    provider.exec = async (s, cmd) => {
      if (cmd.includes("git diff --cached")) return execResult({ stdout: CANDIDATE_PATCH });
      if (cmd.includes("grep -rF")) return execResult({ code: 1 });
      return execResult({ code: 0 });
    };
    const report = await runMatrix([TASK], [CONFIG], {
      ...deps({ provider }), provider, trialsPerTask: 1, maxInfraRetries: 2,
    });
    expect(report.results[0]!.status).toBe("graded");
    expect(report.results[0]!.attempt).toBe(3); // 1 + 2 retries
    expect(calls).toBe(3);
  });

  test("budget kill-switch stops new trials once spend crosses maxUsd", async () => {
    const provider = scripted({ f2p: execResult({ code: 0 }), p2p: execResult({ code: 0 }) });
    provider.getFile = async () => Buffer.from(TRANSCRIPT);
    const report = await runMatrix([TASK], [CONFIG], {
      ...deps({ provider }), provider, trialsPerTask: 10, concurrency: 1, maxUsd: 0.0001,
    });
    // First trial spends > maxUsd, so the rest are skipped.
    expect(report.budgetStopped).toBe(true);
    expect(report.results.length).toBeLessThan(10);
    expect(report.skipped.length).toBeGreaterThan(0);
  });

  test("vendorConcurrency caps in-flight trials per vendor; uncapped vendors use the global pool", async () => {
    const provider = scripted({ f2p: execResult({ code: 0 }), p2p: execResult({ code: 0 }) });
    provider.getFile = async () => Buffer.from(TRANSCRIPT);

    // Observe per-vendor overlap from inside the gated section: resolveSecrets
    // runs once per trial, after the vendor slot is acquired.
    const active = new Map<string, number>();
    const maxSeen = new Map<string, number>();
    const resolveSecrets = async (config: TrialConfig) => {
      const vendor = vendorForConfig(config);
      active.set(vendor, (active.get(vendor) ?? 0) + 1);
      maxSeen.set(vendor, Math.max(maxSeen.get(vendor) ?? 0, active.get(vendor)!));
      await new Promise((resolve) => setTimeout(resolve, 15));
      active.set(vendor, (active.get(vendor) ?? 1) - 1);
      return {};
    };

    const capped = CONFIG; // claude-code → vendor "anthropic"
    const uncapped: TrialConfig = { ...CONFIG, id: "glm", vendor: "zai" };
    const report = await runMatrix([TASK], [capped, uncapped], {
      ...deps({ provider, resolveSecrets }),
      provider,
      trialsPerTask: 2,
      concurrency: 4,
      vendorConcurrency: { anthropic: 1 },
    });

    // Nothing dropped or deadlocked: all 4 cells produced results.
    expect(report.results).toHaveLength(4);
    // The capped vendor never exceeded its cap; the uncapped one used the pool.
    expect(maxSeen.get("anthropic")).toBe(1);
    expect(maxSeen.get("zai")).toBe(2);
  });
});

describe("vendorForConfig", () => {
  test("explicit vendor wins; else baseUrl host; else the launcher default; else the launcher id", () => {
    expect(vendorForConfig({ ...CONFIG, vendor: "zai", baseUrl: "https://api.z.ai/v1" })).toBe("zai");
    expect(vendorForConfig({ ...CONFIG, baseUrl: "https://api.z.ai/api/anthropic" })).toBe("api.z.ai");
    expect(vendorForConfig({ ...CONFIG, baseUrl: "not a url" })).toBe("not a url");
    expect(vendorForConfig(CONFIG)).toBe("anthropic"); // launcher claude-code
    expect(vendorForConfig({ ...CONFIG, launcher: "codex" })).toBe("openai");
    expect(vendorForConfig({ ...CONFIG, launcher: "my-custom-agent" })).toBe("my-custom-agent");
  });
});
