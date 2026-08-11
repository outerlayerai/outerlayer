// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@outerlayer/session-schema";
import type { SourceAdapter, SourceRoots } from "../adapters/types.js";
import type { TranscriptEntry } from "../adapters/claude-code/discover.js";
import {
  computeStatuslineState,
  costSince,
  writeStatuslineState,
  readStatuslineState,
  readSyncWatermarkMs,
  statuslineStatePath,
  StatuslineAggregator,
  type StatuslineState,
} from "../statusline-state.js";
import { claudeCodeAdapter } from "../adapters/claude-code/index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-sl-state-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const TODAY_MTIME = Date.parse("2026-08-11T09:00:00.000Z");
const YESTERDAY_MTIME = Date.parse("2026-08-10T09:00:00.000Z");

function minimalAgentSession(id: string, costUsd: number | null): AgentSession {
  return {
    schemaVersion: 1,
    id,
    agent: { type: "claude-code" },
    env: {},
    startedAt: "2026-08-11T09:00:00.000Z",
    models: [],
    turns: [],
    events: [],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd },
    captureTier: "metrics",
    warnings: [],
  };
}

interface FakeEntrySpec {
  sessionId: string;
  mtimeMs: number;
  costUsd: number | null;
}

/** A fake SourceAdapter over in-memory specs — no filesystem transcripts,
 * so aggregation tests exercise only the summing/filtering logic. */
function makeFakeAdapter(id: string, specs: FakeEntrySpec[]): { adapter: SourceAdapter; parsedFiles: string[] } {
  const parsedFiles: string[] = [];
  const adapter: SourceAdapter = {
    id,
    discover: (): TranscriptEntry[] =>
      specs.map((s) => ({
        file: `/fake/${id}/${s.sessionId}.jsonl`,
        mtimeMs: s.mtimeMs,
        bytes: 100,
        isSubagent: false,
      })),
    parse: (entry) => {
      parsedFiles.push(entry.file);
      const spec = specs.find((s) => entry.file === `/fake/${id}/${s.sessionId}.jsonl`)!;
      return {
        session: minimalAgentSession(spec.sessionId, spec.costUsd),
        warnings: {},
        stats: { lines: 1, parsed: 1, skipped: 0, unmapped: 0 },
        versions: [],
        blobs: [],
      };
    },
  };
  return { adapter, parsedFiles };
}

describe("computeStatuslineState — aggregation across fake adapters", () => {
  it("sums costUsd per adapter id into today.byAgent, exact map", () => {
    const { adapter: a1 } = makeFakeAdapter("claude-code", [
      { sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 3 },
      { sessionId: "s2", mtimeMs: TODAY_MTIME, costUsd: 4.5 },
    ]);
    const { adapter: a2 } = makeFakeAdapter("codex", [{ sessionId: "s3", mtimeMs: TODAY_MTIME, costUsd: 1.25 }]);
    const { adapter: a3 } = makeFakeAdapter("cursor", [{ sessionId: "s4", mtimeMs: TODAY_MTIME, costUsd: 0.5 }]);

    const state = computeStatuslineState({ home, now: () => NOW, adapters: [a1, a2, a3] });
    expect(state.today.byAgent).toEqual({ "claude-code": 7.5, codex: 1.25, cursor: 0.5 });
  });

  it("a null costUsd sums as 0, not NaN or skipped", () => {
    const { adapter } = makeFakeAdapter("claude-code", [
      { sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 2 },
      { sessionId: "s2", mtimeMs: TODAY_MTIME, costUsd: null },
    ]);
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [adapter] });
    expect(state.today.byAgent).toEqual({ "claude-code": 2 });
  });

  it("builds an exact per-session cost map keyed by session id", () => {
    const { adapter } = makeFakeAdapter("claude-code", [
      { sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 2 },
      { sessionId: "s2", mtimeMs: TODAY_MTIME, costUsd: 3 },
    ]);
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [adapter] });
    expect(state.sessions).toEqual({ s1: { costUsd: 2 }, s2: { costUsd: 3 } });
  });

  it("today.date matches the injected now's local calendar day", () => {
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [] });
    expect(state.today.date).toBe("2026-08-11");
  });
});

describe("computeStatuslineState — mtime pre-filter", () => {
  it("never parses entries older than local midnight; parses exactly the today entries", () => {
    const { adapter, parsedFiles } = makeFakeAdapter("claude-code", [
      { sessionId: "old", mtimeMs: YESTERDAY_MTIME, costUsd: 99 },
      { sessionId: "new1", mtimeMs: TODAY_MTIME, costUsd: 1 },
      { sessionId: "new2", mtimeMs: TODAY_MTIME, costUsd: 2 },
    ]);
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [adapter] });
    expect(parsedFiles).toEqual(["/fake/claude-code/new1.jsonl", "/fake/claude-code/new2.jsonl"]);
    expect(state.today.byAgent).toEqual({ "claude-code": 3 });
    expect(state.sessions.old).toBeUndefined();
  });
});

describe("readSyncWatermarkMs / unsynced derivation", () => {
  function writeConfig(): void {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(join(home, ".outerlayer", "config.json"), JSON.stringify({ url: "https://app.example.com", appId: "a1" }));
  }
  function writeWatermark(ms: number): void {
    writeFileSync(join(home, ".outerlayer", "watermarks.json"), JSON.stringify({ "app.example.com:a1": ms }));
  }

  it("counts only entries newer than the configured watermark", () => {
    writeConfig();
    writeWatermark(TODAY_MTIME + 1000);
    const { adapter } = makeFakeAdapter("claude-code", [
      { sessionId: "before", mtimeMs: TODAY_MTIME + 500, costUsd: 1 }, // <= watermark
      { sessionId: "after", mtimeMs: TODAY_MTIME + 2000, costUsd: 1 }, // > watermark
    ]);
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [adapter] });
    expect(state.unsynced).toBe(1);
  });

  it("readSyncWatermarkMs returns the exact configured value", () => {
    writeConfig();
    writeWatermark(1234567);
    expect(readSyncWatermarkMs(home)).toBe(1234567);
  });

  it("unsynced key is entirely absent when sync was never configured", () => {
    const { adapter } = makeFakeAdapter("claude-code", [{ sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 1 }]);
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [adapter] });
    expect("unsynced" in state).toBe(false);
    expect(readSyncWatermarkMs(home)).toBeNull();
  });

  it("config present but no watermarks.json: every today entry counts as unsynced (watermark 0)", () => {
    writeConfig();
    const { adapter } = makeFakeAdapter("claude-code", [
      { sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 1 },
      { sessionId: "s2", mtimeMs: TODAY_MTIME + 100, costUsd: 1 },
    ]);
    expect(readSyncWatermarkMs(home)).toBe(0);
    const state = computeStatuslineState({ home, now: () => NOW, adapters: [adapter] });
    expect(state.unsynced).toBe(2);
  });
});

describe("writeStatuslineState / readStatuslineState — round trip", () => {
  const sample: StatuslineState = {
    v: 1,
    generatedAt: new Date(NOW).toISOString(),
    today: { date: "2026-08-11", byAgent: { "claude-code": 4.2 } },
    sessions: { s1: { costUsd: 4.2 } },
    unsynced: 3,
  };

  it("write then read returns the exact same state", () => {
    writeStatuslineState(sample, home);
    expect(readStatuslineState(home)).toEqual(sample);
  });

  it("a corrupt file on disk reads back as null", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(statuslineStatePath(home), "{ not json");
    expect(readStatuslineState(home)).toBeNull();
  });

  it("leaves no .tmp file behind after a write (atomic write-then-rename)", () => {
    writeStatuslineState(sample, home);
    const files = readdirSync(join(home, ".outerlayer"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files).toContain("statusline.json");
  });
});

describe("StatuslineAggregator", () => {
  it("collapses a burst of notifyChange calls into exactly one recompute after the debounce window", () => {
    vi.useFakeTimers();
    try {
      const { adapter, parsedFiles } = makeFakeAdapter("claude-code", [{ sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 1 }]);
      const agg = new StatuslineAggregator({ home, now: () => NOW, adapters: [adapter], debounceMs: 5000 });
      agg.notifyChange();
      agg.notifyChange();
      agg.notifyChange();
      expect(parsedFiles).toEqual([]); // nothing yet — still debouncing
      vi.advanceTimersByTime(5000);
      expect(parsedFiles).toEqual(["/fake/claude-code/s1.jsonl"]); // exactly one recompute
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() flushes a pending debounce immediately, without waiting for the timer", () => {
    const { adapter, parsedFiles } = makeFakeAdapter("claude-code", [{ sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 1 }]);
    const agg = new StatuslineAggregator({ home, now: () => NOW, adapters: [adapter], debounceMs: 5000 });
    agg.notifyChange();
    expect(existsSync(statuslineStatePath(home))).toBe(false);
    agg.stop();
    expect(parsedFiles).toEqual(["/fake/claude-code/s1.jsonl"]);
    expect(existsSync(statuslineStatePath(home))).toBe(true);
  });

  it("stop() with no pending debounce does not trigger an extra recompute", () => {
    const { adapter, parsedFiles } = makeFakeAdapter("claude-code", [{ sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 1 }]);
    const agg = new StatuslineAggregator({ home, now: () => NOW, adapters: [adapter] });
    agg.stop();
    expect(parsedFiles).toEqual([]);
    expect(existsSync(statuslineStatePath(home))).toBe(false);
  });

  it("refresh() performs a synchronous full recompute and writes immediately", () => {
    const { adapter } = makeFakeAdapter("claude-code", [{ sessionId: "s1", mtimeMs: TODAY_MTIME, costUsd: 6 }]);
    const agg = new StatuslineAggregator({ home, now: () => NOW, adapters: [adapter] });
    const state = agg.refresh();
    expect(state.today.byAgent).toEqual({ "claude-code": 6 });
    expect(readStatuslineState(home)).toEqual(state);
  });
});

describe("computeStatuslineState — real claudeCodeAdapter integration", () => {
  let projectsRoot: string;
  let rawRoot: string;
  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "ol-sl-projects-"));
    rawRoot = join(tmpdir(), "ol-sl-raw-does-not-exist");
  });
  afterEach(() => rmSync(projectsRoot, { recursive: true, force: true }));

  it("sums a real parsed session's totals.costUsd into byAgent['claude-code']", () => {
    const sessionId = "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b";
    const projectDir = join(projectsRoot, "-Users-dev-acme");
    mkdirSync(projectDir, { recursive: true });
    const line = {
      sessionId,
      cwd: "/home/dev/acme",
      gitBranch: "main",
      version: "2.1.193",
      entrypoint: "cli",
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "fixing it" }],
        usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), JSON.stringify(line) + "\n");

    const roots: SourceRoots = { root: projectsRoot, rawRoot };
    const state = computeStatuslineState({ home, now: () => Date.now(), roots, adapters: [claudeCodeAdapter] });
    expect(state.today.byAgent["claude-code"]).toBeGreaterThan(0);
    expect(state.sessions[sessionId]?.costUsd).toBe(state.today.byAgent["claude-code"]);
  });
});

describe("costSince", () => {
  const midnight = new Date(NOW).setHours(0, 0, 0, 0);

  it("counts only turns spent after midnight for a session spanning the boundary", () => {
    const session = {
      id: "overnight",
      startedAt: new Date(midnight - 10 * 3_600_000).toISOString(),
      totals: { costUsd: 70.72 },
      turns: [
        { ts: new Date(midnight - 2 * 3_600_000).toISOString(), costUsd: 50 },
        { ts: new Date(midnight - 60_000).toISOString(), costUsd: 15.72 },
        { ts: new Date(midnight + 60_000).toISOString(), costUsd: 3 },
        { ts: new Date(midnight + 3_600_000).toISOString(), costUsd: 2 },
      ],
    };
    expect(costSince(session, midnight)).toBe(5);
  });

  it("attributes a timestamp-less turn via the session start", () => {
    const yesterdayStart = {
      id: "y",
      startedAt: new Date(midnight - 3_600_000).toISOString(),
      totals: { costUsd: 9 },
      turns: [{ costUsd: 9 }],
    };
    const todayStart = {
      id: "t",
      startedAt: new Date(midnight + 3_600_000).toISOString(),
      totals: { costUsd: 9 },
      turns: [{ costUsd: 9 }],
    };
    expect(costSince(yesterdayStart, midnight)).toBe(0);
    expect(costSince(todayStart, midnight)).toBe(9);
  });

  it("falls back to the session total when no turn carries a cost", () => {
    const session = {
      id: "totals-only",
      startedAt: new Date(midnight + 60_000).toISOString(),
      totals: { costUsd: 4.5 },
      turns: [{ ts: new Date(midnight + 60_000).toISOString() }],
    };
    expect(costSince(session, midnight)).toBe(4.5);
  });

  it("treats null turn costs as unpriced, not as zero-cost evidence", () => {
    const session = {
      id: "null-turns",
      startedAt: new Date(midnight + 60_000).toISOString(),
      totals: { costUsd: 2.25 },
      turns: [{ ts: new Date(midnight + 60_000).toISOString(), costUsd: null }],
    };
    expect(costSince(session, midnight)).toBe(2.25);
  });
});

describe("computeStatuslineState day-boundary attribution", () => {
  it("excludes an overnight session's pre-midnight turns from today's total but keeps its full session cost", () => {
    const midnight = new Date(NOW).setHours(0, 0, 0, 0);
    const overnight: AgentSession = {
      ...minimalAgentSession("overnight", 70.72),
      startedAt: new Date(midnight - 10 * 3_600_000).toISOString(),
      turns: [
        { index: 0, role: "assistant", ts: new Date(midnight - 3_600_000).toISOString(), costUsd: 65.72 },
        { index: 1, role: "assistant", ts: new Date(midnight + 3_600_000).toISOString(), costUsd: 5 },
      ] as AgentSession["turns"],
    };
    const adapter: SourceAdapter = {
      id: "claude-code",
      discover: (): TranscriptEntry[] => [{ file: "/fake/overnight.jsonl", mtimeMs: TODAY_MTIME, bytes: 1, isSubagent: false }],
      parse: () => ({ session: overnight, warnings: {}, stats: { lines: 1, parsed: 1, skipped: 0, unmapped: 0 }, versions: [], blobs: [] }),
    };
    const state = computeStatuslineState({ home, adapters: [adapter], now: () => NOW });
    expect(state.today.byAgent).toEqual({ "claude-code": 5 });
    expect(state.sessions).toEqual({ overnight: { costUsd: 70.72 } });
  });
});
