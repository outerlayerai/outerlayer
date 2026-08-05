// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Live env-prep against the real local Docker daemon. Gated:
//   OUTERLAYER_ENV_PREP_LIVE=1 yarn test:env-live
//
// Exercises the three real outcomes end to end:
//   1. deterministic build → warm boot <30s from the snapshot (acceptance)
//   2. broken setup → scripted repair model fixes it → repaired provenance
//   3. impossible setup → ladder exhausts → escalation, no silent failure
// Set OUTERLAYER_ENV_REPORT_DIR to also write the EnvBuildReport artifacts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalDockerProvider } from "@outerlayer/runner-core";
import type { Sandbox, SandboxProvider } from "@outerlayer/runner-core";
import type { EvalTask } from "@outerlayer/task-format";
import { EnvPrepService } from "../prepare.js";
import { collectEscalationSink, type EscalationItem } from "../escalation.js";
import { renderEnvReportText } from "../report.js";
import type { RepairModel } from "../repair.js";

const LIVE = process.env.OUTERLAYER_ENV_PREP_LIVE === "1";

const APP_PY = `def add(a, b):
    return a + b
`;
const TEST_PY = `from app import add


def test_add():
    assert add(2, 2) == 4
`;

async function materializeFixture(sandbox: Sandbox, provider: SandboxProvider): Promise<void> {
  await provider.putFiles(sandbox, {
    "/work/repo/app.py": APP_PY,
    "/work/repo/tests/test_app.py": TEST_PY,
  });
  const r = await provider.exec(
    sandbox,
    "cd /work/repo && git init -q && git add -A && git -c user.email=e@o.dev -c user.name=o commit -qm base",
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error(`fixture init failed: ${r.stderr}`);
}

function task(overrides: Partial<EvalTask>): EvalTask {
  return {
    schema_version: 1,
    id: "live-env",
    repo: "fixture://app",
    base_commit: "v1",
    problem_statement: "add() should sum two numbers; a regression made it concatenate instead — fix it.",
    test_patch: `--- /dev/null\n+++ b/tests/test_new.py\n@@ -0,0 +1,2 @@\n+def test_new():\n+    assert True\n`,
    gold_patch: `--- a/app.py\n+++ b/app.py\n@@ -1,1 +1,2 @@\n def add(a, b):\n+    # noop\n     return a + b\n`,
    fail_to_pass: ["tests/test_new.py::test_new"],
    pass_to_pass: [],
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

describe.skipIf(!LIVE)("env-prep vs live local Docker", () => {
  test("deterministic + repair + escalation, with a warm boot under 30s", async () => {
    const provider = new LocalDockerProvider();
    const escalations: EscalationItem[] = [];

    // A context-aware repair model: it reads the build error. A bad pytest pin
    // is fixable (propose a real version, distinct from the deterministic
    // task's so it keys its OWN env); a bare `exit N` is not — it proposes
    // another failing command, so that task exhausts the budget and escalates.
    const repairModel: RepairModel = {
      async proposeSetup(context) {
        expect(context.failure.stage).toBe("setup");
        const looksLikeBadPin =
          context.previousSetup.includes("0.0.0") ||
          /no matching distribution|does-not-exist/i.test(context.failure.excerpt);
        return looksLikeBadPin
          ? { setup: "pip install --quiet pytest==8.3.4", costUsd: 0.15 }
          : { setup: `exit ${8 + context.attempt}`, costUsd: 0.15 };
      },
    };
    const persisted: { id: string; setup: string }[] = [];
    const service = new EnvPrepService({
      provider,
      materializeRepo: materializeFixture,
      repairModel,
      budget: { maxAttempts: 2 }, // keep the impossible-case ladder short + fast
      escalationSink: collectEscalationSink(escalations),
      onRepairedSetup: (t, setup) => { persisted.push({ id: t.id, setup }); },
    });

    const deterministic = task({ id: "det" });
    const broken = task({
      id: "broken",
      // Wrong pin → pip fails → repair ladder kicks in.
      environment: { ...task({}).environment, setup: "pip install --quiet pytest==0.0.0-does-not-exist" },
    });
    const impossible = task({
      id: "impossible",
      environment: { ...task({}).environment, setup: "exit 7" },
    });

    const report = await service.prepareEnvAll([deterministic, broken, impossible]);

    const outDir = process.env.OUTERLAYER_ENV_REPORT_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "env-report.json"), JSON.stringify(report, null, 2));
      writeFileSync(join(outDir, "env-report.txt"), renderEnvReportText(report));
    }

    expect(report.results.map((r) => [r.taskId, r.outcome])).toEqual([
      ["det", "deterministic"],
      ["broken", "repaired"],
      ["impossible", "escalated"],
    ]);
    expect(report.summary).toMatchObject({ deterministic: 1, repaired: 1, escalated: 1, ready: 2 });

    // Repair persisted the working setup with provenance.
    expect(broken.env_source).toBe("repaired");
    expect(broken.environment.setup).toBe("pip install --quiet pytest==8.3.4");
    expect(persisted).toContainEqual({ id: "broken", setup: "pip install --quiet pytest==8.3.4" });

    // Escalation is a real, readable item — never a silent skip.
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.taskIds).toEqual(["impossible"]);
    expect(escalations[0]!.lastErrors[0]!.stage).toBe("setup");

    // Acceptance: warm boot from the snapshot < 30s.
    const env = await service.prepareEnv(deterministic); // index hit
    const bootStart = Date.now();
    const sandbox = await provider.create(env, { network: "none" });
    const probe = await provider.exec(sandbox, "cd /work/repo && python -m pytest -q --collect-only", { timeoutMs: 60_000 });
    const bootMs = Date.now() - bootStart;
    await provider.destroy(sandbox);
    expect(probe.code).toBe(0);
    expect(bootMs).toBeLessThan(30_000);
    if (outDir) writeFileSync(join(outDir, "warm-boot.txt"), `warm boot + probe from snapshot: ${bootMs}ms (<30s acceptance)\n`);

    // Clean up env images we built.
    for (const key of [report.results[0]!.envKey, report.results[1]!.envKey]) {
      if (key) await provider.removeEnvImage(key).catch(() => {});
    }
    expect(await provider.list()).toEqual([]);
  }, 600_000);
});
