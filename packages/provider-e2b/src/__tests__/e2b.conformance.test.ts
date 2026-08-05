// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// LIVE SandboxProvider conformance against real E2B (SDK v2.x). Gated behind BOTH:
//   OUTERLAYER_CONFORMANCE=1  E2B_API_KEY=e2b_***  yarn test:conformance
// (skipped otherwise — it boots real Firecracker microVMs and bills the key).
//
// Template: defaults to E2B's `base` (python/git present). Override with
// OUTERLAYER_E2B_TEMPLATE. The suite's egress test shells out to `wget`, so the
// template must ship it; `base` does. cpu/mem create-opts are no-ops on E2B
// (template-level); `pidsLimit` is enforced via `ulimit -u`.
//
// Full contract expected: the "prepareEnv builds once" case now passes because
// v2 `createSnapshot()` lets prepareEnv build once and boot N sandboxes from the
// snapshot. `cleanupEnvImage` deletes the snapshot so the run leaves no stored
// images behind.

import { describe, it } from "vitest";
import { conformanceSuite } from "@outerlayer/runner-core/conformance";
import type { Sandbox as OlSandbox, SandboxProvider } from "@outerlayer/runner-core";
import { E2BProvider } from "../index.js";

const apiKey = process.env.E2B_API_KEY ?? "";
const template = process.env.OUTERLAYER_E2B_TEMPLATE ?? "base";

// Only wire the live suite when a key is present — makeProvider constructs the
// provider at collection time (even under describe.skip), and the constructor
// requires a key. No key ⇒ a single skipped placeholder so the file isn't empty.
if (!apiKey) {
  describe.skip("e2b conformance (set E2B_API_KEY + OUTERLAYER_CONFORMANCE=1)", () => {
    it("skipped — no E2B_API_KEY", () => {});
  });
} else {
  conformanceSuite({
    name: `e2b (${template})`,
    makeProvider: () => new E2BProvider({ apiKey, template, defaultTimeoutMs: 120_000 }),
    baseImage: template,
    warmBootBudgetMs: 60_000, // cold Firecracker boot + re-materialize
    parallelSandboxes: 3, // keep concurrency modest on shared/free tiers
    hooks: {
      // Metadata is E2B's sandbox-config surface — prove no secret leaks into it.
      inspectConfigEnv: (provider: SandboxProvider, sandbox: OlSandbox) =>
        (provider as E2BProvider).inspectConfigEnv(sandbox),
      // Delete the env snapshot so the suite leaves no stored images behind.
      cleanupEnvImage: (provider: SandboxProvider, key: string) =>
        (provider as E2BProvider).cleanupEnvImage(key),
      // E2B has no per-env image/layer history to inspect for baked secrets.
    },
  });
}
