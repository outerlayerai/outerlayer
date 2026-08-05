// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { recordDeterminism } from "../writeback.js";

const HASH = "c".repeat(64);
const BLOCK = {
  image_digest: `sha256:${"d".repeat(64)}`,
  lockfile_hashes: { "requirements.txt": HASH },
};

const TASK_YAML = `# provenance: mined from PR #7 — keep this comment
id: t1
repo: https://github.com/acme/widget.git
environment:
  base_image: python:3.12-slim # pinned by hand
  setup: ""
`;

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ol-writeback-"));
  path = join(dir, "t1.yaml");
  await writeFile(path, TASK_YAML);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("recordDeterminism", () => {
  test("records the block, preserving comments and untouched fields", async () => {
    expect(await recordDeterminism(path, BLOCK)).toBe(true);

    const written = await readFile(path, "utf8");
    expect(written).toContain("# provenance: mined from PR #7 — keep this comment");
    expect(written).toContain("# pinned by hand");
    expect(parse(written)).toEqual({
      id: "t1",
      repo: "https://github.com/acme/widget.git",
      environment: { base_image: "python:3.12-slim", setup: "" },
      determinism: BLOCK,
    });
  });

  test("idempotent: an already-current block is a no-op and never rewrites the file", async () => {
    await recordDeterminism(path, BLOCK);
    const firstWrite = await readFile(path, "utf8");

    expect(await recordDeterminism(path, BLOCK)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(firstWrite);
  });

  test("equality is key-order-insensitive — a reordered but equal block is current", async () => {
    await writeFile(
      path,
      TASK_YAML +
        `determinism:\n  lockfile_hashes:\n    requirements.txt: ${HASH}\n  image_digest: sha256:${"d".repeat(64)}\n`,
    );
    expect(await recordDeterminism(path, BLOCK)).toBe(false);
  });

  test("a drifted block is replaced", async () => {
    await recordDeterminism(path, BLOCK);
    const drifted = {
      ...BLOCK,
      lockfile_hashes: { "requirements.txt": "e".repeat(64) },
    };
    expect(await recordDeterminism(path, drifted)).toBe(true);

    const written = parse(await readFile(path, "utf8")) as { determinism: unknown };
    expect(written.determinism).toEqual(drifted);
  });
});
