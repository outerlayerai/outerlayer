// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Live conformance against real Fly infrastructure. Doubly gated:
//   OUTERLAYER_CONFORMANCE=1 FLY_API_TOKEN=... FLY_ORG_SLUG=... yarn test:conformance
// Intended to run as a scheduled CI job, not on every push.
// HUMAN-REQUIRED: founder provisions the Fly org token.

import { describe, it } from "vitest";
import { conformanceSuite } from "../conformance.js";
import { FlyProvider } from "../fly.js";

const token = process.env.FLY_API_TOKEN;
const org = process.env.FLY_ORG_SLUG;

if (token && org) {
  conformanceSuite({
    name: "fly",
    makeProvider: () =>
      new FlyProvider({
        apiToken: token,
        orgSlug: org,
        appPrefix: process.env.FLY_APP_PREFIX ?? "ol-conf",
      }),
    baseImage: "alpine:3.20",
    // machine create + image pull is slower than a warm local container
    warmBootBudgetMs: 30_000,
    parallelSandboxes: 10,
  });
} else {
  describe.skip("SandboxProvider conformance: fly (set FLY_API_TOKEN + FLY_ORG_SLUG)", () => {
    it("skipped — credentials not provided", () => undefined);
  });
}
