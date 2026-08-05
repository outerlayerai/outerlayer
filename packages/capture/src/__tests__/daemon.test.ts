// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDaemon, type DaemonLogEvent } from "../daemon.js";
import { scanAll } from "../scan.js";

let clientRoot: string;
let rawRoot: string;
let clock = 1_000_000;

function proj(name: string): string {
  const dir = join(clientRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function transcript(dir: string, id: string, lines: number): string {
  const body =
    Array.from({ length: lines }, (_, i) =>
      JSON.stringify({ sessionId: id, type: "assistant", version: "2.1.193", cwd: "/w", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: `t${i}` }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ).join("\n") + "\n";
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  clientRoot = mkdtempSync(join(tmpdir(), "ol-client-"));
  rawRoot = mkdtempSync(join(tmpdir(), "ol-raw-"));
});
afterEach(() => {
  rmSync(clientRoot, { recursive: true, force: true });
  rmSync(rawRoot, { recursive: true, force: true });
});

function daemon(overrides = {}): { d: CaptureDaemon; logs: DaemonLogEvent[] } {
  const logs: DaemonLogEvent[] = [];
  const d = new CaptureDaemon({
    root: clientRoot,
    rawRoot,
    now: () => ++clock,
    onLog: (e) => logs.push(e),
    ...overrides,
  });
  return { d, logs };
}

describe("CaptureDaemon.mirror (copy-out)", () => {
  it("mirrors a transcript into the raw tree preserving project structure", () => {
    const dir = proj("-Users-x-acme");
    const file = transcript(dir, "11111111-1111-4111-8111-111111111111", 3);
    const { d } = daemon();
    const bytes = d.mirror(file);
    expect(bytes).toBeGreaterThan(0);
    const dest = join(rawRoot, "-Users-x-acme", "11111111-1111-4111-8111-111111111111.jsonl");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(file, "utf8"));
  });

  // Real copy-out + delete + rescan on disk; overruns the 5s default under
  // a parallel full-gate run, so it carries its own budget.
  it("survives the deletion race: mirrored session is still scannable after the source is deleted", { timeout: 20_000 }, () => {
    const dir = proj("-Users-x-acme");
    const id = "22222222-2222-4222-8222-222222222222";
    const file = transcript(dir, id, 4);
    const { d } = daemon();
    d.mirror(file);

    // Claude Code's 30-day cleanup removes the source
    rmSync(file);

    // scanAll unions live + raw; the session persists from the raw mirror
    const { report, sessions } = scanAll({ root: clientRoot, rawRoot });
    expect(report.fromRawOnly).toBe(1);
    expect(sessions.find((s) => s.id === id)).toBeDefined();
  });

  it("is append-aware: re-mirroring an unchanged file is a no-op", () => {
    const dir = proj("-Users-x-acme");
    const file = transcript(dir, "33333333-3333-4333-8333-333333333333", 2);
    const { d } = daemon();
    expect(d.mirror(file)).toBeGreaterThan(0);
    expect(d.mirror(file)).toBeNull(); // unchanged → skipped
  });

  it("respects include/exclude project filters", () => {
    const keep = transcript(proj("-Users-x-keep"), "44444444-4444-4444-8444-444444444444", 1);
    const drop = transcript(proj("-Users-x-secret"), "55555555-5555-4555-8555-555555555555", 1);
    const { d } = daemon({ excludeProjects: /secret/ });
    expect(d.mirror(keep)).toBeGreaterThan(0);
    expect(d.mirror(drop)).toBeNull();
  });

  it("LRU-evicts oldest raw files past the byte cap", () => {
    const dir = proj("-Users-x-acme");
    const { d, logs } = daemon({ maxRawBytes: 1 }); // force eviction on every mirror
    const f1 = transcript(dir, "aaaaaaaa-1111-4111-8111-111111111111", 50);
    d.mirror(f1);
    // after eviction the raw tree is trimmed toward the cap
    const evicted = logs.filter((l) => l.type === "evicted");
    expect(evicted.length).toBeGreaterThanOrEqual(1);
  });

  it("mirror of a vanished source returns null (no throw) — the race it exists to beat", () => {
    const { d } = daemon();
    expect(d.mirror(join(clientRoot, "-Users-x-acme", "ghost.jsonl"))).toBeNull();
  });
});

describe("CaptureDaemon.rescanNow", () => {
  it("mirrors every included transcript in one sweep", () => {
    const dir = proj("-Users-x-acme");
    transcript(dir, "66666666-6666-4666-8666-666666666666", 2);
    transcript(dir, "77777777-7777-4777-8777-777777777777", 2);
    const { d, logs } = daemon();
    d.rescanNow();
    expect(logs.filter((l) => l.type === "mirrored").length).toBe(2);
  });
});
