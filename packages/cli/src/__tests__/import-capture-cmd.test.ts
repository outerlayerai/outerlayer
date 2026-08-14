// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runImportCapture, ImportCaptureError } from "../import-capture-cmd.js";
import { runCli } from "../cli.js";

const SKILL = ".outerlayer/skills/emitting-evidence/SKILL.md";
const SNIPPET = ".outerlayer/skills/emitting-evidence/references/agents-snippet.md";
const AGENTS = ".outerlayer/AGENTS.md";
const MARKER = "<!-- outerlayer:capture-pack -->";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-importcap-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function write(relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("runImportCapture", () => {
  // proves AC-084-18 — installing the capture pack in a fresh repo writes
  // the emitting-evidence skill (carrying the full capture contract: when
  // to capture, per-kind mechanics, captions, criterion binding, and the
  // noise rule) plus the AGENTS.md snippet reference — and never invents a
  // root .outerlayer/AGENTS.md.
  it("writes the skill and the snippet reference into a fresh repo", () => {
    const result = runImportCapture({ cwd: root, quiet: true });

    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([SKILL, SNIPPET]);
    expect(result.appendedAgentsMd).toBe(false);

    const skill = readFileSync(join(root, SKILL), "utf8");
    expect(skill).toContain("name: emitting-evidence");
    expect(skill).toContain("## When to capture");
    expect(skill).toContain("## Per-kind mechanics");
    expect(skill).toContain("## Captions");
    expect(skill).toContain("## Binding with --for");
    expect(skill).toContain("## The noise rule");
    expect(skill).toContain("outerlayer emit artifact");

    const snippet = readFileSync(join(root, SNIPPET), "utf8");
    expect(snippet.startsWith(MARKER + "\n")).toBe(true);
    expect(snippet).toContain("## Emitting evidence");

    expect(existsSync(join(root, AGENTS))).toBe(false);
    expect(result.output).toContain(`wrote ${SKILL}`);
    expect(result.output).toContain(`wrote ${SNIPPET}`);
    expect(result.output).toContain("outerlayer emit");
  });

  it("appends the snippet to a pre-existing .outerlayer/AGENTS.md, marker-guarded", () => {
    write(AGENTS, "House rules.\n");
    const result = runImportCapture({ cwd: root, quiet: true });

    expect(result.appendedAgentsMd).toBe(true);
    const snippet = readFileSync(join(root, SNIPPET), "utf8");
    // The appended block IS the snippet file, separated by one blank line.
    expect(readFileSync(join(root, AGENTS), "utf8")).toBe("House rules.\n\n" + snippet);
  });

  it("skips the append silently when the marker is already present", () => {
    const existing = `House rules.\n\n${MARKER}\nhand-carried copy of the snippet\n`;
    write(AGENTS, existing);
    const result = runImportCapture({ cwd: root, quiet: true });

    expect(result.appendedAgentsMd).toBe(false);
    expect(readFileSync(join(root, AGENTS), "utf8")).toBe(existing);
    // The skill files still install — only the append is guarded.
    expect(existsSync(join(root, SKILL))).toBe(true);
  });

  it("refuses when the skill already exists, writing nothing new", () => {
    write(SKILL, "hand-tuned skill\n");
    write(AGENTS, "House rules.\n");

    expect(() => runImportCapture({ cwd: root, quiet: true })).toThrow(ImportCaptureError);
    expect(() => runImportCapture({ cwd: root, quiet: true })).toThrow(/refusing to import — .*SKILL\.md already exists/);

    expect(readFileSync(join(root, SKILL), "utf8")).toBe("hand-tuned skill\n");
    expect(existsSync(join(root, SNIPPET))).toBe(false);
    expect(readFileSync(join(root, AGENTS), "utf8")).toBe("House rules.\n");
  });

  it("--json reports exactly {files, appendedAgentsMd}", () => {
    write(AGENTS, "House rules.\n");
    const result = runImportCapture({ cwd: root, quiet: true, json: true });
    expect(JSON.parse(result.output)).toEqual({ files: [SKILL, SNIPPET], appendedAgentsMd: true });
  });
});

describe("import capture argv surface", () => {
  it("dispatches `import capture --dir` through commander and installs the pack", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;

    await runCli(["node", "outerlayer", "import", "capture", "--dir", root]);

    expect(process.exitCode).toBe(0);
    expect(existsSync(join(root, SKILL))).toBe(true);
    const stdoutText = out.mock.calls.map((c) => String(c[0])).join("");
    expect(stdoutText).toContain("outerlayer emit");
    expect(err).not.toHaveBeenCalled();
  });
});
