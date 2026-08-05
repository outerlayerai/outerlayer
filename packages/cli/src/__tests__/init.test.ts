// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, ensureGitignore } from "../init.js";
import { SettingsParseError } from "../settings.js";

let home: string;
let cwd: string;
// A bare name (no path separator) so `cliBinResolvable` trusts it via PATH
// instead of requiring it to exist on disk — the unresolved-bin behavior
// gets its own dedicated tests further down, with a deliberately broken path.
const BIN = "outerlayer-test-bin";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ol-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function userSettings(): string {
  return join(home, ".claude", "settings.json");
}

describe("runInit", () => {
  it("creates settings.json with hooks on a fresh machine", () => {
    const result = runInit({ scope: "user", cliBin: BIN, home });
    expect(result.changed).toBe(true);
    expect(existsSync(userSettings())).toBe(true);
    const settings = JSON.parse(readFileSync(userSettings(), "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "SessionEnd", "Stop"]);
  });

  it("init twice = no diff (idempotent), no spurious backup", () => {
    runInit({ scope: "user", cliBin: BIN, home });
    const afterFirst = readFileSync(userSettings(), "utf8");
    const second = runInit({ scope: "user", cliBin: BIN, home });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(userSettings(), "utf8")).toBe(afterFirst);
  });

  it("backs up the prior settings before modifying", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(userSettings(), JSON.stringify({ model: "x" }));
    let n = 0;
    const result = runInit({ scope: "user", cliBin: BIN, home });
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(JSON.parse(readFileSync(result.backupPath!, "utf8"))).toEqual({ model: "x" });
    void n;
  });

  it("--remove restores byte-identical settings (modulo backup)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = JSON.stringify({ model: "x", permissions: { allow: ["Bash"] } }, null, 2) + "\n";
    writeFileSync(userSettings(), original);
    runInit({ scope: "user", cliBin: BIN, home });
    const removed = runInit({ scope: "user", cliBin: BIN, home, remove: true });
    expect(removed.changed).toBe(true);
    expect(readFileSync(userSettings(), "utf8")).toBe(original);
  });

  it("refuses to write over a corrupt settings.json (throws, no modification)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const corrupt = "{ this is not json ";
    writeFileSync(userSettings(), corrupt);
    expect(() => runInit({ scope: "user", cliBin: BIN, home })).toThrow(SettingsParseError);
    expect(readFileSync(userSettings(), "utf8")).toBe(corrupt); // untouched
    // and no backup litter
    expect(readdirSync(join(home, ".claude")).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("project scope writes ./.claude and can update .gitignore", () => {
    const result = runInit({ scope: "project", cliBin: BIN, home, cwd, addGitignore: true });
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(true);
    expect(result.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(".outerlayer/");
  });
});

describe("runInit — auto-wrap at install time", () => {
  function seedWithHooks(): void {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      userSettings(),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/guard/check" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "/format/on-write" }] }],
          // A user's OWN Stop hook, not ours — must stay untouched: Stop is
          // already fully timed by the transcript, so wrapping it buys
          // nothing for the cost of a spawn on every turn.
          Stop: [{ hooks: [{ type: "command", command: "/notify/done" }] }],
        },
      }),
    );
  }

  it("auto-wraps PreToolUse and PostToolUse with no prompt; Stop is left exactly as the user wrote it", () => {
    seedWithHooks();
    const result = runInit({ scope: "user", cliBin: BIN, home });
    expect(result.wrapped.map((w) => w.event).sort()).toEqual(["PostToolUse", "PreToolUse"]);
    const settings = JSON.parse(readFileSync(userSettings(), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`${BIN} hook-wrap --id ${Buffer.from("/guard/check").toString("base64")}`);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(`${BIN} hook-wrap --id ${Buffer.from("/format/on-write").toString("base64")}`);
    // Stop's foreign hook is byte-for-byte what the user wrote — no wrapping,
    // no marker, nothing.
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "/notify/done" });
  });

  it("second init does not double-wrap — settings are byte-identical to after the first run", () => {
    seedWithHooks();
    runInit({ scope: "user", cliBin: BIN, home });
    const afterFirst = readFileSync(userSettings(), "utf8");
    const second = runInit({ scope: "user", cliBin: BIN, home });
    expect(second.changed).toBe(false);
    expect(second.wrapped).toEqual([]);
    expect(readFileSync(userSettings(), "utf8")).toBe(afterFirst);
  });

  it("--no-wrap-hooks (wrapHooks: false) installs lifecycle hooks but leaves PreToolUse/PostToolUse unwrapped", () => {
    seedWithHooks();
    const result = runInit({ scope: "user", cliBin: BIN, home, wrapHooks: false });
    expect(result.wrapped).toEqual([]);
    const settings = JSON.parse(readFileSync(userSettings(), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("/guard/check");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("/format/on-write");
    // Lifecycle hooks still installed — only wrapping was skipped.
    expect(Object.keys(settings.hooks)).toContain("SessionStart");
  });

  it("an unresolved cliBin blocks the ENTIRE write, not just wrapping — existing settings stay byte-identical", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/guard/check" }] }] } }, null, 2) + "\n";
    writeFileSync(userSettings(), original);
    const brokenBin = join(home, "does-not-exist", "outerlayer");
    const result = runInit({ scope: "user", cliBin: brokenBin, home });
    expect(result.cliBinUnresolved).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.wrapped).toEqual([]);
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(userSettings(), "utf8")).toBe(original); // untouched
    // no backup litter either
    expect(readdirSync(join(home, ".claude")).filter((f) => f.includes(".bak-"))).toEqual([]);
  });
});

describe("ensureGitignore", () => {
  it("adds the entry once, is idempotent, and preserves existing content", () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
    expect(ensureGitignore(cwd)).toBe(true);
    const contents = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(contents).toBe("node_modules\n.outerlayer/\n");
    expect(ensureGitignore(cwd)).toBe(false); // already there
  });

  it("handles a missing trailing newline", () => {
    writeFileSync(join(cwd, ".gitignore"), "dist");
    ensureGitignore(cwd);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("dist\n.outerlayer/\n");
  });
});
