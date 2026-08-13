// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import type { StatuslineState } from "@outerlayer/capture";
import {
  renderStatusline,
  parseStatuslineStdin,
  readStatuslineState,
  localDateString,
  statuslineStatePath,
  runWrappedStatusline,
  parseStatuslineArgs,
  runStatuslineFast,
  STATE_FRESH_MS,
  WRAP_TIMEOUT_MS,
  type StatuslineStdin,
  type StatuslineStateFile,
  type WrapChild,
} from "../statusline-fast.js";
import { encodeWrappedCommand } from "../settings.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const SEP = `${DIM} · ${RESET}`;
const DOCTOR_HINT = `${DIM}outerlayer doctor${RESET}`;

const NOW = Date.parse("2026-08-11T12:00:00.000Z");

function freshState(overrides: Partial<StatuslineStateFile> = {}): StatuslineStateFile {
  return {
    v: 1,
    generatedAt: new Date(NOW - 60_000).toISOString(),
    // sessionCount is irrelevant whenever 2+ agents have cost (the "agents"
    // phrasing wins outright) — the default here is a placeholder for those
    // cases; single-agent tests override `today` explicitly to pin it.
    today: { date: localDateString(NOW), byAgent: { "claude-code": 21.1, codex: 1.8, cursor: 0.5 }, sessionCount: 4 },
    sessions: {},
    unsynced: 12,
    ...overrides,
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-statusline-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("localDateString", () => {
  it("formats as YYYY-MM-DD with zero-padded month and day", () => {
    expect(localDateString(Date.parse("2026-01-05T12:00:00.000Z"))).toBe("2026-01-05");
  });

  it("double-digit month and day need no padding", () => {
    expect(localDateString(Date.parse("2026-11-23T12:00:00.000Z"))).toBe("2026-11-23");
  });
});

describe("renderStatusline — fixture matrix", () => {
  it("full payload + fresh state: all three segments, exact ANSI", () => {
    const stdin: StatuslineStdin = { cost: { total_cost_usd: 0.87 } };
    const line = renderStatusline(stdin, freshState(), NOW);
    expect(line).toBe(`⬢ OL  $0.87 session${SEP}$23.40 today across 3 agents${SEP}12 unsynced`);
  });

  it("minimal stdin ({}) with no state: session omitted, only the degraded hint", () => {
    const line = renderStatusline({}, null, NOW);
    expect(line).toBe(`⬢ OL  ${DOCTOR_HINT}`);
  });

  it("empty stdin string parses to {} — same as minimal", () => {
    expect(parseStatuslineStdin("")).toEqual({});
    expect(renderStatusline(parseStatuslineStdin(""), null, NOW)).toBe(`⬢ OL  ${DOCTOR_HINT}`);
  });

  it("malformed JSON stdin parses to {} rather than throwing", () => {
    expect(parseStatuslineStdin("{not valid json")).toEqual({});
  });

  it("stdin that parses to a non-object (e.g. a bare number) is treated as {}", () => {
    expect(parseStatuslineStdin("42")).toEqual({});
    expect(parseStatuslineStdin("null")).toEqual({});
  });

  it("absent cost omits the session segment entirely", () => {
    const line = renderStatusline({}, freshState(), NOW);
    expect(line).toBe(`⬢ OL  $23.40 today across 3 agents${SEP}12 unsynced`);
  });

  it("stale state (generatedAt older than STATE_FRESH_MS) degrades: session segment + doctor hint, no today/unsynced", () => {
    const stale = freshState({ generatedAt: new Date(NOW - STATE_FRESH_MS - 1).toISOString() });
    const line = renderStatusline({ cost: { total_cost_usd: 1.5 } }, stale, NOW);
    expect(line).toBe(`⬢ OL  $1.50 session${SEP}${DOCTOR_HINT}`);
  });

  it("state exactly at the freshness boundary still counts as fresh", () => {
    const boundary = freshState({ generatedAt: new Date(NOW - STATE_FRESH_MS).toISOString() });
    const line = renderStatusline({}, boundary, NOW);
    expect(line).not.toContain("outerlayer doctor");
    expect(line).toContain("today across 3 agents");
  });

  it("state dated yesterday but generatedAt fresh: today segment omitted, NO degraded hint (unsynced still shows)", () => {
    const yesterday = freshState({ today: { date: "2026-08-10", byAgent: { "claude-code": 5 }, sessionCount: 1 } });
    const line = renderStatusline({ cost: { total_cost_usd: 0.2 } }, yesterday, NOW);
    expect(line).toBe(`⬢ OL  $0.20 session${SEP}12 unsynced`);
    expect(line).not.toContain("outerlayer doctor");
    expect(line).not.toContain("today across");
  });

  it("corrupt state file on disk: readStatuslineState returns null", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(statuslineStatePath(home), "{ not json at all");
    expect(readStatuslineState(home)).toBeNull();
  });

  it("state file with the wrong shape (missing today.byAgent) reads as null, not a partial object", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(statuslineStatePath(home), JSON.stringify({ v: 1, generatedAt: new Date(NOW).toISOString() }));
    expect(readStatuslineState(home)).toBeNull();
  });

  it("readStatuslineState returns null when the file is simply absent", () => {
    expect(readStatuslineState(home)).toBeNull();
  });

  it("2+ agents with cost keeps the 'across N agents' phrasing", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 4, codex: 2 }, sessionCount: 1 } });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $6.00 today across 2 agents${SEP}12 unsynced`);
  });

  it("exactly one agent but sessionCount >= 2 falls back to 'across N sessions'", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 4.5, codex: 0 }, sessionCount: 3 } });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $4.50 today across 3 sessions${SEP}12 unsynced`);
  });

  it("sessionCount exactly 2 is already 'across N sessions' — the boundary is inclusive", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 4.5 }, sessionCount: 2 } });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $4.50 today across 2 sessions${SEP}12 unsynced`);
  });

  it("exactly one agent and exactly one session renders a bare '$X today' — no scope suffix", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 4.5 }, sessionCount: 1 } });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $4.50 today${SEP}12 unsynced`);
  });

  it("an older state file with sessionCount absent (tolerant parse) also renders a bare '$X today'", () => {
    const legacyToday = { date: localDateString(NOW), byAgent: { "claude-code": 4.5 } } as unknown as StatuslineStateFile["today"];
    const state = freshState({ today: legacyToday });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $4.50 today${SEP}12 unsynced`);
  });

  it("zero-cost agents are excluded from both the total and the agent count", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 0, codex: 0 }, sessionCount: 0 } });
    const line = renderStatusline({}, state, NOW);
    // no agent has cost > 0, so the today segment is omitted entirely
    expect(line).toBe(`⬢ OL  12 unsynced`);
  });

  it("unsynced 0 is omitted", () => {
    const state = freshState({ unsynced: 0 });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $23.40 today across 3 agents`);
  });

  it("unsynced absent (sync never configured) is omitted, same as zero", () => {
    const state = freshState();
    delete (state as { unsynced?: number }).unsynced;
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $23.40 today across 3 agents`);
  });

  it("session cost >= $100 renders rounded with thousands separators, no cents", () => {
    const line = renderStatusline({ cost: { total_cost_usd: 1234.56 } }, null, NOW);
    expect(line).toBe(`⬢ OL  $1,235 session${SEP}${DOCTOR_HINT}`);
  });

  it("session cost of exactly $100 already uses the rounded form — the boundary is inclusive", () => {
    const line = renderStatusline({ cost: { total_cost_usd: 100 } }, null, NOW);
    expect(line).toBe(`⬢ OL  $100 session${SEP}${DOCTOR_HINT}`);
  });

  it("today total >= $100 also renders rounded with thousands separators", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 3000, codex: 2000 }, sessionCount: 1 }, unsynced: 0 });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $5,000 today across 2 agents`);
  });

  it("a non-numeric or NaN cost is treated as absent, not as $0.00", () => {
    const line1 = renderStatusline({ cost: { total_cost_usd: Number.NaN } }, null, NOW);
    expect(line1).toBe(`⬢ OL  ${DOCTOR_HINT}`);
    const line2 = renderStatusline({ cost: {} }, null, NOW);
    expect(line2).toBe(`⬢ OL  ${DOCTOR_HINT}`);
  });

  it("bare prefix with no segments at all when fresh state carries nothing to show", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: {}, sessionCount: 0 }, unsynced: 0 });
    expect(renderStatusline({}, state, NOW)).toBe("⬢ OL");
  });
});

describe("renderStatusline — defends against a malformed on-disk state file", () => {
  // The state file is daemon-written JSON, but readStatuslineState only
  // shape-checks its OWN fields (v/generatedAt/today.date/today.byAgent) —
  // a byAgent/sessionCount/unsynced VALUE of the wrong type still reaches
  // render. These pin the runtime type guards that keep a stray string from
  // being treated as a valid cost/count via loose `>`/`>=` coercion.
  it("a byAgent value that is a numeric STRING is not treated as a real cost (loose '>' would coerce it truthy)", () => {
    const corruptToday = { date: localDateString(NOW), byAgent: { "claude-code": "50" }, sessionCount: 1 } as unknown as StatuslineStateFile["today"];
    const state = freshState({ today: corruptToday, unsynced: 0 });
    expect(renderStatusline({}, state, NOW)).toBe("⬢ OL");
  });

  it("a sessionCount that is a numeric STRING never triggers the 'across N sessions' phrasing", () => {
    const corruptToday = { date: localDateString(NOW), byAgent: { "claude-code": 4.5 }, sessionCount: "5" } as unknown as StatuslineStateFile["today"];
    const state = freshState({ today: corruptToday, unsynced: 0 });
    expect(renderStatusline({}, state, NOW)).toBe(`⬢ OL  $4.50 today`);
  });

  it("an unsynced value that is a numeric STRING never renders the unsynced segment", () => {
    const state = freshState({ unsynced: "10" as unknown as number });
    expect(renderStatusline({}, state, NOW)).toBe(`⬢ OL  $23.40 today across 3 agents`);
  });
});

describe("readStatuslineState — shape guards, each isolated", () => {
  function write(content: unknown): void {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(statuslineStatePath(home), JSON.stringify(content));
  }

  it("a bare JSON null is treated as absent", () => {
    write(null);
    expect(readStatuslineState(home)).toBeNull();
  });

  it("v !== 1 alone (everything else valid) reads as null", () => {
    write({ v: 2, generatedAt: new Date(NOW).toISOString(), today: { date: "2026-08-11", byAgent: {} } });
    expect(readStatuslineState(home)).toBeNull();
  });

  it("a non-string generatedAt alone (everything else valid) reads as null", () => {
    write({ v: 1, generatedAt: 12345, today: { date: "2026-08-11", byAgent: {} } });
    expect(readStatuslineState(home)).toBeNull();
  });

  it("a non-string today.date alone (everything else valid) reads as null", () => {
    write({ v: 1, generatedAt: new Date(NOW).toISOString(), today: { date: 12345, byAgent: {} } });
    expect(readStatuslineState(home)).toBeNull();
  });

  it("a non-object today.byAgent alone (everything else valid) reads as null", () => {
    write({ v: 1, generatedAt: new Date(NOW).toISOString(), today: { date: "2026-08-11", byAgent: "not-an-object" } });
    expect(readStatuslineState(home)).toBeNull();
  });

  it("a fully valid shape passes through untouched", () => {
    const valid = { v: 1, generatedAt: new Date(NOW).toISOString(), today: { date: "2026-08-11", byAgent: { "claude-code": 1 } }, sessions: {} };
    write(valid);
    expect(readStatuslineState(home)).toEqual(valid);
  });
});

describe("runStatuslineFast", () => {
  it("prints exactly one line ending in a trailing newline", async () => {
    const writes: string[] = [];
    await runStatuslineFast([], {
      home,
      read: () => JSON.stringify({ cost: { total_cost_usd: 2 } }),
      write: (s) => writes.push(s),
      now: () => NOW,
    });
    expect(writes).toEqual([`⬢ OL  $2.00 session${SEP}${DOCTOR_HINT}\n`]);
  });

  it("a throwing read still writes the bare brand line and never throws", async () => {
    const writes: string[] = [];
    await expect(
      runStatuslineFast([], {
        home,
        read: () => {
          throw new Error("stdin exploded");
        },
        write: (s) => writes.push(s),
        now: () => NOW,
      }),
    ).resolves.toBeUndefined();
    expect(writes).toEqual(["⬢ OL\n"]);
  });

  it("with no `read` injected and a TTY stdin, reads as {} instead of blocking on fd 0", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const writes: string[] = [];
      await runStatuslineFast([], { home, write: (s) => writes.push(s), now: () => NOW });
      expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("with no `write` injected, prints through the real process.stdout.write", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runStatuslineFast([], { home, read: () => JSON.stringify({ cost: { total_cost_usd: 2 } }), now: () => NOW });
      expect(spy).toHaveBeenCalledWith(`⬢ OL  $2.00 session${SEP}${DOCTOR_HINT}\n`);
    } finally {
      spy.mockRestore();
    }
  });

  it("with no `now` injected, uses the real clock rather than throwing — output carries real content, not the crash fallback", async () => {
    const writes: string[] = [];
    await runStatuslineFast([], {
      home,
      read: () => JSON.stringify({ cost: { total_cost_usd: 5 } }),
      write: (s) => writes.push(s),
    });
    expect(writes).toEqual([`⬢ OL  $5.00 session${SEP}${DOCTOR_HINT}\n`]);
  });
});

/** A minimal fake WrapChild: `on("close"|"error", …)` fire on demand;
 * writes to stdin land in a plain array instead of a real pipe. */
function fakeWrapChild(): {
  child: WrapChild;
  stdinChunks: string[];
  emitStdout: (chunk: string) => void;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
  killCalls: Array<NodeJS.Signals | undefined>;
} {
  const listeners: { close: Array<(code: number | null) => void>; error: Array<(err: Error) => void> } = {
    close: [],
    error: [],
  };
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const stdinChunks: string[] = [];
  const killCalls: Array<NodeJS.Signals | undefined> = [];
  const child: WrapChild = {
    stdin: {
      on: () => {},
      write: (chunk: unknown) => {
        stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        return true;
      },
      end: () => {},
    } as unknown as NodeJS.WritableStream,
    stdout: {
      on: (event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(listener);
      },
    } as unknown as NodeJS.ReadableStream,
    on(event: "close" | "error", listener: never) {
      if (event === "close") listeners.close.push(listener as (code: number | null) => void);
      if (event === "error") listeners.error.push(listener as (err: Error) => void);
      return child;
    },
    kill(signal?: NodeJS.Signals) {
      killCalls.push(signal);
      return true;
    },
  };
  return {
    child,
    stdinChunks,
    emitStdout: (chunk: string) => stdoutListeners.forEach((l) => l(Buffer.from(chunk, "utf8"))),
    emitClose: (code: number | null) => listeners.close.forEach((l) => l(code)),
    emitError: (err: Error) => listeners.error.forEach((l) => l(err)),
    killCalls,
  };
}

describe("wrap mode — runWrappedStatusline", () => {
  it("defaults its timeout to WRAP_TIMEOUT_MS when none is given", async () => {
    expect(WRAP_TIMEOUT_MS).toBe(750);
    const { child, killCalls } = fakeWrapChild(); // never emits close
    const start = Date.now();
    const promise = runWrappedStatusline("sleep 999", "", { spawnImpl: () => child });
    await expect(promise).resolves.toBeNull();
    expect(killCalls).toEqual(["SIGKILL"]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(WRAP_TIMEOUT_MS - 5);
  }, 2000);

  it("resolves the wrapped stdout on a clean exit 0", async () => {
    const { child, emitStdout, emitClose } = fakeWrapChild();
    const promise = runWrappedStatusline("original-cmd", "stdin text", { spawnImpl: () => child });
    emitStdout("line1\nline2");
    emitClose(0);
    await expect(promise).resolves.toBe("line1\nline2");
  });

  it("resolves null on a non-zero exit", async () => {
    const { child, emitClose } = fakeWrapChild();
    const promise = runWrappedStatusline("original-cmd", "", { spawnImpl: () => child });
    emitClose(1);
    await expect(promise).resolves.toBeNull();
  });

  it("resolves null when spawn throws", async () => {
    const promise = runWrappedStatusline("original-cmd", "", {
      spawnImpl: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(promise).resolves.toBeNull();
  });

  it("resolves null on a child 'error' event WITHOUT waiting for the timeout to elapse", async () => {
    vi.useFakeTimers();
    try {
      const { child, emitError } = fakeWrapChild();
      // A long timeout: if the 'error' handler were a no-op, this promise
      // would still eventually resolve null once the timeout fires — so a
      // fixed value alone can't distinguish a live handler from a dead one.
      // Advancing only 1ms (nowhere near 10s) proves resolution came from
      // the error handler itself.
      const promise = runWrappedStatusline("original-cmd", "", { spawnImpl: () => child, timeoutMs: 10_000 });
      emitError(new Error("spawn EACCES"));
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws when the child has no stdin/stdout streams at all", async () => {
    const listeners: { close: Array<(code: number | null) => void> } = { close: [] };
    const nullChild: WrapChild = {
      stdin: null,
      stdout: null,
      on(event: "close" | "error", listener: never) {
        if (event === "close") listeners.close.push(listener as (code: number | null) => void);
        return nullChild;
      },
      kill: () => true,
    };
    const promise = runWrappedStatusline("original-cmd", "some stdin", { spawnImpl: () => nullChild });
    listeners.close.forEach((l) => l(0));
    await expect(promise).resolves.toBe(""); // no stdout stream to collect from
  });

  it("a null stdout does not prevent stdin from still being written (independent optional chains)", async () => {
    const stdinChunks: string[] = [];
    const listeners: { close: Array<(code: number | null) => void> } = { close: [] };
    const child: WrapChild = {
      stdin: {
        on: () => {},
        write: (chunk: unknown) => {
          stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
          return true;
        },
        end: () => {},
      } as unknown as NodeJS.WritableStream,
      stdout: null,
      on(event: "close" | "error", listener: never) {
        if (event === "close") listeners.close.push(listener as (code: number | null) => void);
        return child;
      },
      kill: () => true,
    };
    const promise = runWrappedStatusline("original-cmd", "payload bytes", { spawnImpl: () => child });
    listeners.close.forEach((l) => l(0));
    await promise;
    expect(stdinChunks.join("")).toBe("payload bytes");
  });

  it("delivers stdin text to the child byte-for-byte", async () => {
    const { child, stdinChunks, emitClose } = fakeWrapChild();
    const payload = "the exact stdin bytes";
    const promise = runWrappedStatusline("original-cmd", payload, { spawnImpl: () => child });
    emitClose(0);
    await promise;
    expect(stdinChunks.join("")).toBe(payload);
  });

  it("kills the child with SIGKILL and resolves null on timeout", async () => {
    const { child, killCalls } = fakeWrapChild(); // never emits close
    const promise = runWrappedStatusline("sleep 999", "", { spawnImpl: () => child, timeoutMs: 15 });
    await expect(promise).resolves.toBeNull();
    expect(killCalls).toEqual(["SIGKILL"]);
  });
});

describe("runStatuslineFast — wrap mode end to end", () => {
  it("preserves multi-line wrapped stdout ordering: their output first, ours last", async () => {
    const { child, emitStdout, emitClose } = fakeWrapChild();
    const writes: string[] = [];
    const runPromise = runStatuslineFast(["--wrap-id", encodeWrappedCommand("their-status")], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => child,
      now: () => NOW,
    });
    emitStdout("their line 1\ntheir line 2\n");
    emitClose(0);
    await runPromise;
    expect(writes).toEqual([`their line 1\ntheir line 2\n`, `⬢ OL  ${DOCTOR_HINT}\n`]);
  });

  it("wrapped command's non-zero exit yields only our line", async () => {
    const { child, emitClose } = fakeWrapChild();
    const writes: string[] = [];
    const runPromise = runStatuslineFast(["--wrap-id", encodeWrappedCommand("their-status")], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => child,
      now: () => NOW,
    });
    emitClose(1);
    await runPromise;
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
  });

  it("a spawn throw yields only our line, exit-safe", async () => {
    const writes: string[] = [];
    await runStatuslineFast(["--wrap-id", encodeWrappedCommand("their-status")], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => {
        throw new Error("ENOENT");
      },
      now: () => NOW,
    });
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
  });

  it("a hung wrapped command times out to only our line, killing the child with SIGKILL", async () => {
    const { child, killCalls } = fakeWrapChild(); // never emits close
    const writes: string[] = [];
    await runStatuslineFast(["--wrap-id", encodeWrappedCommand("sleep 999")], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => child,
      wrapTimeoutMs: 15,
      now: () => NOW,
    });
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
    expect(killCalls).toEqual(["SIGKILL"]);
  });

  it("stdin text reaches the wrapped command byte-for-byte", async () => {
    const { child, stdinChunks, emitClose } = fakeWrapChild();
    const stdinPayload = JSON.stringify({ session_id: "abc-123", cost: { total_cost_usd: 1 } });
    const runPromise = runStatuslineFast(["--wrap-id", encodeWrappedCommand("their-status")], {
      home,
      read: () => stdinPayload,
      write: () => {},
      spawnImpl: () => child,
      now: () => NOW,
    });
    emitClose(0);
    await runPromise;
    expect(stdinChunks.join("")).toBe(stdinPayload);
  });

  it("an empty wrap-id (undecodable to a real command) skips wrapping entirely — our line only, spawn never called", async () => {
    let spawnCalled = false;
    const writes: string[] = [];
    await runStatuslineFast(["--wrap-id", ""], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error("should not be called");
      },
      now: () => NOW,
    });
    expect(spawnCalled).toBe(false);
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
  });

  it("parseStatuslineArgs: no --wrap-id anywhere in argv returns a bare {} — no wrapId key at all", () => {
    expect(parseStatuslineArgs(["--some-other-flag"])).toStrictEqual({});
  });

  it("parseStatuslineArgs: --wrap-id NOT at argv[0] still finds it, returning the following element", () => {
    expect(parseStatuslineArgs(["--unrelated", "--wrap-id", "abc123"])).toEqual({ wrapId: "abc123" });
  });

  it("a missing --wrap-id value runs the plain (non-wrap) path", async () => {
    expect(parseStatuslineArgs(["--wrap-id"])).toEqual({ wrapId: undefined });
    const writes: string[] = [];
    await runStatuslineFast(["--wrap-id"], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      now: () => NOW,
    });
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
  });

  it("a wrap-id of all-invalid-base64 characters (non-empty, decodes to '') also skips the spawn attempt", async () => {
    let spawnCalled = false;
    const writes: string[] = [];
    // "!!!" is non-empty (passes the outer wrapId check) but every character
    // is outside the base64 alphabet, so Buffer.from(..., "base64") decodes
    // it to an empty string — the inner falsy-original check must still catch it.
    await runStatuslineFast(["--wrap-id", "!!!"], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error("should not be called");
      },
      now: () => NOW,
    });
    expect(spawnCalled).toBe(false);
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
  });

  it("a clean exit 0 with EMPTY wrapped stdout writes only our line — no blank extra line", async () => {
    const { child, emitClose } = fakeWrapChild();
    const writes: string[] = [];
    const runPromise = runStatuslineFast(["--wrap-id", encodeWrappedCommand("their-status")], {
      home,
      read: () => JSON.stringify({}),
      write: (s) => writes.push(s),
      spawnImpl: () => child,
      now: () => NOW,
    });
    emitClose(0); // no stdout data emitted — theirOutput resolves to ""
    await runPromise;
    expect(writes).toEqual([`⬢ OL  ${DOCTOR_HINT}\n`]);
  });
});

describe("zero network calls", () => {
  it("a full run with fresh state AND a real wrap spawn makes no outbound TCP connections", async () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(statuslineStatePath(home), JSON.stringify(freshState()));
    const spy = vi.spyOn(Socket.prototype, "connect");
    try {
      const writes: string[] = [];
      await runStatuslineFast(["--wrap-id", encodeWrappedCommand("cat >/dev/null; echo hi")], {
        home,
        read: () => JSON.stringify({ cost: { total_cost_usd: 3 } }),
        write: (s) => writes.push(s),
        now: () => NOW,
      });
      expect(writes.join("")).toContain("hi\n");
      expect(writes.join("")).toContain("$3.00 session");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("StatuslineState / StatuslineStateFile type parity", () => {
  it("is structurally assignable in both directions — drift here fails typecheck, not this assertion", () => {
    const a: StatuslineState = {} as StatuslineStateFile;
    const b: StatuslineStateFile = {} as StatuslineState;
    expect(a).toEqual(b);
  });
});
