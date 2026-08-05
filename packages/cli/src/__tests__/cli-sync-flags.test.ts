// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * CLI argv surface for `sync`.
 *
 * The hook-triggered background sync spawns `sync --quiet`. The `quiet`
 * OPTION existed programmatically and every unit test injected it as
 * `{ quiet: true }` — but the commander command never registered the FLAG,
 * so every hook-spawned sync died instantly with "unknown option '--quiet'".
 * Nothing failed loudly: the spawn is detached with output ignored (by
 * design). This test drives the real argv path so the flag can never
 * silently vanish again.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { runCli } from "../cli.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-cliflags-root-"));
  home = mkdtempSync(join(tmpdir(), "ol-cliflags-home-"));
  process.env.HOME = home;
  process.env.OUTERLAYER_URL = "https://gw.outerlayer.test";
  process.env.OUTERLAYER_API_KEY = "sk_test";
  process.env.OUTERLAYER_APP_ID = "app-1";
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.OUTERLAYER_URL;
  delete process.env.OUTERLAYER_API_KEY;
  delete process.env.OUTERLAYER_APP_ID;
  vi.restoreAllMocks();
});

describe("sync argv surface", () => {
  it("accepts --quiet (the exact invocation the Stop hook spawns) and prints nothing", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;

    // Empty roots: scan finds nothing, ships nothing — the assertion is that
    // commander ACCEPTS the argv and the run completes silently with exit 0.
    await runCli([
      "node", "outerlayer", "sync", "--quiet",
      "--root", root,
      "--codex-root", join(root, "none"),
      "--cursor-root", join(root, "none"),
    ]);

    expect(process.exitCode).toBe(0);
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
