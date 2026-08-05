// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeHooks,
  removeHooks,
  REGISTERED_EVENTS,
  isOurHookCommand,
  wrapHooks,
  unwrapHooks,
  listHookCandidates,
  encodeWrappedCommand,
  decodeWrappedCommand,
  isWrapped,
  cliBinResolvable,
  AUTO_WRAP_EVENTS,
  type ClaudeSettings,
} from "../settings.js";

// A bare name (no path separator) so `cliBinResolvable` trusts it via PATH
// instead of requiring it to exist on disk — the unresolved-bin guard gets
// its own dedicated tests, with a deliberately broken path.
const BIN = "outerlayer-test-bin";

describe("mergeHooks", () => {
  it("installs all three lifecycle events with the marker", () => {
    const { next, changed } = mergeHooks(null, BIN);
    expect(changed).toBe(true);
    for (const event of REGISTERED_EVENTS) {
      const block = next.hooks![event]![0]!;
      expect(block.hooks[0]!.command).toBe(`${BIN} hook ${event}`);
      expect(isOurHookCommand(block.hooks[0]!)).toBe(true);
    }
  });

  it("is idempotent — a second merge reports no change", () => {
    const first = mergeHooks(null, BIN).next;
    const { changed } = mergeHooks(first, BIN);
    expect(changed).toBe(false);
  });

  it("preserves unrelated settings keys and foreign hooks byte-for-byte", () => {
    const existing = {
      model: "claude-opus-4-8",
      permissions: { allow: ["Bash"] },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command" as const, command: "/other/tool start" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "/other/guard" }] }],
      },
    };
    const { next } = mergeHooks(existing, BIN);
    // untouched keys
    expect(next.model).toBe("claude-opus-4-8");
    expect(next.permissions).toEqual({ allow: ["Bash"] });
    // foreign PreToolUse hook fully preserved (we don't register it)
    expect(next.hooks!.PreToolUse).toEqual(existing.hooks.PreToolUse);
    // foreign SessionStart hook preserved AND our entry appended
    expect(next.hooks!.SessionStart).toHaveLength(2);
    expect(next.hooks!.SessionStart![0]!.hooks[0]!.command).toBe("/other/tool start");
    expect(next.hooks!.SessionStart![1]!.hooks[0]!.command).toBe(`${BIN} hook SessionStart`);
  });

  it("re-init after a bin path change updates our entry without duplicating", () => {
    const first = mergeHooks(null, "/old/outerlayer").next;
    const { next, changed } = mergeHooks(first, "/new/outerlayer");
    expect(changed).toBe(true);
    expect(next.hooks!.SessionStart).toHaveLength(1);
    expect(next.hooks!.SessionStart![0]!.hooks[0]!.command).toBe("/new/outerlayer hook SessionStart");
  });
});

describe("removeHooks", () => {
  it("removes only our entries, preserving foreign hooks", () => {
    const withForeign = mergeHooks(
      { hooks: { SessionStart: [{ hooks: [{ type: "command" as const, command: "/other start" }] }] } },
      BIN,
    ).next;
    const { next, changed } = removeHooks(withForeign);
    expect(changed).toBe(true);
    // foreign survives, ours gone, event key retained (still has foreign)
    expect(next.hooks!.SessionStart).toEqual([{ hooks: [{ type: "command", command: "/other start" }] }]);
    // events where we were the only hook are deleted entirely
    expect(next.hooks!.SessionEnd).toBeUndefined();
    expect(next.hooks!.Stop).toBeUndefined();
  });

  it("round-trip: install then remove restores the original object", () => {
    const original = { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "/g" }] }] } };
    const installed = mergeHooks(original, BIN).next;
    const { next } = removeHooks(installed);
    expect(next).toEqual(original);
  });

  it("no-op remove on settings without our hooks", () => {
    const { changed } = removeHooks({ model: "x" });
    expect(changed).toBe(false);
  });
});

describe("wrapHooks / unwrapHooks", () => {
  const withCandidates: ClaudeSettings = {
    model: "claude-opus-4-8",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/guard/check" }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "/format/on-write" }] }],
    },
  };

  it("round-trip: wrap then unwrap returns a byte-identical hooks object", () => {
    const wrapped = wrapHooks(withCandidates, BIN).next;
    const restored = unwrapHooks(wrapped).next;
    expect(restored).toEqual(withCandidates);
  });

  it("rewrites the command to run through hook-wrap with a base64 id", () => {
    const { next } = wrapHooks(withCandidates, BIN);
    const command = next.hooks!.PreToolUse![0]!.hooks[0]!.command;
    expect(command).toBe(`${BIN} hook-wrap --id ${encodeWrappedCommand("/guard/check")}`);
  });

  it("second wrap is a no-op — already-wrapped commands are left alone", () => {
    const first = wrapHooks(withCandidates, BIN);
    expect(first.wrapped).toHaveLength(2);
    const second = wrapHooks(first.next, BIN);
    expect(second.changed).toBe(false);
    expect(second.wrapped).toEqual([]);
  });

  it("never wraps our own lifecycle hooks — they stay untouched", () => {
    const withOurs = mergeHooks(withCandidates, BIN).next;
    const { next } = wrapHooks(withOurs, BIN);
    // our own SessionStart/SessionEnd/Stop entries are unchanged
    for (const event of REGISTERED_EVENTS) {
      expect(next.hooks![event]).toEqual(withOurs.hooks![event]);
    }
    // the foreign PreToolUse/PostToolUse candidates were still wrapped
    expect(isWrapped(next.hooks!.PreToolUse![0]!.hooks[0]!)).toBe(true);
  });

  it("--event scoping only wraps the requested event, leaving the other untouched", () => {
    const { next, wrapped } = wrapHooks(withCandidates, BIN, { events: ["PreToolUse"] });
    expect(wrapped).toHaveLength(1);
    expect(isWrapped(next.hooks!.PreToolUse![0]!.hooks[0]!)).toBe(true);
    expect(next.hooks!.PostToolUse).toEqual(withCandidates.hooks!.PostToolUse);
  });

  it("unwrap on unwrapped settings is a no-op", () => {
    const { changed, unwrapped } = unwrapHooks(withCandidates);
    expect(changed).toBe(false);
    expect(unwrapped).toBe(0);
  });

  it("listHookCandidates reports the original command and wrapped status", () => {
    expect(listHookCandidates(withCandidates)).toEqual([
      { event: "PreToolUse", matcherIndex: 0, hookIndex: 0, matcher: "Bash", command: "/guard/check", wrapped: false },
      { event: "PostToolUse", matcherIndex: 0, hookIndex: 0, matcher: undefined, command: "/format/on-write", wrapped: false },
    ]);
    const { next } = wrapHooks(withCandidates, BIN, { events: ["PreToolUse"] });
    const candidates = listHookCandidates(next);
    expect(candidates.find((c) => c.event === "PreToolUse")).toEqual({
      event: "PreToolUse",
      matcherIndex: 0,
      hookIndex: 0,
      matcher: "Bash",
      command: "/guard/check", // original, not the rewritten hook-wrap command
      wrapped: true,
    });
  });

  it("excludes our own lifecycle hooks from candidates", () => {
    const withOurs = mergeHooks(withCandidates, BIN).next;
    const events = listHookCandidates(withOurs).map((c) => c.event);
    for (const event of REGISTERED_EVENTS) expect(events).not.toContain(event);
  });

  it("refuses to wrap anything when cliBin doesn't resolve — writes nothing, flags it", () => {
    const brokenBin = "/definitely/does/not/exist/outerlayer";
    const { next, changed, wrapped, skippedUnresolvedBin } = wrapHooks(withCandidates, brokenBin);
    expect(skippedUnresolvedBin).toBe(true);
    expect(changed).toBe(false);
    expect(wrapped).toEqual([]);
    // Settings come back untouched — a structural clone, not a mutation, but
    // byte-identical content.
    expect(next).toEqual(withCandidates);
  });

  it("AUTO_WRAP_EVENTS is exactly PreToolUse and PostToolUse — Stop is already fully timed by the transcript", () => {
    expect(AUTO_WRAP_EVENTS).toEqual(["PreToolUse", "PostToolUse"]);
  });
});

describe("cliBinResolvable", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ol-clibin-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("trusts a bare command name (no path separator) without checking disk", () => {
    expect(cliBinResolvable("outerlayer")).toBe(true);
  });

  it("accepts a path that actually exists on disk", () => {
    const real = join(tmpDir, "outerlayer");
    writeFileSync(real, "#!/bin/sh\n");
    expect(cliBinResolvable(real)).toBe(true);
  });

  it("rejects a path-like string that does not exist — the exact install-path-misfire bug", () => {
    expect(cliBinResolvable(join(tmpDir, "does-not-exist"))).toBe(false);
  });
});

describe("encodeWrappedCommand / decodeWrappedCommand", () => {
  it("round-trips a command containing single quotes, $, and newlines", () => {
    const tricky = "echo 'it'\\''s $HOME'\nprintf '%s\\n' done";
    expect(decodeWrappedCommand(encodeWrappedCommand(tricky))).toBe(tricky);
  });
});
