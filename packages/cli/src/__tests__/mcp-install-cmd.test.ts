// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpInstall, McpInstallError, DEFAULT_MCP_URL } from "../mcp-install-cmd.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-mcp-install-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runMcpInstall", () => {
  it("writes a fresh .mcp.json with the outerlayer server pointing at the hosted default URL", () => {
    const result = runMcpInstall({ cwd: root, quiet: true });

    expect(result).toEqual(
      expect.objectContaining({ path: ".mcp.json", server: "outerlayer", url: DEFAULT_MCP_URL, changed: true, exitCode: 0 }),
    );
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(written).toEqual({
      mcpServers: {
        outerlayer: {
          type: "http",
          url: DEFAULT_MCP_URL,
          headers: { Authorization: "Bearer ${OUTERLAYER_API_KEY}" },
        },
      },
    });
  });

  it("never writes a literal API key — only the ${OUTERLAYER_API_KEY} placeholder", () => {
    runMcpInstall({ cwd: root, quiet: true });
    const raw = readFileSync(join(root, ".mcp.json"), "utf8");
    expect(raw).toContain("${OUTERLAYER_API_KEY}");
    expect(raw).not.toMatch(/sk_outerlayer_/);
  });

  it("merges into an existing .mcp.json without disturbing other servers", () => {
    const existing = { mcpServers: { other: { command: "npx", args: ["some-other-server"] } } };
    writeFileSync(join(root, ".mcp.json"), JSON.stringify(existing, null, 2));

    const result = runMcpInstall({ cwd: root, url: "http://localhost:9001/v1/mcp", quiet: true });

    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(written.mcpServers.other).toEqual({ command: "npx", args: ["some-other-server"] });
    expect(written.mcpServers.outerlayer).toEqual({
      type: "http",
      url: "http://localhost:9001/v1/mcp",
      headers: { Authorization: "Bearer ${OUTERLAYER_API_KEY}" },
    });
  });

  it("is idempotent — re-running with the same url/name reports changed: false and rewrites nothing meaningfully", () => {
    runMcpInstall({ cwd: root, quiet: true });
    const result = runMcpInstall({ cwd: root, quiet: true });

    expect(result.changed).toBe(false);
  });

  it("respects --url and --name for a self-hosted gateway under a custom server key", () => {
    const result = runMcpInstall({ cwd: root, url: "https://gw.internal.example/v1/mcp", name: "outerlayer-self-host", quiet: true });

    expect(result).toEqual(
      expect.objectContaining({ server: "outerlayer-self-host", url: "https://gw.internal.example/v1/mcp" }),
    );
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["outerlayer-self-host"]);
  });

  it("refuses to overwrite a .mcp.json that isn't valid JSON", () => {
    writeFileSync(join(root, ".mcp.json"), "{ not valid json");
    expect(() => runMcpInstall({ cwd: root, quiet: true })).toThrow(McpInstallError);
  });

  it("refuses a non-existent target directory", () => {
    expect(() => runMcpInstall({ cwd: join(root, "nope"), quiet: true })).toThrow(McpInstallError);
  });
});
