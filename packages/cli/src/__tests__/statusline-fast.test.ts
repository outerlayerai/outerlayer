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
    today: { date: localDateString(NOW), byAgent: { "claude-code": 21.1, codex: 1.8, cursor: 0.5 } },
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
    const yesterday = freshState({ today: { date: "2026-08-10", byAgent: { "claude-code": 5 } } });
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

  it("singular '1 agent' for exactly one agent with cost > 0", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 4.5, codex: 0 } } });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $4.50 today across 1 agent${SEP}12 unsynced`);
  });

  it("zero-cost agents are excluded from both the total and the agent count", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 0, codex: 0 } } });
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

  it("today total >= $100 also renders rounded with thousands separators", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: { "claude-code": 5000 } }, unsynced: 0 });
    const line = renderStatusline({}, state, NOW);
    expect(line).toBe(`⬢ OL  $5,000 today across 1 agent`);
  });

  it("a non-numeric or NaN cost is treated as absent, not as $0.00", () => {
    const line1 = renderStatusline({ cost: { total_cost_usd: Number.NaN } }, null, NOW);
    expect(line1).toBe(`⬢ OL  ${DOCTOR_HINT}`);
    const line2 = renderStatusline({ cost: {} }, null, NOW);
    expect(line2).toBe(`⬢ OL  ${DOCTOR_HINT}`);
  });

  it("bare prefix with no segments at all when fresh state carries nothing to show", () => {
    const state = freshState({ today: { date: localDateString(NOW), byAgent: {} }, unsynced: 0 });
    expect(renderStatusline({}, state, NOW)).toBe("⬢ OL");
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

  it("resolves null on a child 'error' event", async () => {
    const { child, emitError } = fakeWrapChild();
    const promise = runWrappedStatusline("original-cmd", "", { spawnImpl: () => child });
    emitError(new Error("spawn EACCES"));
    await expect(promise).resolves.toBeNull();
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
