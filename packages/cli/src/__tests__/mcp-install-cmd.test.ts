// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpInstall, McpInstallError, DEFAULT_MCP_URL, buildServerEntry, handleMcpInstallError } from "../mcp-install-cmd.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-mcp-install-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildServerEntry", () => {
  // A round trip through JSON.stringify/JSON.parse (what runMcpInstall
  // actually writes and reads back) drops an `undefined`-valued key exactly
  // like a genuinely absent one — so a test that only inspects the written
  // FILE can't tell "appId omitted" from "appId set to undefined". These
  // inspect the built object directly, before serialization.
  it("sets X-Outerlayer-App-Id as an own key when appId is given", () => {
    const entry = buildServerEntry("http://localhost:9001/v1/mcp", "app-123") as { headers: Record<string, string> };
    expect(Object.hasOwn(entry.headers, "X-Outerlayer-App-Id")).toBe(true);
    expect(entry.headers["X-Outerlayer-App-Id"]).toBe("app-123");
  });

  it("never adds X-Outerlayer-App-Id as a key at all when appId is omitted", () => {
    const entry = buildServerEntry("http://localhost:9001/v1/mcp", undefined) as { headers: Record<string, string> };
    expect(Object.hasOwn(entry.headers, "X-Outerlayer-App-Id")).toBe(false);
    expect(Object.keys(entry.headers)).toEqual(["Authorization"]);
  });
});

describe("runMcpInstall", () => {
  it("writes a fresh .mcp.json with the outerlayer server pointing at the hosted default URL", () => {
    const result = runMcpInstall({ cwd: root, quiet: true });

    expect(result).toEqual(
      expect.objectContaining({ path: ".mcp.json", server: "outerlayer", url: DEFAULT_MCP_URL, changed: true }),
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

  it("omits X-Outerlayer-App-Id when appId isn't given — hosted deployments don't need it", () => {
    runMcpInstall({ cwd: root, quiet: true });
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(written.mcpServers.outerlayer.headers).toEqual({ Authorization: "Bearer ${OUTERLAYER_API_KEY}" });
  });

  it("--app-id emits X-Outerlayer-App-Id alongside the bearer placeholder — self-host's SelfHostAuthResolver requires it", () => {
    const result = runMcpInstall({
      cwd: root,
      url: "http://localhost:9101/v1/mcp",
      appId: "3e9f9c2a-3b1b-4a3a-9c1e-5f6a7b8c9d0e",
      quiet: true,
    });

    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(written).toEqual({
      mcpServers: {
        outerlayer: {
          type: "http",
          url: "http://localhost:9101/v1/mcp",
          headers: {
            Authorization: "Bearer ${OUTERLAYER_API_KEY}",
            "X-Outerlayer-App-Id": "3e9f9c2a-3b1b-4a3a-9c1e-5f6a7b8c9d0e",
          },
        },
      },
    });
  });

  it("refuses to overwrite a .mcp.json that isn't valid JSON", () => {
    writeFileSync(join(root, ".mcp.json"), "{ not valid json");
    expect(() => runMcpInstall({ cwd: root, quiet: true })).toThrow(McpInstallError);
  });

  it("refuses a non-existent target directory", () => {
    expect(() => runMcpInstall({ cwd: join(root, "nope"), quiet: true })).toThrow(McpInstallError);
  });

  it("refuses an existing .mcp.json whose top level is a JSON array", () => {
    writeFileSync(join(root, ".mcp.json"), "[]");
    expect(() => runMcpInstall({ cwd: root, quiet: true })).toThrow(McpInstallError);
  });

  it("refuses an existing .mcp.json whose top level is a JSON null", () => {
    writeFileSync(join(root, ".mcp.json"), "null");
    expect(() => runMcpInstall({ cwd: root, quiet: true })).toThrow(McpInstallError);
  });

  it("refuses an existing .mcp.json whose top level is a JSON string, not an object", () => {
    writeFileSync(join(root, ".mcp.json"), '"just a string"');
    expect(() => runMcpInstall({ cwd: root, quiet: true })).toThrow(McpInstallError);
  });

  it("treats a non-object mcpServers value as absent rather than spreading it into the merged servers", () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: "not-an-object" }));

    const result = runMcpInstall({ cwd: root, quiet: true });

    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["outerlayer"]);
  });

  it("--json emits the exact result fields as JSON on stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = runMcpInstall({ cwd: root, url: "http://localhost:9001/v1/mcp", name: "custom", json: true });

      expect(JSON.parse(result.output)).toEqual({
        path: ".mcp.json",
        server: "custom",
        url: "http://localhost:9001/v1/mcp",
        changed: true,
      });
      expect(writeSpy).toHaveBeenCalledWith(`${result.output}\n`);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("writes the human-readable output to stdout unless quiet is set", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = runMcpInstall({ cwd: root });
      expect(writeSpy).toHaveBeenCalledWith(`${result.output}\n`);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("writes nothing to stdout when quiet is set", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      runMcpInstall({ cwd: root, quiet: true });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("handleMcpInstallError", () => {
  it("reports an McpInstallError to stderr with the exact message and sets exitCode 1, without rethrowing", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;
    try {
      // A throw here would propagate out of this test and fail it — the
      // assertions below are the "didn't throw, and here's the observable
      // effect" check, stronger than an isolated `.not.toThrow()`.
      handleMcpInstallError(new McpInstallError("no such directory: /nope"));
      expect(errSpy).toHaveBeenCalledWith("\x1b[31m✗\x1b[0m no such directory: /nope\n");
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rethrows anything that isn't an McpInstallError unchanged, without touching stderr or exitCode", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;
    const original = new Error("ENOENT: some filesystem error");
    try {
      expect(() => handleMcpInstallError(original)).toThrow(original);
      expect(errSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      errSpy.mockRestore();
      process.exitCode = 0;
    }
  });
});
