// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHookFast, spoolDir } from "../hook-fast.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-hook-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const spool = () => join(spoolDir(home), "events.jsonl");

describe("runHookFast", () => {
  it("appends a bounded spool record from the hook payload", () => {
    const payload = JSON.stringify({
      session_id: "abc-123",
      transcript_path: "/Users/x/.claude/projects/-p/abc-123.jsonl",
      cwd: "/Users/x/proj",
      hook_event_name: "SessionEnd",
    });
    runHookFast("SessionEnd", home, () => payload);

    expect(existsSync(spool())).toBe(true);
    const record = JSON.parse(readFileSync(spool(), "utf8").trim());
    expect(record).toMatchObject({
      event: "SessionEnd",
      sessionId: "abc-123",
      transcriptPath: "/Users/x/.claude/projects/-p/abc-123.jsonl",
      cwd: "/Users/x/proj",
    });
    expect(typeof record.t).toBe("string");
    // bounded: only the whitelisted fields land in the spool
    expect(Object.keys(record).sort()).toEqual(["cwd", "event", "sessionId", "t", "transcriptPath"]);
  });

  it("falls back to the payload's hook_event_name when no event arg is passed", () => {
    runHookFast(undefined, home, () => JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    expect(JSON.parse(readFileSync(spool(), "utf8").trim()).event).toBe("Stop");
  });

  it("never throws on malformed stdin — degrades to nulls, still writes a record", () => {
    expect(() => runHookFast("Stop", home, () => "{ not json")).not.toThrow();
    const record = JSON.parse(readFileSync(spool(), "utf8").trim());
    expect(record.event).toBe("Stop");
    expect(record.sessionId).toBeNull();
  });

  it("never throws on empty stdin", () => {
    expect(() => runHookFast("SessionStart", home, () => "")).not.toThrow();
    expect(JSON.parse(readFileSync(spool(), "utf8").trim()).event).toBe("SessionStart");
  });

  it("appends across invocations (one line each, in order)", () => {
    runHookFast("SessionStart", home, () => JSON.stringify({ session_id: "s1" }));
    runHookFast("SessionEnd", home, () => JSON.stringify({ session_id: "s2" }));
    const lines = readFileSync(spool(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).sessionId).toBe("s1");
    expect(JSON.parse(lines[1]!).sessionId).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// hook-triggered background sync
// ---------------------------------------------------------------------------

import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, statSync as statSync2, utimesSync as utimesSync2 } from "node:fs";
import { maybeAutoSync, AUTO_SYNC_DEBOUNCE_MS } from "../hook-fast.js";

function seedCloudConfig(extra: Record<string, unknown> = {}): void {
  mkdirSync2(join(home, ".outerlayer"), { recursive: true });
  writeFileSync2(
    join(home, ".outerlayer", "config.json"),
    JSON.stringify({ url: "https://gw.test", apiKey: "sk_x", appId: "app-1", ...extra }),
  );
}

describe("maybeAutoSync", () => {
  const NOW = 1_784_000_000_000;

  it("spawns a detached quiet sync on SessionEnd when config is present", () => {
    seedCloudConfig();
    mkdirSync2(spoolDir(home), { recursive: true });
    const calls: Array<[string, string[]]> = [];
    maybeAutoSync("SessionEnd", home, (c, a) => calls.push([c, a]), NOW);
    expect(calls).toEqual([[process.execPath, [process.argv[1]!, "sync", "--quiet"]]]);
    // Marker written so the debounce window starts.
    expect(statSync2(join(spoolDir(home), "last-auto-sync")).isFile()).toBe(true);
  });

  it("debounces: a fresh marker means NO spawn", () => {
    seedCloudConfig();
    mkdirSync2(spoolDir(home), { recursive: true });
    const marker = join(spoolDir(home), "last-auto-sync");
    writeFileSync2(marker, "x");
    const fresh = new Date(NOW - AUTO_SYNC_DEBOUNCE_MS + 60_000);
    utimesSync2(marker, fresh, fresh);
    const calls: unknown[] = [];
    maybeAutoSync("Stop", home, (...a) => calls.push(a), NOW);
    expect(calls).toEqual([]);
  });

  it("spawns again once the debounce window has passed", () => {
    seedCloudConfig();
    mkdirSync2(spoolDir(home), { recursive: true });
    const marker = join(spoolDir(home), "last-auto-sync");
    writeFileSync2(marker, "x");
    const stale = new Date(NOW - AUTO_SYNC_DEBOUNCE_MS - 60_000);
    utimesSync2(marker, stale, stale);
    const calls: unknown[] = [];
    maybeAutoSync("Stop", home, (...a) => calls.push(a), NOW);
    expect(calls).toHaveLength(1);
  });

  it("does nothing without cloud config, on autoSync:false, or for other events", () => {
    const calls: unknown[] = [];
    mkdirSync2(spoolDir(home), { recursive: true });
    maybeAutoSync("SessionEnd", home, (...a) => calls.push(a), NOW); // no config
    seedCloudConfig({ autoSync: false });
    maybeAutoSync("SessionEnd", home, (...a) => calls.push(a), NOW); // opted out
    seedCloudConfig();
    maybeAutoSync("SessionStart", home, (...a) => calls.push(a), NOW); // wrong event
    seedCloudConfig({ appId: undefined });
    maybeAutoSync("SessionEnd", home, (...a) => calls.push(a), NOW); // incomplete config
    expect(calls).toEqual([]);
  });
});

import { reportSyncHealth } from "../hook-fast.js";
import { writeSyncStatus } from "../sync-status.js";

/** Captures whatever the hook would write to stdout. */
function captureReport(event: string): string {
  let out = "";
  reportSyncHealth(event, home, (s) => {
    out += s;
  });
  return out;
}

describe("reportSyncHealth", () => {
  it("surfaces a failing sync at SessionStart as additionalContext", () => {
    seedCloudConfig();
    writeSyncStatus(
      {
        at: new Date().toISOString(),
        ok: false,
        url: "http://localhost:9105",
        error: { message: "connection refused" },
      },
      home,
    );

    const parsed = JSON.parse(captureReport("SessionStart"));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context: string = parsed.hookSpecificOutput.additionalContext;
    // The three facts that make it actionable: that it is failing, where, and why.
    expect(context).toContain("OuterLayer sync is failing on this machine");
    expect(context).toContain("localhost:9105");
    expect(context).toContain("connection refused");
  });

  it("stays silent on a healthy sync", () => {
    seedCloudConfig();
    writeSyncStatus({ at: new Date().toISOString(), ok: true, url: "https://a.co" }, home);

    expect(captureReport("SessionStart")).toBe("");
  });

  it("stays silent on a merely STALE sync — a quiet day must not cry wolf", () => {
    seedCloudConfig();
    writeSyncStatus(
      { at: new Date(Date.now() - 30 * 3_600_000).toISOString(), ok: true, url: "https://a.co" },
      home,
    );

    expect(captureReport("SessionStart")).toBe("");
  });

  it("stays silent when the user never configured cloud sync", () => {
    // No seedCloudConfig: nothing was opted into, so nothing is broken.
    writeSyncStatus({ at: new Date().toISOString(), ok: false, error: { message: "x" } }, home);

    expect(captureReport("SessionStart")).toBe("");
  });

  it("reports only at SessionStart, never mid-session", () => {
    seedCloudConfig();
    writeSyncStatus({ at: new Date().toISOString(), ok: false, error: { message: "x" } }, home);

    expect([captureReport("Stop"), captureReport("SessionEnd")]).toEqual(["", ""]);
  });
});
