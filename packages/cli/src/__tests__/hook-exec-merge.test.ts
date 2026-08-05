// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveHookOutcome,
  hookOutcomeToEvent,
  appendHookExecEvents,
  formatDurationApprox,
  planHookExecMerge,
  readHookExecWatermark,
  writeHookExecWatermark,
  hookExecWatermarkPath,
  HOOK_INCOMPLETE_AFTER_MS,
  HOOK_TIMEOUT_MS,
  HOOK_INCOMPLETE_SLACK_MS,
  type HookExecGroup,
  type HookExecStartedRecord,
  type HookExecFinishedRecord,
  type HookExecAbortedRecord,
} from "../hook-exec-merge.js";
import { hookExecSpoolPath } from "../hook-wrap-fast.js";
import type { SessionEvent } from "@outerlayer/session-schema";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-hookmerge-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const T0 = "2026-07-29T10:00:00.000Z";
const T0_MS = Date.parse(T0);

function started(over: Partial<HookExecStartedRecord> = {}): HookExecStartedRecord {
  return {
    rec: "started",
    execId: "exec-1",
    t: T0,
    sessionId: "sess-1",
    hookEvent: "PreToolUse",
    toolUseId: "toolu_9",
    toolName: "Bash",
    cmdSha: "abc",
    cmd: "echo hi",
    pid: 111,
    ...over,
  };
}

describe("deriveHookOutcome — the four-state reader machine", () => {
  it("started + finished, exit 0 → ok, exitCode carried", () => {
    const group: HookExecGroup = {
      started: started(),
      finished: { rec: "finished", execId: "exec-1", durationMs: 42, exitCode: 0 },
    };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + 100 })).toEqual({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      toolUseId: "toolu_9",
      command: "echo hi",
      ts: T0,
      durationMs: 42,
      exitCode: 0,
      status: "ok",
    });
  });

  it("started + finished, exit 2 (BLOCK) → error, exitCode preserved so the raw code is never lost", () => {
    const group: HookExecGroup = {
      started: started(),
      finished: { rec: "finished", execId: "exec-1", durationMs: 15, exitCode: 2 },
    };
    const outcome = deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + 100 });
    expect(outcome).toMatchObject({ status: "error", exitCode: 2, durationMs: 15 });
  });

  it("started + finished, exitCode null (killed by a signal we didn't send) → error, no exitCode field", () => {
    const group: HookExecGroup = {
      started: started(),
      finished: { rec: "finished", execId: "exec-1", durationMs: 15, exitCode: null, signal: "SIGKILL" },
    };
    const outcome = deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + 100 });
    expect(outcome).toEqual({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      toolUseId: "toolu_9",
      command: "echo hi",
      ts: T0,
      durationMs: 15,
      status: "error",
    });
  });

  it("started + aborted, no finished → aborted, duration is the time-to-kill", () => {
    const group: HookExecGroup = {
      started: started(),
      aborted: { rec: "aborted", execId: "exec-1", durationMs: 5000, signal: "SIGTERM" },
    };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + 999_999 })).toEqual({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      toolUseId: "toolu_9",
      command: "echo hi",
      ts: T0,
      durationMs: 5000,
      status: "aborted",
    });
  });

  it("started only, session still active, well under the timeout ceiling → defer", () => {
    const group: HookExecGroup = { started: started() };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + 5_000 })).toBe("defer");
  });

  it("started only, session ended, still under the timeout ceiling → incomplete anyway", () => {
    const group: HookExecGroup = { started: started() };
    const outcome = deriveHookOutcome(group, { sessionEnded: true, nowMs: T0_MS + 5_000 });
    expect(outcome).toMatchObject({ status: "incomplete", durationMs: 5_000 });
  });

  it("started only, session still active but past the timeout ceiling + slack → incomplete, the row this feature exists for", () => {
    const group: HookExecGroup = { started: started() };
    const nowMs = T0_MS + HOOK_INCOMPLETE_AFTER_MS + 1;
    const outcome = deriveHookOutcome(group, { sessionEnded: false, nowMs });
    expect(outcome).toEqual({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      toolUseId: "toolu_9",
      command: "echo hi",
      ts: T0,
      durationMs: HOOK_INCOMPLETE_AFTER_MS + 1,
      status: "incomplete",
      statusMessage: `did not complete (killed or crashed) — ran ≥ ${formatDurationApprox(HOOK_INCOMPLETE_AFTER_MS + 1)}`,
    });
  });

  it("one millisecond under the timeout ceiling still defers — the ceiling itself already counts as incomplete", () => {
    const group: HookExecGroup = { started: started() };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + HOOK_INCOMPLETE_AFTER_MS - 1 })).toBe("defer");
  });

  it("no started record at all → undefined, nothing to build an event from", () => {
    const group: HookExecGroup = {
      finished: { rec: "finished", execId: "orphan", durationMs: 1, exitCode: 0 } as HookExecFinishedRecord,
    };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS })).toBeUndefined();
  });

  it("started with no sessionId (payload didn't parse) → undefined, unattributable", () => {
    const group: HookExecGroup = { started: started({ sessionId: null }) };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS })).toBeUndefined();
  });

  it("started with no hookEvent → undefined, unattributable", () => {
    const group: HookExecGroup = { started: started({ hookEvent: null }) };
    expect(deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS })).toBeUndefined();
  });

  it("started with no toolUseId degrades gracefully — resolved by session+event+timestamp alone", () => {
    const group: HookExecGroup = {
      started: started({ toolUseId: null }),
      finished: { rec: "finished", execId: "exec-1", durationMs: 10, exitCode: 0 },
    };
    const outcome = deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + 10 });
    expect(outcome).not.toBeUndefined();
    expect((outcome as { toolUseId?: string }).toolUseId).toBeUndefined();
  });

  it("exactly at the timeout ceiling is already incomplete — the boundary belongs to incomplete, not defer", () => {
    const group: HookExecGroup = { started: started() };
    const outcome = deriveHookOutcome(group, { sessionEnded: false, nowMs: T0_MS + HOOK_INCOMPLETE_AFTER_MS });
    expect(outcome).toMatchObject({ status: "incomplete", durationMs: HOOK_INCOMPLETE_AFTER_MS });
  });
});

describe("HOOK_INCOMPLETE_AFTER_MS", () => {
  it("is the timeout PLUS slack, not minus — a sign flip would make a hang look 9 minutes younger", () => {
    expect(HOOK_INCOMPLETE_AFTER_MS).toBe(HOOK_TIMEOUT_MS + HOOK_INCOMPLETE_SLACK_MS);
    expect(HOOK_INCOMPLETE_AFTER_MS).toBe(660_000);
  });
});

describe("formatDurationApprox", () => {
  it("renders under a minute as whole seconds", () => {
    expect(formatDurationApprox(45_000)).toBe("45s");
  });

  it("renders exactly 60 seconds as a minute, not as 60s — the boundary belongs to minutes", () => {
    expect(formatDurationApprox(60_000)).toBe("1m");
  });

  it("renders an exact number of minutes without a seconds suffix", () => {
    expect(formatDurationApprox(120_000)).toBe("2m");
  });

  it("renders minutes plus remainder seconds", () => {
    expect(formatDurationApprox(125_000)).toBe("2m5s");
  });
});

describe("hookOutcomeToEvent", () => {
  it("builds the exact hook_executed event shape, seq-less", () => {
    const event = hookOutcomeToEvent({
      sessionId: "sess-1",
      hookEvent: "PostToolUse",
      toolUseId: "toolu_9",
      command: "echo hi",
      ts: T0,
      durationMs: 42,
      exitCode: 0,
      status: "ok",
    });
    expect(event).toEqual({
      type: "hook_executed",
      ts: T0,
      data: {
        hookEvent: "PostToolUse",
        hooks: [{ command: "echo hi", durationMs: 42, exitCode: 0, status: "ok", toolUseId: "toolu_9" }],
      },
    });
  });

  it("omits exitCode/toolUseId/statusMessage entirely when absent — never a fabricated value", () => {
    const event = hookOutcomeToEvent({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      command: "echo hi",
      ts: T0,
      durationMs: 5000,
      status: "aborted",
    });
    expect(event.data).toEqual({
      hookEvent: "PreToolUse",
      hooks: [{ command: "echo hi", durationMs: 5000, status: "aborted" }],
    });
  });

  it("never adds an exitCode KEY when there is none — toEqual alone would let an `exitCode: undefined` key through", () => {
    const event = hookOutcomeToEvent({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      command: "echo hi",
      ts: T0,
      durationMs: 5000,
      status: "aborted",
    });
    expect(Object.keys(event.data!.hooks[0]!)).toEqual(["command", "durationMs", "status"]);
  });

  it("includes statusMessage when the outcome carries one (the incomplete case)", () => {
    const event = hookOutcomeToEvent({
      sessionId: "sess-1",
      hookEvent: "PreToolUse",
      command: "echo hi",
      ts: T0,
      durationMs: 700_000,
      status: "incomplete",
      statusMessage: "did not complete (killed or crashed) — ran ≥ 11m40s",
    });
    expect(event.data!.hooks[0]!.statusMessage).toBe("did not complete (killed or crashed) — ran ≥ 11m40s");
  });
});

describe("appendHookExecEvents", () => {
  it("assigns seq continuing from the session's current highest, not just array length", () => {
    const session = { events: [{ type: "compaction", seq: 4 } as SessionEvent] };
    appendHookExecEvents(session, [
      hookOutcomeToEvent({ sessionId: "s", hookEvent: "PreToolUse", command: "a", ts: T0, durationMs: 1, status: "ok" }),
      hookOutcomeToEvent({ sessionId: "s", hookEvent: "PreToolUse", command: "b", ts: T0, durationMs: 1, status: "ok" }),
    ]);
    expect(session.events.map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("starts seq at 0 for a session with no prior events, not 2", () => {
    const session = { events: [] as SessionEvent[] };
    appendHookExecEvents(session, [
      hookOutcomeToEvent({ sessionId: "s", hookEvent: "PreToolUse", command: "a", ts: T0, durationMs: 1, status: "ok" }),
    ]);
    expect(session.events[0]!.seq).toBe(0);
  });
});

describe("hook-exec watermark", () => {
  it("reads 0 when no watermark file exists yet", () => {
    expect(readHookExecWatermark(home)).toBe(0);
  });

  it("round-trips an exact byte offset", () => {
    writeHookExecWatermark(1234, home);
    expect(readHookExecWatermark(home)).toBe(1234);
  });

  it("clamps a negative watermark value to 0 — a corrupt file must never rewind the offset", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(hookExecWatermarkPath(home), "-50");
    expect(readHookExecWatermark(home)).toBe(0);
  });

  it("clamps non-numeric watermark content to 0", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(hookExecWatermarkPath(home), "not-a-number");
    expect(readHookExecWatermark(home)).toBe(0);
  });
});

/** Appends one spool line and returns the byte offset it STARTED at — the
 * exact quantity the watermark logic reasons about. */
function appendSpoolLine(record: unknown): number {
  mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
  const path = hookExecSpoolPath(home);
  let offset = 0;
  try {
    offset = readFileSync(path).length;
  } catch {
    offset = 0;
  }
  appendFileSync(path, JSON.stringify(record) + "\n");
  return offset;
}

describe("planHookExecMerge", () => {
  it("resolves a completed execution into an event for its session", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.get("sess-a")).toEqual([
      {
        type: "hook_executed",
        ts: T0,
        data: { hookEvent: "PreToolUse", hooks: [{ command: "echo hi", durationMs: 10, exitCode: 0, status: "ok", toolUseId: "toolu_9" }] },
      },
    ]);
  });

  it("holds the watermark BEHIND a deferred execution's `started` line", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    const deferredOffset = appendSpoolLine(started({ execId: "e2", sessionId: "sess-b", t: T0 }));
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 }); // e2 is fresh — defers
    expect(plan.fullyConsumedOffset).toBe(deferredOffset);
    expect(plan.eventsBySession.has("sess-b")).toBe(false);
  });

  it("a second run with an unchanged watermark re-derives nothing new (idempotent on an empty window)", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    const first = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    writeHookExecWatermark(first.fullyConsumedOffset, home);
    const second = planHookExecMerge({ home, nowMs: T0_MS + 20 });
    expect(second.eventsBySession.size).toBe(0);
    expect(second.recordsRead).toBe(0);
  });

  it("tracks the earliest resolved-group offset per session for the caller's unmerged-session guard", () => {
    const offsetA = appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.sessionGroupOffsets.get("sess-a")).toBe(offsetA);
  });

  it("skips a malformed line without wedging every record behind it", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(hookExecSpoolPath(home), "{ not json\n" + JSON.stringify(started({ execId: "e1", sessionId: "sess-a" })) + "\n");
    appendFileSync(hookExecSpoolPath(home), JSON.stringify({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 }) + "\n");
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.get("sess-a")).toHaveLength(1);
  });

  it("respects a previously-written watermark — records before it are never re-read", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    const afterFirst = appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    writeHookExecWatermark(afterFirst + 1000, home); // past both lines
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.recordsRead).toBe(0);
    expect(plan.eventsBySession.size).toBe(0);
  });

  it("hookExecWatermarkPath is namespaced under the given home", () => {
    expect(hookExecWatermarkPath(home)).toBe(join(home, ".outerlayer", "spool", "hook-exec.watermark"));
  });

  it("reads the last line correctly even without a trailing newline (a write that got cut off)", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    const rec1 = JSON.stringify(started({ execId: "e1", sessionId: "sess-a" }));
    const rec2 = JSON.stringify({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 });
    writeFileSync(hookExecSpoolPath(home), rec1 + "\n" + rec2); // no trailing \n
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.get("sess-a")).toEqual([
      {
        type: "hook_executed",
        ts: T0,
        data: { hookEvent: "PreToolUse", hooks: [{ command: "echo hi", durationMs: 10, exitCode: 0, status: "ok", toolUseId: "toolu_9" }] },
      },
    ]);
  });

  it("keeps reading subsequent lines after a short first line — the loop's end check keys off 'no newline found', not any specific offset", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    const rec1 = JSON.stringify(started({ execId: "e1", sessionId: "sess-a" }));
    const rec2 = JSON.stringify({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 });
    // "x\n" puts a real newline at byte offset 1 — a stand-in for any line
    // short enough to land there, which a naive "is this offset 1?" check
    // would mistake for "no newline found".
    writeFileSync(hookExecSpoolPath(home), "x\n" + rec1 + "\n" + rec2 + "\n");
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.get("sess-a")).toHaveLength(1);
  });

  it("groups a started+aborted pair correctly — an aborted execution is never mistaken for a completed one", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "aborted", execId: "e1", durationMs: 5000, signal: "SIGTERM" } as HookExecAbortedRecord);
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.get("sess-a")).toEqual([
      {
        type: "hook_executed",
        ts: T0,
        data: { hookEvent: "PreToolUse", hooks: [{ command: "echo hi", durationMs: 5000, status: "aborted", toolUseId: "toolu_9" }] },
      },
    ]);
  });

  it("ignores a spool record with an unrecognized `rec` value instead of misfiling it as aborted", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "unknown-type", execId: "e1" });
    // Recent, and no finished/aborted arrived — the ONLY correct read is
    // "still running, defer". If the unrecognized record got misfiled as
    // `aborted`, this would resolve (wrongly) into an event instead.
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.has("sess-a")).toBe(false);
  });

  it("survives an orphaned finished record with no matching started line, rather than crashing the whole merge", () => {
    appendSpoolLine({ rec: "finished", execId: "orphan", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.size).toBe(0);
  });

  it("skips an unattributable group (no sessionId at all) without crashing the whole merge", () => {
    appendSpoolLine(started({ execId: "e1", sessionId: null }));
    appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    expect(plan.eventsBySession.size).toBe(0);
  });

  it("tracks the MINIMUM resolved-group offset per session across multiple executions, not just the last one seen", () => {
    const offsetA = appendSpoolLine(started({ execId: "e1", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "finished", execId: "e1", durationMs: 10, exitCode: 0 } as HookExecFinishedRecord);
    appendSpoolLine(started({ execId: "e2", sessionId: "sess-a" }));
    appendSpoolLine({ rec: "finished", execId: "e2", durationMs: 20, exitCode: 0 } as HookExecFinishedRecord);
    const plan = planHookExecMerge({ home, nowMs: T0_MS + 10 });
    // e1's offset is smaller (it was appended first) — the guard must hold
    // the watermark back to the EARLIEST unmerged group, not whichever one
    // the map happened to visit last.
    expect(plan.sessionGroupOffsets.get("sess-a")).toBe(offsetA);
  });
});
