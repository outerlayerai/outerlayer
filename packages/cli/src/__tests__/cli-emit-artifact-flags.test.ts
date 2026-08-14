// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * CLI argv surface for `emit artifact`.
 *
 * `emit` is a parent command with its own flat action (context compilation),
 * so the artifact subcommand only exists if commander actually dispatches
 * to it. A registration slip would surface as commander's "too many
 * arguments" at runtime and no unit test of runEmitArtifact would notice —
 * these tests drive the real argv path.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { runCli } from "../cli.js";
import { artifactsSpoolPath } from "../artifact-spool.js";

let root: string;
let home: string;
let savedHome: string | undefined;
let savedClaudecode: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-emitartflags-root-"));
  home = mkdtempSync(join(tmpdir(), "ol-emitartflags-home-"));
  savedHome = process.env.HOME;
  savedClaudecode = process.env.CLAUDECODE;
  process.env.HOME = home;
  delete process.env.CLAUDECODE;
  process.exitCode = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedClaudecode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = savedClaudecode;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("emit artifact argv surface", () => {
  it("dispatches `emit artifact <file>` to the artifact path (missing file → its error, exit 1)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "emit", "artifact", join(root, "missing.png"), "--caption", "wired"]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("no such file");
    expect(out).not.toHaveBeenCalled();
  });

  it("spools through the real argv path when a recorded session is active", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.CLAUDECODE = "1";
    // The subcommand runs from the test process's real cwd — the spool
    // record's cwd must equal it exactly for session detection to bite.
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    appendFileSync(
      join(home, ".outerlayer", "spool", "events.jsonl"),
      JSON.stringify({ t: new Date().toISOString(), event: "PostToolUse", sessionId: "sess-cli-wire", transcriptPath: null, cwd: process.cwd() }) + "\n",
    );
    writeFileSync(join(root, "shot.png"), Buffer.from("bytes"));

    await runCli([
      "node", "outerlayer", "emit", "artifact", join(root, "shot.png"),
      "--caption", "wired through commander",
      "--for", "AC-084-02",
    ]);

    expect(process.exitCode).toBe(0);
    const record = JSON.parse(readFileSync(artifactsSpoolPath(home), "utf8").trim()) as Record<string, unknown>;
    expect(record.sessionId).toBe("sess-cli-wire");
    expect(record.caption).toBe("wired through commander");
    expect(record.criterionId).toBe("AC-084-02");
    const stdoutText = out.mock.calls.map((c) => String(c[0])).join("");
    expect(stdoutText).toContain("spooled");
    expect(err).not.toHaveBeenCalled();
  });

  it("rejects a --pr with trailing garbage, echoing the operator's exact input", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(join(root, "shot.png"), Buffer.from("bytes"));

    await runCli([
      "node", "outerlayer", "emit", "artifact", join(root, "shot.png"),
      "--caption", "x", "--pr", "7abc",
    ]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    // The message carries the raw input — never a silent 7, never "NaN".
    expect(stderrText).toContain('invalid --pr "7abc"');
    expect(stderrText).not.toContain("NaN");
    expect(out).not.toHaveBeenCalled();
  });

  it("passes a strictly numeric --pr through to the command", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.CLAUDECODE = "1";
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    appendFileSync(
      join(home, ".outerlayer", "spool", "events.jsonl"),
      JSON.stringify({ t: new Date().toISOString(), event: "PostToolUse", sessionId: "sess-pr", transcriptPath: null, cwd: process.cwd() }) + "\n",
    );
    writeFileSync(join(root, "shot.png"), Buffer.from("bytes"));

    await runCli([
      "node", "outerlayer", "emit", "artifact", join(root, "shot.png"),
      "--caption", "x", "--pr", "42",
    ]);

    expect(process.exitCode).toBe(0);
    const record = JSON.parse(readFileSync(artifactsSpoolPath(home), "utf8").trim()) as Record<string, unknown>;
    expect(record.prNumber).toBe(42);
  });

  it("plain `emit` still runs the flat compile action — the subcommand does not hijack the parent", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "emit", "--dir", root]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("no .outerlayer/config.json");
    expect(out).not.toHaveBeenCalled();
  });
});
