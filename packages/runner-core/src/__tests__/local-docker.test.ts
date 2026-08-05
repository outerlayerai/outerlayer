// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import type Docker from "dockerode";
import { LocalDockerProvider } from "../local-docker.js";

/** Provider with a stubbed image-inspect — resolveImageDigest is host-side
 * metadata only, so no daemon is needed. */
function providerWithInspect(inspect: () => Promise<unknown>): LocalDockerProvider {
  const docker = { getImage: () => ({ inspect }) } as unknown as Docker;
  return new LocalDockerProvider({ docker });
}

describe("LocalDockerProvider.resolveImageDigest", () => {
  it("prefers the registry digest from RepoDigests, stripping the repo prefix", async () => {
    const provider = providerWithInspect(async () => ({
      Id: `sha256:${"1".repeat(64)}`,
      RepoDigests: [`python@sha256:${"a".repeat(64)}`],
    }));
    await expect(provider.resolveImageDigest("python:3.12-slim")).resolves.toBe(
      `sha256:${"a".repeat(64)}`,
    );
  });

  it("passes a digest-shaped RepoDigests entry through verbatim when there is no repo prefix", async () => {
    const provider = providerWithInspect(async () => ({
      Id: `sha256:${"1".repeat(64)}`,
      RepoDigests: [`sha256:${"b".repeat(64)}`],
    }));
    await expect(provider.resolveImageDigest("odd:tag")).resolves.toBe(`sha256:${"b".repeat(64)}`);
  });

  it("falls back to the local image id when the image was never pulled/pushed", async () => {
    const provider = providerWithInspect(async () => ({
      Id: `sha256:${"1".repeat(64)}`,
      RepoDigests: [],
    }));
    await expect(provider.resolveImageDigest("locally-built:dev")).resolves.toBe(
      `sha256:${"1".repeat(64)}`,
    );
  });

  it("resolves undefined instead of throwing when inspect fails", async () => {
    const provider = providerWithInspect(async () => {
      throw new Error("no such image");
    });
    await expect(provider.resolveImageDigest("missing:latest")).resolves.toBeUndefined();
  });
});
