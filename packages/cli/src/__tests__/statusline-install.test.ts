// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeStatusline, removeStatusline, statuslineCommand, encodeWrappedCommand, SettingsParseError, type ClaudeSettings } from "../settings.js";
import { runInit } from "../init.js";

// A bare name (no path separator) so `cliBinResolvable` trusts it via PATH
// instead of requiring it to exist on disk — the unresolved-bin behavior is
// exercised elsewhere (init.test.ts), not here.
const BIN = "outerlayer-test-bin";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-statusline-install-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function userSettings(): string {
  return join(home, ".claude", "settings.json");
}

describe("mergeStatusline — empty slot", () => {
  it("installs our command with the marker, nothing else", () => {
    const { next, changed, outcome } = mergeStatusline(null, BIN);
    expect(changed).toBe(true);
    expect(outcome).toBe("installed");
    expect(next.statusLine).toEqual({ type: "command", command: statuslineCommand(BIN), _outerlayer: true });
  });

  it("statuslineCommand builds '<bin> statusline' verbatim", () => {
    expect(statuslineCommand(BIN)).toBe(`${BIN} statusline`);
  });

  it("re-run is unchanged and produces a byte-identical settings object, with no wrappedCommand key at all", () => {
    const first = mergeStatusline(null, BIN).next;
    const second = mergeStatusline(first, BIN);
    expect(second.changed).toBe(false);
    expect(second.outcome).toBe("unchanged");
    expect(second.next).toEqual(first);
    expect("wrappedCommand" in second).toBe(false);
  });

  it("a statusLine slot explicitly set to JSON null is treated the same as an absent slot — installs fresh", () => {
    const settings = { statusLine: null } as unknown as ClaudeSettings;
    const { next, changed, outcome } = mergeStatusline(settings, BIN);
    expect(changed).toBe(true);
    expect(outcome).toBe("installed");
    expect(next.statusLine).toEqual({ type: "command", command: statuslineCommand(BIN), _outerlayer: true });
  });

  it("runInit writes an exact settings object with the statusLine slot installed", () => {
    runInit({ scope: "user", cliBin: BIN, home });
    const settings = JSON.parse(readFileSync(userSettings(), "utf8")) as ClaudeSettings;
    expect(settings.statusLine).toEqual({ type: "command", command: `${BIN} statusline`, _outerlayer: true });
  });

  it("runInit twice writes a byte-identical file (no second backup)", () => {
    runInit({ scope: "user", cliBin: BIN, home });
    const afterFirst = readFileSync(userSettings(), "utf8");
    const second = runInit({ scope: "user", cliBin: BIN, home });
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(userSettings(), "utf8")).toBe(afterFirst);
  });
});

describe("mergeStatusline — foreign slot", () => {
  const foreign: ClaudeSettings = {
    statusLine: { type: "command", command: "my-status.sh --flag", padding: 0, someUnknownKey: "kept" },
  };

  it("wraps it: command runs through --wrap-id, original preserved verbatim, padding/unknown keys kept", () => {
    const { next, changed, outcome, wrappedCommand } = mergeStatusline(foreign, BIN);
    expect(changed).toBe(true);
    expect(outcome).toBe("wrapped");
    expect(wrappedCommand).toBe("my-status.sh --flag");
    expect(next.statusLine).toEqual({
      type: "command",
      command: `${BIN} statusline --wrap-id ${encodeWrappedCommand("my-status.sh --flag")}`,
      padding: 0,
      someUnknownKey: "kept",
      _outerlayer: true,
      _outerlayerWrapped: "my-status.sh --flag",
    });
  });

  it("never double-wraps — merging the already-wrapped slot again is unchanged and still reports the original command", () => {
    const wrapped = mergeStatusline(foreign, BIN).next;
    const second = mergeStatusline(wrapped, BIN);
    expect(second.changed).toBe(false);
    expect(second.outcome).toBe("unchanged");
    expect(second.next).toEqual(wrapped);
    expect(second.wrappedCommand).toBe("my-status.sh --flag");
  });

  it("runInit on an occupied slot wraps it and reports the preserved command", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(userSettings(), JSON.stringify(foreign, null, 2) + "\n");
    const result = runInit({ scope: "user", cliBin: BIN, home });
    expect(result.statusline).toBe("wrapped");
    expect(result.statuslineWrappedCommand).toBe("my-status.sh --flag");
  });
});

describe("removeStatusline", () => {
  it("restores the exact original command on a wrapped slot, dropping both markers", () => {
    const wrapped = mergeStatusline({ statusLine: { type: "command", command: "my-status.sh --flag", padding: 0 } }, BIN).next;
    const { next, changed, restoredCommand } = removeStatusline(wrapped);
    expect(changed).toBe(true);
    expect(restoredCommand).toBe("my-status.sh --flag");
    expect(next.statusLine).toEqual({ type: "command", command: "my-status.sh --flag", padding: 0 });
  });

  it("deletes the statusLine key entirely on a plain (unwrapped) install", () => {
    const installed = mergeStatusline(null, BIN).next;
    const { next, changed, restoredCommand } = removeStatusline(installed);
    expect(changed).toBe(true);
    expect(restoredCommand).toBeUndefined();
    expect(next.statusLine).toBeUndefined();
    expect("statusLine" in next).toBe(false);
  });

  it("leaves a foreign (never-merged) slot completely untouched", () => {
    const foreign: ClaudeSettings = { statusLine: { type: "command", command: "someone-elses-script" } };
    const { next, changed } = removeStatusline(foreign);
    expect(changed).toBe(false);
    expect(next.statusLine).toEqual(foreign.statusLine);
  });

  it("is a safe no-op — not a throw — when there is no statusLine key at all", () => {
    const { next, changed } = removeStatusline({ model: "x" });
    expect(changed).toBe(false);
    expect(next).toEqual({ model: "x" });
  });

  it("is a safe no-op on a statusLine slot that is a non-object primitive (e.g. a stray number)", () => {
    const settings = { statusLine: 42 } as unknown as ClaudeSettings;
    const { next, changed } = removeStatusline(settings);
    expect(changed).toBe(false);
    expect(next.statusLine).toBe(42);
  });

  it("init then remove restores settings byte-identical to before init, when the slot started foreign, and reports the restored command", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = JSON.stringify({ statusLine: { type: "command", command: "my-status.sh --flag" } }, null, 2) + "\n";
    writeFileSync(userSettings(), original);
    runInit({ scope: "user", cliBin: BIN, home });
    const removeResult = runInit({ scope: "user", cliBin: BIN, home, remove: true });
    expect(readFileSync(userSettings(), "utf8")).toBe(original);
    expect(removeResult.statuslineWrappedCommand).toBe("my-status.sh --flag");
  });

  it("--remove on settings with nothing to remove at all (no hooks, no statusLine) reports changed:false and writes no backup", () => {
    const result = runInit({ scope: "user", cliBin: BIN, home, remove: true });
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
  });

  it("runInit --remove on our plain install deletes the key, reports no restored command, and reports removed:true / wrapped:[]", () => {
    runInit({ scope: "user", cliBin: BIN, home });
    const result = runInit({ scope: "user", cliBin: BIN, home, remove: true });
    expect(result.statuslineWrappedCommand).toBeUndefined();
    expect(result.removed).toBe(true);
    expect(result.wrapped).toEqual([]);
    const settings = JSON.parse(readFileSync(userSettings(), "utf8")) as ClaudeSettings;
    expect(settings.statusLine).toBeUndefined();
  });

  it("a statusline-only removal (an installed statusLine slot but no hooks at all) still reports changed and writes a backup", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const ourStatusline = mergeStatusline(null, BIN).next.statusLine;
    const original = { model: "x", statusLine: ourStatusline };
    writeFileSync(userSettings(), JSON.stringify(original, null, 2) + "\n");
    const result = runInit({ scope: "user", cliBin: BIN, home, remove: true });
    expect(result.changed).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.wrapped).toEqual([]);
    expect(result.backupPath).toMatch(new RegExp(`^${userSettings().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.bak-\\d+$`));
    expect(JSON.parse(readFileSync(result.backupPath!, "utf8"))).toEqual(original);
    const settings = JSON.parse(readFileSync(userSettings(), "utf8")) as ClaudeSettings;
    expect(settings).toEqual({ model: "x" });
  });
});

describe("runInit statusline: false", () => {
  it("leaves an empty slot untouched entirely", () => {
    const result = runInit({ scope: "user", cliBin: BIN, home, statusline: false });
    expect(result.statusline).toBeUndefined();
    const settings = JSON.parse(readFileSync(userSettings(), "utf8")) as ClaudeSettings;
    expect(settings.statusLine).toBeUndefined();
  });

  it("leaves a foreign slot exactly as written, even though init still installs hooks", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = { statusLine: { type: "command", command: "my-status.sh" } };
    writeFileSync(userSettings(), JSON.stringify(original, null, 2) + "\n");
    runInit({ scope: "user", cliBin: BIN, home, statusline: false });
    const settings = JSON.parse(readFileSync(userSettings(), "utf8")) as ClaudeSettings;
    expect(settings.statusLine).toEqual(original.statusLine);
  });
});

describe("corrupt settings", () => {
  it("refuses to touch the statusLine slot — throws SettingsParseError, file unmodified", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const corrupt = "{ not json ";
    writeFileSync(userSettings(), corrupt);
    expect(() => runInit({ scope: "user", cliBin: BIN, home })).toThrow(SettingsParseError);
    expect(readFileSync(userSettings(), "utf8")).toBe(corrupt);
  });
});

describe("unrecognized slot shape", () => {
  it("a string value (not a command object) is skipped, left byte-for-byte untouched", () => {
    const settings = { statusLine: "not-an-object" } as unknown as ClaudeSettings;
    const { next, changed, outcome } = mergeStatusline(settings, BIN);
    expect(changed).toBe(false);
    expect(outcome).toBe("skipped");
    expect(next.statusLine).toBe("not-an-object");
  });

  it("an object missing `command` is skipped, left byte-for-byte untouched", () => {
    const settings = { statusLine: { type: "command" } } as unknown as ClaudeSettings;
    const { next, changed, outcome } = mergeStatusline(settings, BIN);
    expect(changed).toBe(false);
    expect(outcome).toBe("skipped");
    expect(next.statusLine).toEqual({ type: "command" });
  });

  it("a valid string `command` but a non-'command' `type` is also skipped, left byte-for-byte untouched", () => {
    const settings = { statusLine: { type: "not-a-command-type", command: "some-command" } } as unknown as ClaudeSettings;
    const { next, changed, outcome } = mergeStatusline(settings, BIN);
    expect(changed).toBe(false);
    expect(outcome).toBe("skipped");
    expect(next.statusLine).toEqual({ type: "not-a-command-type", command: "some-command" });
  });

  it("runInit reports the skip and writes nothing else changed by it", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(userSettings(), JSON.stringify({ statusLine: "weird" }));
    const result = runInit({ scope: "user", cliBin: BIN, home });
    expect(result.statusline).toBe("skipped");
    const settings = JSON.parse(readFileSync(userSettings(), "utf8")) as ClaudeSettings;
    expect(settings.statusLine).toBe("weird");
  });
});

describe("mergeStatusline — repair after a bin path change", () => {
  it("plain install: repairs the command when cliBin moved, with no wrappedCommand key at all", () => {
    const installedOld = mergeStatusline(null, "/old/path/outerlayer").next;
    const result = mergeStatusline(installedOld, "/new/path/outerlayer");
    expect(result.changed).toBe(true);
    expect(result.outcome).toBe("repaired");
    expect(result.next.statusLine).toEqual({ type: "command", command: "/new/path/outerlayer statusline", _outerlayer: true });
    expect("wrappedCommand" in result).toBe(false);
  });

  it("wrapped install: repairs the command's bin prefix while preserving the wrap-id payload and original marker", () => {
    const wrappedOld = mergeStatusline({ statusLine: { type: "command", command: "my-status.sh" } }, "/old/path/outerlayer").next;
    const { next, changed, outcome, wrappedCommand } = mergeStatusline(wrappedOld, "/new/path/outerlayer");
    expect(changed).toBe(true);
    expect(outcome).toBe("repaired");
    expect(wrappedCommand).toBe("my-status.sh");
    expect(next.statusLine).toEqual({
      type: "command",
      command: `/new/path/outerlayer statusline --wrap-id ${encodeWrappedCommand("my-status.sh")}`,
      _outerlayer: true,
      _outerlayerWrapped: "my-status.sh",
    });
  });
});
