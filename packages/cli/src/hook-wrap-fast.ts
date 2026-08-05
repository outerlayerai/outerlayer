// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The hook-wrap execution path. `outerlayer hook-wrap --id <b64>` is what a
 * hook command becomes after `hooks wrap` rewrites it: it runs the ORIGINAL
 * command as a child process and appends write-ahead timing/exit evidence
 * to a spool file, so a hang or a SIGKILL-on-timeout still leaves a record.
 * Claude Code times and reports only `Stop` hooks; Pre/PostToolUse hooks
 * that hang leave nothing at all without this.
 *
 * DELIBERATE departure from hook-fast.ts's doctrine, documented so it does
 * not get "fixed" back: hook-fast.ts always exits 0 because it never runs
 * anyone else's code. This file runs the CALLER's hook and must propagate
 * that hook's exit code and stdout verbatim — swallowing either would
 * silently break every blocking hook (exit 2 means BLOCK) and every
 * PreToolUse permission decision (JSON on stdout that Claude Code parses).
 * "Never disrupt Claude Code" for a wrapper means faithful propagation, not
 * always-0.
 *
 * Every wrapper-internal step (stdin read, id decode, spool writes, tail
 * capture) is individually try/caught — bookkeeping must never block the
 * wrapped hook. The only UNGUARDED obligations: spawn the child, pipe its
 * stdin, and propagate its exit. If spawn itself fails, this exits 0 (never
 * 2, never a throw) — surfacing OUR failure as the user's hook failure would
 * be worse than silently not running it.
 *
 * No timeout of our own: Claude Code already owns hook timeouts, and a
 * second timer here would be a second way to kill a user's hook.
 *
 * Dispatched from index.ts before any heavy import, same as hook-fast.ts:
 * this file and its `settings.js` import touch only node builtins.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeWrappedCommand } from "./settings.js";

export function spoolDir(home = homedir()): string {
  return join(home, ".outerlayer", "spool");
}

export function hookExecSpoolPath(home = homedir()): string {
  return join(spoolDir(home), "hook-exec.jsonl");
}

/** Commands are truncated before landing in the spool — bounded, and a
 * `cmdSha` alongside carries the full identity for exact matching. */
const MAX_CMD_LEN = 300;

/** Output tails are bounded independently of the command truncation above —
 * this is captured process output, not a command string. */
const MAX_TAIL_BYTES = 4096;

/** Reads the hook JSON payload as raw bytes (not text) so it can be
 * forwarded to the child byte-for-byte. Injectable for tests. */
type StdinReader = () => Buffer;

const readStdin: StdinReader = () => {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
};

/** stdio config for the child: capture-off (default) is a bare `inherit` —
 * zero copy, zero reorder, zero interception risk for the permission-decision
 * JSON PreToolUse hooks write to stdout. Capture-on pipes so a bounded tail
 * can be collected, still forwarding every chunk to our own inherited
 * stdout/stderr immediately (tee, not divert). */
export type WrapStdio = ["pipe", "pipe" | "inherit", "pipe" | "inherit"];

export function hookWrapStdio(captureOutput: boolean): WrapStdio {
  return captureOutput ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"];
}

/** Minimal surface this file needs from a child process — matches
 * node:child_process's ChildProcess, kept narrow so tests can fake it
 * without a real spawn. */
export interface SpawnedChild {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Injectable spawner so tests never fork a real shell. */
export type SpawnFn = (command: string, args: string[], stdio: WrapStdio) => SpawnedChild;

const spawnChild: SpawnFn = (command, args, stdio) => spawn(command, args, { stdio }) as unknown as SpawnedChild;

/** Records one line to the spool. Swallows all errors: bookkeeping must
 * never block the wrapped hook. Injectable so tests can assert call ORDER
 * relative to the spawn seam. */
export type SpoolWriter = (record: Record<string, unknown>) => void;

function makeSpoolWriter(home: string): SpoolWriter {
  return (record) => {
    try {
      mkdirSync(spoolDir(home), { recursive: true });
      appendFileSync(hookExecSpoolPath(home), JSON.stringify(record) + "\n");
    } catch {
      // never block the wrapped hook over bookkeeping
    }
  };
}

function logError(home: string, err: unknown): void {
  try {
    mkdirSync(spoolDir(home), { recursive: true });
    writeFileSync(
      join(spoolDir(home), "hook-errors.log"),
      `${new Date().toISOString()} ${err instanceof Error ? err.message : String(err)}\n`,
      { flag: "a" },
    );
  } catch {
    // give up silently — never disrupt Claude Code
  }
}

interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_use_id?: string;
  tool_name?: string;
}

function parsePayload(bytes: Buffer): HookPayload {
  try {
    if (bytes.length === 0) return {};
    return JSON.parse(bytes.toString("utf8")) as HookPayload;
  } catch {
    return {};
  }
}

/** Collects the last `max` bytes seen across any number of chunks, without
 * ever holding more than `max` bytes at rest. */
export function makeTailCollector(max = MAX_TAIL_BYTES): { push(chunk: Buffer): void; value(): string } {
  let buf = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > max) buf = buf.subarray(buf.length - max);
    },
    value: () => buf.toString("utf8"),
  };
}

// ---------------------------------------------------------------------------
// SIGTERM/SIGINT forwarding
//
// Claude Code kills the wrapper at the hook's timeout. The child is a
// SEPARATE process — without forwarding, killing the wrapper leaves the
// child running, orphaned, still holding whatever it was doing against the
// repo. That would turn "Claude Code killed a slow hook" into "a stray
// process is still running unattended", which is the wrapper actively
// making the user's situation worse — the one thing the failure-mode
// contract above rules out. SIGKILL can't be caught here; write-ahead is
// what covers that case.
// ---------------------------------------------------------------------------

const ABORT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/** The slice of `process` this needs — real `process` satisfies it, and
 * tests supply a fake so this file never touches a real signal handler. */
export interface AbortSource {
  once(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  pid: number;
  kill(pid: number, signal?: NodeJS.Signals): boolean;
}

/**
 * Wires SIGTERM/SIGINT on `proc` to: forward to the child, best-effort
 * record `aborted`, then re-raise against `proc` itself so OUR exit status
 * stays truthful (we don't silently swallow the signal that killed us).
 * Recording is best-effort and ordered AFTER the forward but BEFORE the
 * re-raise, and a throw from either the forward or the record must not
 * prevent the other two steps — a hook still holding a lock or a temp file
 * needs the kill delivered regardless of whether bookkeeping succeeds.
 * Returns a cleanup function that removes the listeners (called once the
 * child exits on its own, so a signal after that has no effect).
 */
export function installAbortForwarding(
  child: SpawnedChild,
  spool: SpoolWriter,
  execId: string,
  startedAt: number,
  now: () => number,
  proc: AbortSource,
): () => void {
  const handlers: Array<[NodeJS.Signals, (signal: NodeJS.Signals) => void]> = [];
  const cleanup = () => {
    for (const [sig, handler] of handlers) proc.removeListener(sig, handler);
  };

  for (const sig of ABORT_SIGNALS) {
    const handler = (signal: NodeJS.Signals) => {
      cleanup(); // a second signal mid-handling re-triggers nothing
      try {
        child.kill(signal);
      } catch {
        // best effort — still record and re-raise below
      }
      try {
        spool({ rec: "aborted", execId, durationMs: now() - startedAt, signal });
      } catch {
        // bookkeeping must never block the forward or the re-raise
      }
      try {
        proc.kill(proc.pid, signal);
      } catch {
        // best effort
      }
    };
    handlers.push([sig, handler]);
    proc.once(sig, handler);
  }
  return cleanup;
}

export interface RunHookWrapOptions {
  home?: string;
  read?: StdinReader;
  spawnImpl?: SpawnFn;
  spool?: SpoolWriter;
  now?: () => number;
  captureOutput?: boolean;
  proc?: AbortSource;
}

/** Parses `outerlayer hook-wrap`'s own argv (everything after `hook-wrap`).
 * Deliberately hand-rolled, not commander — this path must stay import-light
 * like hook-fast.ts. */
export function parseHookWrapArgs(args: string[]): { id?: string; captureOutput: boolean } {
  let id: string | undefined;
  let captureOutput = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--id") id = args[++i];
    else if (args[i] === "--capture-output") captureOutput = true;
  }
  return { id, captureOutput };
}

/**
 * Runs the wrapped hook to completion and returns the exit code the CLI
 * should propagate. Never throws — every internal failure degrades to
 * "run the child anyway" or, if the child can't even be spawned, to exit 0.
 */
export async function runHookWrapFast(id: string | undefined, opts: RunHookWrapOptions = {}): Promise<number> {
  const home = opts.home ?? homedir();
  const read = opts.read ?? readStdin;
  const spawnImpl = opts.spawnImpl ?? spawnChild;
  const spool = opts.spool ?? makeSpoolWriter(home);
  const now = opts.now ?? Date.now;
  const captureOutput = opts.captureOutput ?? false;
  const proc = opts.proc ?? (process as unknown as AbortSource);

  if (!id) {
    logError(home, new Error("hook-wrap: missing --id"));
    return 0;
  }

  let original: string;
  try {
    original = decodeWrappedCommand(id);
  } catch (err) {
    logError(home, err);
    return 0;
  }

  let stdinBytes: Buffer;
  try {
    stdinBytes = read();
  } catch {
    stdinBytes = Buffer.alloc(0);
  }

  const payload = parsePayload(stdinBytes);
  const execId = randomUUID();
  const startedAt = now();

  // WRITE-AHEAD: this must land before the spawn call below. A hook that
  // hangs or is SIGKILLed never reaches the `finished` write, so a record
  // written only at the end would capture nothing for exactly the case that
  // motivates this file.
  try {
    spool({
      rec: "started",
      execId,
      t: new Date(startedAt).toISOString(),
      sessionId: payload.session_id ?? null,
      hookEvent: payload.hook_event_name ?? null,
      toolUseId: payload.tool_use_id ?? null,
      // Costs a few bytes; makes an orphaned started-only record
      // self-describing ("PostToolUse Edit hung" vs. a bare uuid).
      toolName: payload.tool_name ?? null,
      cmdSha: createHash("sha256").update(original).digest("hex"),
      cmd: original.slice(0, MAX_CMD_LEN),
      pid: process.pid,
    });
  } catch {
    // never block the child over bookkeeping
  }

  let child: SpawnedChild;
  try {
    child = spawnImpl("/bin/sh", ["-c", original], hookWrapStdio(captureOutput));
  } catch (err) {
    // Spawn failure (ENOENT, no `sh`, …): exit 0, never nonzero — surfacing
    // OUR failure as the user's hook failure is the worse outcome, and
    // exit 2 would block their tool call outright.
    logError(home, err);
    return 0;
  }

  try {
    // A child that exits without reading stdin surfaces EPIPE as a
    // later-tick 'error' event on the stream, outside this try/catch;
    // without a listener that event crashes the wrapper.
    child.stdin?.on("error", () => {});
    child.stdin?.write(stdinBytes);
    child.stdin?.end();
  } catch {
    // best-effort — a hook that never reads stdin shouldn't fail the run
  }

  const stdoutTail = makeTailCollector();
  const stderrTail = makeTailCollector();
  if (captureOutput) {
    try {
      child.stdout?.on("data", (chunk: Buffer) => stdoutTail.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));
    } catch {
      // capture is best-effort; the child still runs either way
    }
  }

  let stopAbortForwarding: () => void = () => {};
  try {
    stopAbortForwarding = installAbortForwarding(child, spool, execId, startedAt, now, proc);
  } catch {
    // best-effort — the hook still runs to completion without it
  }

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, sig) => resolve({ exitCode: code, signal: sig }));
      child.on("error", () => resolve({ exitCode: null, signal: null }));
    },
  );
  stopAbortForwarding(); // the child is done — a later signal has nothing left to forward to

  try {
    spool({
      rec: "finished",
      execId,
      durationMs: now() - startedAt,
      exitCode,
      signal: signal ?? undefined,
      ...(captureOutput ? { stdoutTail: stdoutTail.value(), stderrTail: stderrTail.value() } : {}),
    });
  } catch {
    // never block on bookkeeping
  }

  // Exit with the child's exit code. Exit 2 must stay exit 2 — Claude Code
  // treats it as a BLOCK decision for PreToolUse hooks.
  return exitCode ?? 1;
}
