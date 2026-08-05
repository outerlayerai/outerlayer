// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runImportRuler, ImportRulerError } from "../import-ruler-cmd.js";

let root: string;

function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const MCP_JSON = '{\n  "mcpServers": {\n    "api": {\n      "url": "https://api.example.com"\n    }\n  }\n}\n';

function writeFixture(rootDir: string): void {
  write(rootDir, ".ruler/AGENTS.md", "Root ruler instructions.\n");
  write(rootDir, ".ruler/b-notes.md", "B notes content.\n");
  write(rootDir, ".ruler/a-notes.md", "A notes content.\n");
  write(rootDir, ".ruler/mcp.json", MCP_JSON);
  write(rootDir, ".ruler/ruler.toml", '[default]\nagents = ["claude"]\n');
  write(rootDir, ".ruler/weird-file.txt", "not a recognized shape\n");
  write(rootDir, ".ruler/subdir/nested.md", "nested, not part of the binding mapping\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-import-ruler-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runImportRuler — fixture import, byte-exact", () => {
  it("imports AGENTS.md + mcp.json, concatenating other root .md files in filename order with separators", () => {
    writeFixture(root);
    const result = runImportRuler({ cwd: root, quiet: true });

    expect(result.exitCode).toBe(0);
    expect(result.scopes).toEqual([
      { scopePath: "", agentsMdWritten: ".outerlayer/AGENTS.md", mcpWritten: ".outerlayer/mcp.json" },
    ]);

    const expectedAgents =
      "Root ruler instructions.\n" +
      "\n\n<!-- imported from .ruler/a-notes.md -->\n\n" +
      "A notes content.\n" +
      "\n\n<!-- imported from .ruler/b-notes.md -->\n\n" +
      "B notes content.\n";
    expect(readFileSync(join(root, ".outerlayer/AGENTS.md"), "utf8")).toBe(expectedAgents);
    expect(readFileSync(join(root, ".outerlayer/mcp.json"), "utf8")).toBe(MCP_JSON);

    // Nothing else was written into .outerlayer/ — no subagent/skill/command dirs.
    expect(existsSync(join(root, ".outerlayer/agents"))).toBe(false);
    expect(existsSync(join(root, ".outerlayer/skills"))).toBe(false);
  });

  it("warns about ruler.toml without importing it", () => {
    writeFixture(root);
    const result = runImportRuler({ cwd: root, quiet: true });
    expect(result.warnings).toContainEqual({
      code: "ruler_toml_not_imported",
      path: ".ruler/ruler.toml",
      message: ".ruler/ruler.toml was not imported — target selection now lives in .outerlayer/config.json; per-tool config is superseded",
    });
    expect(existsSync(join(root, ".outerlayer/ruler.toml"))).toBe(false);
  });

  it("surfaces unmapped files (including nested ones) as warnings, never silently dropping them", () => {
    writeFixture(root);
    const result = runImportRuler({ cwd: root, quiet: true });
    expect(result.warnings).toContainEqual({
      code: "unmapped_file",
      path: ".ruler/weird-file.txt",
      message: ".ruler/weird-file.txt has no .outerlayer/ equivalent — not imported",
    });
    expect(result.warnings).toContainEqual({
      code: "unmapped_file",
      path: ".ruler/subdir/nested.md",
      message: ".ruler/subdir/nested.md has no .outerlayer/ equivalent — not imported",
    });
  });
});

describe("runImportRuler — existing .outerlayer/ refusal", () => {
  it("refuses when .outerlayer/ already exists at a .ruler/ scope, writing nothing", () => {
    writeFixture(root);
    write(root, ".outerlayer/AGENTS.md", "Already have one, thanks.\n");

    expect(() => runImportRuler({ cwd: root, quiet: true })).toThrow(ImportRulerError);
    expect(() => runImportRuler({ cwd: root, quiet: true })).toThrow(/already exists at: \.outerlayer/);

    // Untouched — the pre-existing file is exactly what it was.
    expect(readFileSync(join(root, ".outerlayer/AGENTS.md"), "utf8")).toBe("Already have one, thanks.\n");
    expect(existsSync(join(root, ".outerlayer/mcp.json"))).toBe(false);
  });

  it("a conflict at one scope blocks every scope, not just the conflicting one", () => {
    writeFixture(root);
    write(root, "apps/api/.ruler/AGENTS.md", "API ruler instructions.\n");
    write(root, ".outerlayer/AGENTS.md", "Root already migrated.\n");

    expect(() => runImportRuler({ cwd: root, quiet: true })).toThrow(ImportRulerError);
    // The non-conflicting apps/api scope was NOT imported either.
    expect(existsSync(join(root, "apps/api/.outerlayer"))).toBe(false);
  });
});

describe("runImportRuler — multiple scopes", () => {
  it("imports every discovered .ruler/ dir to its own sibling .outerlayer/", () => {
    write(root, ".ruler/AGENTS.md", "Root instructions.\n");
    write(root, "apps/api/.ruler/AGENTS.md", "API instructions.\n");

    const result = runImportRuler({ cwd: root, quiet: true });

    expect(result.exitCode).toBe(0);
    expect(result.scopes).toEqual([
      { scopePath: "", agentsMdWritten: ".outerlayer/AGENTS.md" },
      { scopePath: "apps/api", agentsMdWritten: "apps/api/.outerlayer/AGENTS.md" },
    ]);
    expect(readFileSync(join(root, ".outerlayer/AGENTS.md"), "utf8")).toBe("Root instructions.\n");
    expect(readFileSync(join(root, "apps/api/.outerlayer/AGENTS.md"), "utf8")).toBe("API instructions.\n");
  });
});

describe("runImportRuler — no .ruler/ found", () => {
  it("is a benign no-op — exit 0, nothing written", () => {
    const result = runImportRuler({ cwd: root, quiet: true });
    expect(result.exitCode).toBe(0);
    expect(result.scopes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("runImportRuler --json", () => {
  it("emits parsable JSON with the exact scopes/warnings shape", () => {
    writeFixture(root);
    const result = runImportRuler({ cwd: root, json: true, quiet: true });
    const parsed = JSON.parse(result.output) as { scopes: unknown[]; warnings: unknown[] };
    expect(parsed.scopes).toEqual(result.scopes);
    expect(parsed.warnings).toEqual(result.warnings);
  });
});
