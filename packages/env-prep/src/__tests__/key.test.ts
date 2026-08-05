// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Cache-key correctness: changed lockfile ⇒ new key;
// unchanged ⇒ hit. A property sweep over the whole input surface.

import { describe, expect, test } from "vitest";
import { envCacheKey, envKeyForTask, type EnvKeyInputs } from "../key.js";
import { buildTask } from "./helpers.js";

const BASE: EnvKeyInputs = {
  repo: "https://example.invalid/r.git",
  baseCommit: "aaaa1111",
  setup: "pip install -q pytest",
  baseImage: "python:3.12-bookworm",
  imageDigest: "sha256:deadbeef",
  lockfileHashes: { "poetry.lock": "h1", "requirements.txt": "h2" },
};

describe("envCacheKey", () => {
  test("deterministic and 16 hex chars", () => {
    const key = envCacheKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(envCacheKey({ ...BASE })).toBe(key);
  });

  test("lockfile hash order does not matter; a changed hash does", () => {
    const reordered = envCacheKey({
      ...BASE,
      lockfileHashes: { "requirements.txt": "h2", "poetry.lock": "h1" },
    });
    expect(reordered).toBe(envCacheKey(BASE));

    const changed = envCacheKey({
      ...BASE,
      lockfileHashes: { "poetry.lock": "h1", "requirements.txt": "CHANGED" },
    });
    expect(changed).not.toBe(envCacheKey(BASE));
  });

  test("every build-relevant field participates — flipping any one changes the key", () => {
    const mutations: Partial<EnvKeyInputs>[] = [
      { repo: "https://example.invalid/other.git" },
      { baseCommit: "bbbb2222" },
      { setup: "pip install -q pytest ruff" },
      { baseImage: "python:3.11-bookworm" },
      { imageDigest: "sha256:feedface" },
      { lockfileHashes: { "poetry.lock": "h1" } }, // dropped one lockfile
    ];
    const base = envCacheKey(BASE);
    for (const mutation of mutations) {
      expect(envCacheKey({ ...BASE, ...mutation }), JSON.stringify(mutation)).not.toBe(base);
    }
  });

  test("a repaired setup keys a DIFFERENT env than the broken one it replaced", () => {
    const task = buildTask();
    const broken = envKeyForTask(task);
    const repaired = envKeyForTask(task, "apt-get install -y libpq-dev && pip install -q pytest");
    expect(repaired).not.toBe(broken);
    // …and the default override reproduces the task's own key.
    expect(envKeyForTask(task, task.environment.setup)).toBe(broken);
  });

  test("determinism block (image digest + lockfiles) folds into the task key", () => {
    const plain = buildTask();
    const pinned = buildTask({
      determinism: { image_digest: "sha256:abc", lockfile_hashes: { "poetry.lock": "x" } },
    });
    expect(envKeyForTask(pinned)).not.toBe(envKeyForTask(plain));
  });
});
