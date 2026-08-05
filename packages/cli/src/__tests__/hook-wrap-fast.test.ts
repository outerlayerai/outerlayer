// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHookWrapFast,
  parseHookWrapArgs,
  hookWrapStdio,
  makeTailCollector,
  installAbortForwarding,
  spoolDir,
  hookExecSpoolPath,
  type SpawnedChild,
  type SpawnFn,
  type SpoolWriter,
  type AbortSource,
} from "../hook-wrap-fast.js";
import { encodeWrappedCommand } from "../settings.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-hookwrap-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A fake child process: `on("close", …)` fires on the next tick with
 * whatever exit info the test asks for, and stdin writes land in a plain
 * array instead of a real pipe. */
function fakeChild(exit: { code: number | null; signal?: NodeJS.Signals | null } = { code: 0 }): {
  child: SpawnedChild;
  stdinChunks: Buffer[];
  stdout: EventEmitter;
  stderr: EventEmitter;
  killCalls: Array<NodeJS.Signals | undefined>;
} {
  const emitter = new EventEmitter();
  const stdinChunks: Buffer[] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killCalls: Array<NodeJS.Signals | undefined> = [];
  const child = {
    stdin: Object.assign(new EventEmitter(), {
      write: (chunk: Buffer) => {
        stdinChunks.push(Buffer.from(chunk));
        return true;
      },
      end: () => {},
    }),
    stdout,
    stderr,
    on: emitter.on.bind(emitter),
    kill: (signal?: NodeJS.Signals) => {
      killCalls.push(signal);
      return true;
    },
  } as unknown as SpawnedChild;
  setImmediate(() => emitter.emit("close", exit.code, exit.signal ?? null));
  return { child, stdinChunks, stdout, stderr, killCalls };
}

/** A fake `process`: real signal names, but emitting them here never touches
 * the actual test process — `runHookWrapFast` defaults to real `process`
 * only when `opts.proc` is omitted, which no test below relies on. */
function fakeProc(): { proc: AbortSource; emitter: EventEmitter; killCalls: Array<[number, NodeJS.Signals | undefined]> } {
  const emitter = new EventEmitter();
  const killCalls: Array<[number, NodeJS.Signals | undefined]> = [];
  const proc: AbortSource = {
    once: (event, listener) => emitter.once(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
    pid: 9999,
    kill: (pid, signal) => {
      killCalls.push([pid, signal]);
      return true;
    },
  };
  return { proc, emitter, killCalls };
}

function idFor(command: string): string {
  return encodeWrappedCommand(command);
}

describe("runHookWrapFast", () => {
  it("propagates the child's exit code — including 2 (BLOCK), not hook-fast's always-0", async () => {
    const { child } = fakeChild({ code: 2 });
    const spawnImpl: SpawnFn = () => child;
    const code = await runHookWrapFast(idFor("exit 2"), { home, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    expect(code).toBe(2);
  });

  it("delivers stdin bytes to the child verbatim", async () => {
    const { child, stdinChunks } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const payload = Buffer.from(JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse" }));
    await runHookWrapFast(idFor("cat"), {
      home,
      spawnImpl,
      spool: () => {},
      read: () => payload,
      proc: fakeProc().proc,
    });
    expect(Buffer.concat(stdinChunks)).toEqual(payload);
  });

  it("writes the spool `started` record BEFORE spawning the child", async () => {
    const order: string[] = [];
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => {
      order.push("spawn");
      return child;
    };
    const spool = (record: Record<string, unknown>) => order.push(`spool:${record.rec as string}`);
    await runHookWrapFast(idFor("true"), { home, spawnImpl, spool, proc: fakeProc().proc });
    // A post-spawn write would put "spawn" first — the record is worthless
    // for a hang or SIGKILL unless it lands before the child even starts.
    expect(order).toEqual(["spool:started", "spawn", "spool:finished"]);
  });

  it("on spawn failure, exits 0 and writes no `finished` record", async () => {
    const calls: Record<string, unknown>[] = [];
    const spawnImpl: SpawnFn = () => {
      throw new Error("ENOENT: no such file /bin/sh");
    };
    const code = await runHookWrapFast(idFor("whatever"), {
      home,
      spawnImpl,
      spool: (r) => calls.push(r),
      proc: fakeProc().proc,
    });
    expect(code).toBe(0);
    expect(calls.map((r) => r.rec)).toEqual(["started"]);
  });

  it("returns 0 without spawning when --id is missing", async () => {
    let spawnCalled = false;
    const spawnImpl: SpawnFn = () => {
      spawnCalled = true;
      throw new Error("should not be called");
    };
    const code = await runHookWrapFast(undefined, { home, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    expect(code).toBe(0);
    expect(spawnCalled).toBe(false);
  });

  it("captures a bounded stdout/stderr tail only when capture is on", async () => {
    const { child, stdout, stderr } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const records: Record<string, unknown>[] = [];
    const runPromise = runHookWrapFast(idFor("echo hi"), {
      home,
      spawnImpl,
      spool: (r) => records.push(r),
      captureOutput: true,
      proc: fakeProc().proc,
    });
    stdout.emit("data", Buffer.from("hello "));
    stdout.emit("data", Buffer.from("world"));
    stderr.emit("data", Buffer.from("uh oh"));
    await runPromise;
    const finished = records.find((r) => r.rec === "finished")!;
    expect(finished.stdoutTail).toBe("hello world");
    expect(finished.stderrTail).toBe("uh oh");
  });

  it("omits output tails entirely when capture is off (the default)", async () => {
    const { child, stdout } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const records: Record<string, unknown>[] = [];
    const runPromise = runHookWrapFast(idFor("echo hi"), {
      home,
      spawnImpl,
      spool: (r) => records.push(r),
      proc: fakeProc().proc,
    });
    stdout.emit("data", Buffer.from("should be ignored"));
    await runPromise;
    const finished = records.find((r) => r.rec === "finished")!;
    expect("stdoutTail" in finished).toBe(false);
  });

  it("actually appends to the spool file on disk (not just the injected seam)", async () => {
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    await runHookWrapFast(idFor("true"), { home, spawnImpl, proc: fakeProc().proc });
    expect(existsSync(hookExecSpoolPath(home))).toBe(true);
    const lines = readFileSync(hookExecSpoolPath(home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).rec).toBe("started");
    expect(JSON.parse(lines[1]!).rec).toBe("finished");
  });

  it("spoolDir is namespaced under the given home", () => {
    expect(spoolDir(home)).toBe(join(home, ".outerlayer", "spool"));
  });

  it("stops listening for abort signals once the child exits on its own", async () => {
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const { proc, emitter, killCalls } = fakeProc();
    const records: Record<string, unknown>[] = [];
    await runHookWrapFast(idFor("true"), { home, spawnImpl, spool: (r) => records.push(r), proc });
    // The child already finished normally; a signal now has nothing left to
    // forward to and must not append a stray `aborted` record.
    emitter.emit("SIGTERM", "SIGTERM");
    expect(killCalls).toEqual([]);
    expect(records.map((r) => r.rec)).toEqual(["started", "finished"]);
  });

  it("uses a real child_process.spawn when no spawnImpl is injected", async () => {
    // No spawnImpl — exercises the actual default spawner. "exit 3" is
    // harmless and deterministic; if the default spawner silently no-op'd
    // (or spawned the wrong thing) this would not come back as 3.
    const code = await runHookWrapFast(idFor("exit 3"), { home, spool: () => {}, proc: fakeProc().proc });
    expect(code).toBe(3);
  });

  it("defaults to the real process for abort forwarding when opts.proc is omitted", async () => {
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const before = process.listenerCount("SIGTERM");
    // No `proc` — runHookWrapFast runs synchronously up to its first await
    // (the child-close promise), so by the time this call RETURNS its
    // promise, the abort-forwarding install (or its absence) has already
    // happened on the real `process` object.
    const promise = runHookWrapFast(idFor("true"), { home, spawnImpl, spool: () => {} });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await promise;
    // Cleaned up once the child closed normally — no listener left behind.
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("logError creates the spool dir (even nested) and appends across calls rather than overwriting", async () => {
    const nestedHome = join(home, "nested", "deeper");
    const spawnImpl: SpawnFn = () => {
      throw new Error("should not be called — --id is missing before spawn is ever reached");
    };
    // Missing --id logs to hook-errors.log without spawning.
    await runHookWrapFast(undefined, { home: nestedHome, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    await runHookWrapFast(undefined, { home: nestedHome, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    const logPath = join(spoolDir(nestedHome), "hook-errors.log");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("carries session_id/hook_event_name/tool_use_id/tool_name from the payload into the started record", async () => {
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const records: Record<string, unknown>[] = [];
    const payload = Buffer.from(
      JSON.stringify({ session_id: "sess-77", hook_event_name: "PostToolUse", tool_use_id: "toolu_42", tool_name: "Edit" }),
    );
    await runHookWrapFast(idFor("true"), {
      home,
      spawnImpl,
      spool: (r) => records.push(r),
      read: () => payload,
      proc: fakeProc().proc,
    });
    const started = records.find((r) => r.rec === "started")!;
    expect(started).toMatchObject({
      sessionId: "sess-77",
      hookEvent: "PostToolUse",
      toolUseId: "toolu_42",
      toolName: "Edit",
    });
  });

  it("truncates the recorded command to MAX_CMD_LEN, even though the full command still runs", async () => {
    const longCmd = "echo " + "x".repeat(400);
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const records: Record<string, unknown>[] = [];
    await runHookWrapFast(idFor(longCmd), { home, spawnImpl, spool: (r) => records.push(r), proc: fakeProc().proc });
    const started = records.find((r) => r.rec === "started")!;
    expect(started.cmd).toBe(longCmd.slice(0, 300));
    expect((started.cmd as string).length).toBe(300);
  });

  it("spawns /bin/sh with exactly [-c, <original command>]", async () => {
    let capturedCommand: string | undefined;
    let capturedArgs: string[] | undefined;
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return child;
    };
    await runHookWrapFast(idFor("echo test"), { home, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    expect(capturedCommand).toBe("/bin/sh");
    expect(capturedArgs).toEqual(["-c", "echo test"]);
  });

  it("never throws when the child has no stdin/stdout/stderr streams at all", async () => {
    const emitter = new EventEmitter();
    const child = {
      stdin: null,
      stdout: null,
      stderr: null,
      on: emitter.on.bind(emitter),
      kill: () => true,
    } as unknown as SpawnedChild;
    const spawnImpl: SpawnFn = () => child;
    setImmediate(() => emitter.emit("close", 0, null));
    const code = await runHookWrapFast(idFor("true"), {
      home,
      spawnImpl,
      spool: () => {},
      captureOutput: true,
      proc: fakeProc().proc,
    });
    expect(code).toBe(0);
  });

  it("resolves on a child 'error' event (spawn succeeded but the process errored) rather than hanging forever", async () => {
    const emitter = new EventEmitter();
    const child = {
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => {} }),
      stdout: null,
      stderr: null,
      on: emitter.on.bind(emitter),
      kill: () => true,
    } as unknown as SpawnedChild;
    const spawnImpl: SpawnFn = () => child;
    setImmediate(() => emitter.emit("error", new Error("spawn EACCES")));
    const code = await runHookWrapFast(idFor("true"), { home, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    expect(code).toBe(1);
  });

  it("survives an async EPIPE on stdin from a child that exits without reading it", async () => {
    const emitter = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), {
      // A real pipe delivers EPIPE as a later-tick 'error' event, never as a
      // throw from write() itself.
      write: () => {
        process.nextTick(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
        return false;
      },
      end: () => {},
    });
    const child = {
      stdin,
      stdout: null,
      stderr: null,
      on: emitter.on.bind(emitter),
      kill: () => true,
    } as unknown as SpawnedChild;
    const spawnImpl: SpawnFn = () => child;
    setImmediate(() => emitter.emit("close", 3, null));
    const code = await runHookWrapFast(idFor("exit 3"), { home, spawnImpl, spool: () => {}, proc: fakeProc().proc });
    expect(code).toBe(3);
  });

  it("omits a real signal value on the finished record for a normal (unsignaled) exit", async () => {
    const { child } = fakeChild({ code: 0, signal: null });
    const spawnImpl: SpawnFn = () => child;
    const records: Record<string, unknown>[] = [];
    await runHookWrapFast(idFor("true"), { home, spawnImpl, spool: (r) => records.push(r), proc: fakeProc().proc });
    const finished = records.find((r) => r.rec === "finished")!;
    expect(finished.signal).toBeUndefined();
  });

  it("computes the finished record's durationMs as end-time MINUS start-time, not plus", async () => {
    const { child } = fakeChild({ code: 0 });
    const spawnImpl: SpawnFn = () => child;
    const records: Record<string, unknown>[] = [];
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1450);
    await runHookWrapFast(idFor("true"), { home, spawnImpl, spool: (r) => records.push(r), now, proc: fakeProc().proc });
    const finished = records.find((r) => r.rec === "finished")!;
    expect(finished.durationMs).toBe(450);
  });
});

describe("installAbortForwarding", () => {
  it("forwards the signal to the child — an unforwarded kill would orphan it", () => {
    const { child, killCalls } = fakeChild();
    const { proc, emitter } = fakeProc();
    installAbortForwarding(child, () => {}, "exec-1", 1000, () => 1500, proc);
    emitter.emit("SIGTERM", "SIGTERM");
    expect(killCalls).toEqual(["SIGTERM"]);
  });

  it("writes an aborted record with the signal and a lower-bound duration", () => {
    const { child } = fakeChild();
    const records: Record<string, unknown>[] = [];
    const { proc, emitter } = fakeProc();
    installAbortForwarding(child, (r) => records.push(r), "exec-2", 1000, () => 1750, proc);
    emitter.emit("SIGINT", "SIGINT");
    expect(records).toEqual([{ rec: "aborted", execId: "exec-2", durationMs: 750, signal: "SIGINT" }]);
  });

  it("re-raises the signal against our own process so our exit status stays truthful", () => {
    const { child } = fakeChild();
    const { proc, emitter, killCalls } = fakeProc();
    installAbortForwarding(child, () => {}, "exec-3", 1000, () => 1200, proc);
    emitter.emit("SIGTERM", "SIGTERM");
    expect(killCalls).toEqual([[9999, "SIGTERM"]]);
  });

  it("a throwing spool write does not prevent forwarding or the re-raise", () => {
    const { child, killCalls: childKillCalls } = fakeChild();
    const { proc, emitter, killCalls } = fakeProc();
    const throwingSpool: SpoolWriter = () => {
      throw new Error("disk full");
    };
    installAbortForwarding(child, throwingSpool, "exec-4", 1000, () => 1300, proc);
    emitter.emit("SIGTERM", "SIGTERM");
    expect(childKillCalls).toEqual(["SIGTERM"]);
    expect(killCalls).toEqual([[9999, "SIGTERM"]]);
  });

  it("a throwing child.kill does not prevent the aborted record or the re-raise", () => {
    const child = {
      kill: () => {
        throw new Error("ESRCH: no such process");
      },
    } as unknown as SpawnedChild;
    const records: Record<string, unknown>[] = [];
    const { proc, emitter, killCalls } = fakeProc();
    installAbortForwarding(child, (r) => records.push(r), "exec-5", 1000, () => 1400, proc);
    emitter.emit("SIGTERM", "SIGTERM");
    expect(records).toEqual([{ rec: "aborted", execId: "exec-5", durationMs: 400, signal: "SIGTERM" }]);
    expect(killCalls).toEqual([[9999, "SIGTERM"]]);
  });

  it("handles each signal at most once — a repeat signal after cleanup is a no-op", () => {
    const { child, killCalls } = fakeChild();
    const { proc, emitter } = fakeProc();
    installAbortForwarding(child, () => {}, "exec-6", 1000, () => 1100, proc);
    emitter.emit("SIGTERM", "SIGTERM");
    emitter.emit("SIGTERM", "SIGTERM");
    expect(killCalls).toEqual(["SIGTERM"]);
  });

  it("cleanup() removes both signal listeners before any signal fires", () => {
    const { child, killCalls } = fakeChild();
    const { proc, emitter } = fakeProc();
    const cleanup = installAbortForwarding(child, () => {}, "exec-7", 1000, () => 1100, proc);
    cleanup();
    emitter.emit("SIGTERM", "SIGTERM");
    emitter.emit("SIGINT", "SIGINT");
    expect(killCalls).toEqual([]);
  });
});

describe("hookWrapStdio", () => {
  it("capture off is a bare inherit — zero interception of the hook's own stdout/stderr", () => {
    expect(hookWrapStdio(false)).toEqual(["pipe", "inherit", "inherit"]);
  });

  it("capture on pipes stdout/stderr so a tail can be collected", () => {
    expect(hookWrapStdio(true)).toEqual(["pipe", "pipe", "pipe"]);
  });
});

describe("makeTailCollector", () => {
  it("truncates to exactly the configured max, keeping the trailing bytes", () => {
    const collector = makeTailCollector(10);
    collector.push(Buffer.from("0123456789ABCDEF")); // 16 bytes, over the 10-byte cap
    expect(collector.value()).toBe("6789ABCDEF");
  });

  it("truncates to exactly 4096 bytes by default", () => {
    const collector = makeTailCollector();
    collector.push(Buffer.from("a".repeat(5000)));
    collector.push(Buffer.from("b".repeat(50)));
    const value = collector.value();
    expect(value).toHaveLength(4096);
    expect(value.endsWith("b".repeat(50))).toBe(true);
  });

  it("never truncates output shorter than the max", () => {
    const collector = makeTailCollector(4096);
    collector.push(Buffer.from("short"));
    expect(collector.value()).toBe("short");
  });
});

describe("parseHookWrapArgs", () => {
  it("parses --id and --capture-output", () => {
    expect(parseHookWrapArgs(["--id", "abc123", "--capture-output"])).toEqual({
      id: "abc123",
      captureOutput: true,
    });
  });

  it("defaults captureOutput to false and id to undefined", () => {
    expect(parseHookWrapArgs([])).toEqual({ id: undefined, captureOutput: false });
  });

  it("an unrelated argument never flips captureOutput on", () => {
    expect(parseHookWrapArgs(["--some-other-flag"])).toEqual({ id: undefined, captureOutput: false });
  });
});
