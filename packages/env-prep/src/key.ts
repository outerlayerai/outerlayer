// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Content-addressed env identity. Two envs share a snapshot iff
 * every build-relevant input matches:
 *
 *   hash(repo, base_commit, setup, base_image, image_digest?, lockfile_hashes?)
 *
 * `base_commit` already pins the lockfiles that live IN the repo — the
 * explicit `lockfile_hashes` matter when `base_commit` is a moving ref or
 * when private registries can serve different bytes for the same lockfile.
 * `image_digest` pins the base image beyond its mutable tag; when a task's
 * `determinism` block carries either, they participate in the key.
 */

import { createHash } from "node:crypto";
import type { EvalTask } from "@outerlayer/task-format";

export interface EnvKeyInputs {
  repo: string;
  baseCommit: string;
  setup: string;
  baseImage: string;
  imageDigest?: string;
  /** lockfile path → content hash, order-insensitive. */
  lockfileHashes?: Record<string, string>;
}

export function envCacheKey(inputs: EnvKeyInputs): string {
  const lockfiles = Object.entries(inputs.lockfileHashes ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: inputs.repo,
        commit: inputs.baseCommit,
        setup: inputs.setup,
        image: inputs.baseImage,
        digest: inputs.imageDigest ?? "",
        lockfiles,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Key for a task, optionally overriding setup (each repair attempt builds
 * under ITS setup's key — a repaired env never aliases the broken one). */
export function envKeyForTask(task: EvalTask, setupOverride?: string): string {
  return envCacheKey({
    repo: task.repo,
    baseCommit: task.base_commit,
    setup: setupOverride ?? task.environment.setup,
    baseImage: task.environment.base_image,
    imageDigest: task.determinism?.image_digest,
    lockfileHashes: task.determinism?.lockfile_hashes,
  });
}
