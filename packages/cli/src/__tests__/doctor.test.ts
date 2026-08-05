// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, doctorExitCode, type Check } from "../doctor.js";
import { runInit } from "../init.js";

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
