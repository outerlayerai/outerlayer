// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, doctorExitCode, type Check } from "../doctor.js";
import { runInit } from "../init.js";
import { statuslineStatePath, STATE_FRESH_MS } from "../statusline-fast.js";
import { mergeStatusline, MARKER } from "../settings.js";

let home: string;
// A bare name (no path separator) so `cliBinResolvable` trusts it via PATH
// instead of requiring it to exist on disk — these tests don't exercise
// that check, they just need SOME valid-looking cliBin.
const BIN = "outerlayer-test-bin";
// Every case must stub the version probe — without it runDoctor spawns the
// real `claude --version`, which times tests out under parallel suite load.
const STUBBED = { claudeVersion: () => "2.1.193" };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-doc-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function byName(checks: Check[], name: string): Check {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
}
function claudeDir(): string {
  const d = join(home, ".claude", "projects", "-Users-x-acme");
  mkdirSync(d, { recursive: true });
  return d;
}

describe("runDoctor — the 8 failure modes each detected", () => {
  it("no ~/.claude → fail with install guidance", () => {
    const checks = runDoctor({ home, claudeVersion: () => "2.1.193", claudeInstalls: () => [] });
    const c = byName(checks, "Claude Code home");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/Install Claude Code/);
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("no transcripts → warn", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const c = byName(runDoctor({ home, claudeVersion: () => "2.1.193" }), "Transcripts");
    expect(c.status).toBe("warn");
  });

  it("transcripts present → pass with count + freshness", () => {
    writeFileSync(join(claudeDir(), "s1.jsonl"), '{"type":"assistant"}\n');
    const c = byName(runDoctor({ home, claudeVersion: () => "2.1.193", now: () => Date.now() }), "Transcripts");
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/1 transcripts/);
  });

  it("hooks not installed → fail; installed → pass", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(byName(runDoctor({ home, ...STUBBED }), "Hooks installed").status).toBe("fail");
    runInit({ scope: "user", cliBin: BIN, home });
    expect(byName(runDoctor({ home, ...STUBBED }), "Hooks installed").status).toBe("pass");
  });

  it("cleanupPeriodDays=0 → FAIL citing the upstream bug", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 0 }));
    const c = byName(runDoctor({ home, ...STUBBED }), "Retention (cleanupPeriodDays)");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/DISABLES/);
  });

  it("cleanupPeriodDays<14 → warn; ≥14 → pass", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
    expect(byName(runDoctor({ home, ...STUBBED }), "Retention (cleanupPeriodDays)").status).toBe("warn");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    expect(byName(runDoctor({ home, ...STUBBED }), "Retention (cleanupPeriodDays)").status).toBe("pass");
  });

  it("corrupt settings.json → fail (settings validity check)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json ");
    const c = byName(runDoctor({ home, ...STUBBED }), "Settings JSON valid");
    expect(c.status).toBe("fail");
  });

  it("newer-than-supported Claude version → warn (best-effort parse)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const c = byName(runDoctor({ home, claudeVersion: () => "claude 9.9.9" }), "Claude Code version");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/newer than validated/);
  });

  it("multiple Claude installs → warn", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const checks = runDoctor({ home, claudeVersion: () => "2.1.193", claudeInstalls: () => ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"] });
    const c = byName(checks, "Claude Code installs");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/multiple/);
  });

  it("neither install path present → Install path fails", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/no install path/);
  });

  it("only the plugin's managed CLI install present → Install path passes as plugin", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".outerlayer", "cli", "node_modules", "outerlayer"), { recursive: true });
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("pass");
    expect(c.detail).toBe("Claude Code plugin");
  });

  it("settings hooks present for only ONE lifecycle event still counts as an install path (any event is enough)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    const settingsFile = join(home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as { hooks: Record<string, unknown> };
    // Drop every registered event's hooks except one, so only a partial
    // install remains — this must still be detected as "settings hooks
    // present", not require every lifecycle event to be installed.
    for (const event of Object.keys(settings.hooks)) {
      if (event !== "SessionStart") delete settings.hooks[event];
    }
    writeFileSync(settingsFile, JSON.stringify(settings));
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("pass");
    expect(c.detail).toBe("settings hooks (outerlayer init)");
  });

  it("detects our hook even when it shares a binding array with an unrelated foreign hook", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "/foreign/first" }, { type: "command", command: "ours", [MARKER]: true }] },
          ],
        },
      }),
    );
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("pass");
    expect(c.detail).toBe("settings hooks (outerlayer init)");
  });

  it("a hook binding with a foreign command alongside a mixed non-matching entry is not mistaken for our hook", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/some/foreign/hook" }] }],
        },
      }),
    );
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/no install path/);
  });

  it("only settings hooks present (outerlayer init) → Install path passes as settings", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("pass");
    expect(c.detail).toBe("settings hooks (outerlayer init)");
  });

  it("both the plugin and settings hooks present → Install path warns as redundant", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".outerlayer", "cli", "node_modules", "outerlayer"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    const c = byName(runDoctor({ home, ...STUBBED }), "Install path");
    expect(c.status).toBe("warn");
    expect(c.fix).toMatch(/outerlayer init --remove/);
  });

  it("statusline not installed → warn naming `outerlayer init`", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const c = byName(runDoctor({ home, ...STUBBED }), "Status line");
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("not installed");
    expect(c.fix).toMatch(/outerlayer init/);
  });

  it("statusline occupied by a foreign command → warn naming that command", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "my-status.sh --flag" } }),
    );
    const c = byName(runDoctor({ home, ...STUBBED }), "Status line");
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("slot occupied by: my-status.sh --flag");
    expect(c.fix).toMatch(/outerlayer init/);
  });

  it("a statusLine slot explicitly set to JSON null does not crash the check — reads as not installed", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: null }));
    const c = byName(runDoctor({ home, ...STUBBED }), "Status line");
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("not installed");
  });

  it("a foreign slot whose `command` is a non-string is never reported as 'occupied by' — reads as not installed", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: 42 } }));
    const c = byName(runDoctor({ home, ...STUBBED }), "Status line");
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("not installed");
  });

  it("installed AND wrapping a foreign command → pass with the wrapped command named in the detail", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const wrapped = mergeStatusline({ statusLine: { type: "command", command: "my-status.sh --flag" } }, "outerlayer-test-bin").next;
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(wrapped));
    const c = byName(runDoctor({ home, ...STUBBED }), "Status line");
    expect(c.status).toBe("pass");
    expect(c.detail).toBe("installed, wrapping: my-status.sh --flag");
  });

  it("installed with a non-string wrap marker still passes, but without a wrapping detail", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "outerlayer-test-bin statusline", _outerlayer: true, _outerlayerWrapped: 12345 } }),
    );
    const c = byName(runDoctor({ home, ...STUBBED }), "Status line");
    expect(c.status).toBe("pass");
    expect(c.detail).toBe("installed");
  });

  it("statusline installed (plain) → pass; no state file yet → Status-line state warns", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    const checks = runDoctor({ home, ...STUBBED });
    expect(byName(checks, "Status line").status).toBe("pass");
    const stateCheck = byName(checks, "Status-line state");
    expect(stateCheck.status).toBe("warn");
    expect(stateCheck.detail).toMatch(/no state file/);
  });

  it("statusline installed + fresh state file → both checks pass", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    const now = () => Date.now();
    writeFileSync(
      statuslineStatePath(home),
      JSON.stringify({ v: 1, generatedAt: new Date(now()).toISOString(), today: { date: "2026-08-11", byAgent: {}, sessionCount: 0 }, sessions: {} }),
    );
    const checks = runDoctor({ home, ...STUBBED, now });
    expect(byName(checks, "Status line").status).toBe("pass");
    expect(byName(checks, "Status-line state").status).toBe("pass");
  });

  it("state age exactly at STATE_FRESH_MS is still fresh — the boundary is inclusive", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    const now = Date.now();
    writeFileSync(
      statuslineStatePath(home),
      JSON.stringify({
        v: 1,
        generatedAt: new Date(now - STATE_FRESH_MS).toISOString(),
        today: { date: "2026-08-11", byAgent: {}, sessionCount: 0 },
        sessions: {},
      }),
    );
    const c = byName(runDoctor({ home, ...STUBBED, now: () => now }), "Status-line state");
    expect(c.status).toBe("pass");
  });

  it("statusline installed + stale generatedAt → Status-line state warns 'degraded'", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    runInit({ scope: "user", cliBin: BIN, home });
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    const now = Date.now();
    writeFileSync(
      statuslineStatePath(home),
      JSON.stringify({
        v: 1,
        generatedAt: new Date(now - 20 * 60 * 1000).toISOString(), // older than STATE_FRESH_MS (15m)
        today: { date: "2026-08-11", byAgent: {}, sessionCount: 0 },
        sessions: {},
      }),
    );
    const c = byName(runDoctor({ home, ...STUBBED, now: () => now }), "Status-line state");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/degraded/);
  });

  it("a fully healthy setup exits 0", () => {
    writeFileSync(join(claudeDir(), "s1.jsonl"), '{"type":"assistant"}\n');
    runInit({ scope: "user", cliBin: BIN, home });
    const settingsFile = join(home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    settings.cleanupPeriodDays = 30; // keep the installed hooks, add retention
    writeFileSync(settingsFile, JSON.stringify(settings));
    const checks = runDoctor({ home, claudeVersion: () => "2.1.193", claudeInstalls: () => ["/usr/local/bin/claude"] });
    expect(doctorExitCode(checks)).toBe(0);
  });
});
