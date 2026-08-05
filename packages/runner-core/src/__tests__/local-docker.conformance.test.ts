// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Live conformance run against the local Docker daemon. Gated:
//   OUTERLAYER_CONFORMANCE=1 yarn test:conformance
// CI runs this on a docker-enabled runner; it is skipped otherwise.

import { conformanceSuite } from "../conformance.js";
import { LocalDockerProvider } from "../local-docker.js";

conformanceSuite({
  name: "local-docker",
  makeProvider: () => new LocalDockerProvider(),
  baseImage: "alpine:3.20",
  warmBootBudgetMs: 30_000,
  parallelSandboxes: 10,
  hooks: {
    inspectConfigEnv: (provider, sandbox) =>
      (provider as LocalDockerProvider).inspectConfigEnv(sandbox),
    inspectImageHistory: (provider, env) =>
      (provider as LocalDockerProvider).inspectImageHistory(env.imageRef),
    cleanupEnvImage: (provider, key) => (provider as LocalDockerProvider).removeEnvImage(key),
  },
});
