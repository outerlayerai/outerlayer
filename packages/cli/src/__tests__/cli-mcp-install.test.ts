// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { runCli } from "../cli.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-cli-mcp-install-"));
  process.exitCode = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("mcp install argv surface", () => {
  it("passes --dir/--url/--name/--json through to runMcpInstall and leaves exitCode untouched on success", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli([
      "node", "outerlayer", "mcp", "install",
      "--dir", root,
      "--url", "http://localhost:9001/v1/mcp",
      "--name", "custom-name",
      "--json",
    ]);

    expect(process.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["custom-name"]);
    expect(written.mcpServers["custom-name"].url).toBe("http://localhost:9001/v1/mcp");
    const stdoutJson = JSON.parse(out.mock.calls[0]![0] as string);
    expect(stdoutJson).toEqual({ path: ".mcp.json", server: "custom-name", url: "http://localhost:9001/v1/mcp", changed: true });
  });

  it("sets exitCode 1 and writes the error to stderr when the target directory does not exist", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "mcp", "install", "--dir", join(root, "does-not-exist")]);

    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("no such directory"));
  });

  it("propagates a non-McpInstallError instead of swallowing it as a directory error", async () => {
    // --dir points at a plain file, not a directory: existsSync(cwd) passes,
    // but writing .mcp.json under it fails with a filesystem error that is
    // not an McpInstallError — the handler must rethrow it, not report it as
    // "no such directory".
    const fileNotDir = join(root, "not-a-directory");
    writeFileSync(fileNotDir, "");

    await expect(runCli(["node", "outerlayer", "mcp", "install", "--dir", fileNotDir])).rejects.toThrow();
  });
});
