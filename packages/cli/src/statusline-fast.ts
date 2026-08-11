// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The status-line fast path. Claude Code runs the statusLine command on
 * every state change (debounced ~300ms), so this shares hook-fast.ts's
 * doctrine:
 *
 *   - no transcript parsing, no network, no capture package, no commander —
 *     dispatched from index.ts BEFORE any heavy import; this file and its
 *     `settings.js` import touch only node builtins,
 *   - inputs are one stdin JSON payload + one small state file the watch
 *     daemon maintains (~/.outerlayer/statusline.json),
 *   - ALWAYS exit 0 and always print SOMETHING — a crash or empty output
 *     here blanks the user's status line on every refresh.
 *
 * Wrap mode (`--wrap-id <b64>`) exists for an occupied statusLine slot: run
 * the user's original command with our stdin piped through, print its output
 * verbatim, append our line as an additional line. Its failure, hang, or
 * absence must never suppress our line — unlike hook-wrap, nothing here
 * parses the wrapped command's output or propagates its exit code, so a
 * hard timeout of our own is safe and necessary (Claude Code has no timeout
 * for statusLine commands; a wedged one would freeze every refresh).
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeWrappedCommand } from "./settings.js";

/** State older than this renders degraded. Comfortably above the daemon's
 * 10-minute rescan cadence, so one slow sweep doesn't flap the line. */
export const STATE_FRESH_MS = 15 * 60 * 1000;

/** A wrapped statusline command gets this long, total, before we print
 * without it. Generous vs the ~300ms refresh cadence, small vs a hang. */
export const WRAP_TIMEOUT_MS = 750;

export function statuslineStatePath(home = homedir()): string {
  return join(home, ".outerlayer", "statusline.json");
}

/** The slice of Claude Code's status-line stdin payload we read. Every
 * field optional: the payload varies across Claude Code versions and an
 * absent field must degrade a segment, never the line. */
export interface StatuslineStdin {
  session_id?: string;
  model?: { display_name?: string };
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number };
}

/**
 * The daemon-maintained state file. Structurally duplicated from
 * `@outerlayer/capture`'s writer on purpose — importing it would drag the
 * capture package onto the 300ms path. A type-parity test pins the two
 * shapes against each other.
 */
export interface StatuslineStateFile {
  v: 1;
  /** ISO timestamp of the last recompute — the freshness gate. */
  generatedAt: string;
  /** Local calendar day the totals were computed for (YYYY-MM-DD). A fresh
   * file from yesterday must not show yesterday's spend as today's.
   * `sessionCount` is top-level sessions with spend today (subagent
   * transcripts sum into `byAgent` but are not counted). */
  today: { date: string; byAgent: Record<string, number>; sessionCount: number };
  sessions: Record<string, { costUsd: number }>;
  /** Absent when cloud sync was never configured. */
  unsynced?: number;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

/** Local calendar day (YYYY-MM-DD) for a ms timestamp — matches the day the
 * daemon computes totals for on the same machine. */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtUsd(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

export function parseStatuslineStdin(text: string): StatuslineStdin {
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" ? (parsed as StatuslineStdin) : {};
  } catch {
    return {};
  }
}

/** Never-throw state read; corrupt or shape-mismatched === absent. */
export function readStatuslineState(home = homedir()): StatuslineStateFile | null {
  try {
    const parsed = JSON.parse(readFileSync(statuslineStatePath(home), "utf8")) as StatuslineStateFile;
    if (!parsed || parsed.v !== 1 || typeof parsed.generatedAt !== "string") return null;
    if (!parsed.today || typeof parsed.today.date !== "string" || typeof parsed.today.byAgent !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function stateFresh(state: StatuslineStateFile, now: number): boolean {
  const generated = Date.parse(state.generatedAt);
  return Number.isFinite(generated) && now - generated <= STATE_FRESH_MS;
}

/**
 * Line v1: `⬢ OL  $0.87 session · $23.40 today across 3 agents · 12 unsynced`
 *
 * Session cost comes ONLY from stdin so it always matches Claude Code's own
 * cost display; the cross-agent segments come only from fresh daemon state.
 * Missing/stale state degrades to the session segment plus a dim
 * `outerlayer doctor` hint (doctor explains how to start the daemon).
 */
export function renderStatusline(stdin: StatuslineStdin, state: StatuslineStateFile | null, now: number): string {
  const segments: string[] = [];

  const sessionCost = stdin.cost?.total_cost_usd;
  // Number.isFinite (unlike the global isFinite) never coerces, so it is
  // already false for every non-number value — a separate `typeof` check
  // would be redundant.
  if (Number.isFinite(sessionCost)) {
    segments.push(`${fmtUsd(sessionCost as number)} session`);
  }

  const fresh = state !== null && stateFresh(state, now);
  if (fresh && state.today.date === localDateString(now)) {
    const costs = Object.values(state.today.byAgent).filter((c) => typeof c === "number" && c > 0);
    if (costs.length > 0) {
      const total = costs.reduce((sum, c) => sum + c, 0);
      // "across N agents" is the cross-agent pitch — shown only when it is
      // actually true. A one-agent day falls back to the session count,
      // which is the honest scope of the aggregation; a one-session day
      // needs no scope at all.
      const sessionCount = state.today.sessionCount;
      const scope =
        costs.length >= 2
          ? ` across ${costs.length} agents`
          : typeof sessionCount === "number" && sessionCount >= 2
            ? ` across ${sessionCount} sessions`
            : "";
      segments.push(`${fmtUsd(total)} today${scope}`);
    }
  }
  if (fresh && typeof state.unsynced === "number" && state.unsynced > 0) {
    segments.push(`${state.unsynced} unsynced`);
  }
  if (!fresh) {
    segments.push(dim("outerlayer doctor"));
  }

  const prefix = "⬢ OL";
  return segments.length === 0 ? prefix : `${prefix}  ${segments.join(dim(" · "))}`;
}

type StdinReader = () => string;

const readStdin: StdinReader = () => {
  // A TTY fd 0 (manual invocation, nothing piped) would block forever.
  try {
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

/** Minimal child surface — same shape as hook-wrap-fast's, narrowed to what
 * wrap mode needs (stdout collection + kill). */
export interface WrapChild {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type WrapSpawnFn = (command: string, args: string[]) => WrapChild;

const spawnWrapped: WrapSpawnFn = (command, args) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] }) as unknown as WrapChild;

/** Runs the wrapped command to completion or timeout. Resolves to its stdout
 * on a clean exit 0, null on ANY failure — the caller prints our line alone. */
export function runWrappedStatusline(
  original: string,
  stdinText: string,
  opts: { spawnImpl?: WrapSpawnFn; timeoutMs?: number } = {},
): Promise<string | null> {
  const spawnImpl = opts.spawnImpl ?? spawnWrapped;
  const timeoutMs = opts.timeoutMs ?? WRAP_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child: WrapChild;
    try {
      child = spawnImpl("/bin/sh", ["-c", original]);
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    // A settled Promise silently ignores every resolve() after the first, so
    // this latch guards `clearTimeout` re-entrance rather than the resolution
    // itself — relevant when the child fires more than one terminal event
    // (e.g. 'close' after a kill-triggered 'error').
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort — finish regardless
      }
      finish(null);
    }, timeoutMs);
    try {
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.stdin?.on("error", () => {});
      child.stdin?.write(stdinText);
      child.stdin?.end();
    } catch {
      // a command that never reads stdin still gets to print
    }
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
  });
}

/** Parses `outerlayer statusline`'s own argv. Hand-rolled, not commander —
 * this path must stay import-light like hook-fast.ts. */
export function parseStatuslineArgs(args: string[]): { wrapId?: string } {
  const idx = args.indexOf("--wrap-id");
  return idx === -1 ? {} : { wrapId: args[idx + 1] };
}

export interface RunStatuslineOptions {
  home?: string;
  read?: StdinReader;
  write?: (s: string) => void;
  spawnImpl?: WrapSpawnFn;
  now?: () => number;
  wrapTimeoutMs?: number;
}

/** Run the fast path. Never throws; the caller always exits 0. */
export async function runStatuslineFast(args: string[], opts: RunStatuslineOptions = {}): Promise<void> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  try {
    const home = opts.home ?? homedir();
    const now = (opts.now ?? Date.now)();
    const stdinText = (opts.read ?? readStdin)();
    const stdin = parseStatuslineStdin(stdinText);
    const state = readStatuslineState(home);
    const ourLine = renderStatusline(stdin, state, now);

    const { wrapId } = parseStatuslineArgs(args);
    // Defense in depth, not just narrowing: even a missing/empty wrapId that
    // somehow reached decodeWrappedCommand would come back null or "" and be
    // caught by the `original` check below just the same.
    if (wrapId) {
      let original: string | null = null;
      try {
        original = decodeWrappedCommand(wrapId);
      } catch {
        original = null;
      }
      if (original) {
        const theirOutput = await runWrappedStatusline(original, stdinText, {
          spawnImpl: opts.spawnImpl,
          timeoutMs: opts.wrapTimeoutMs,
        });
        if (theirOutput !== null && theirOutput.length > 0) {
          write(theirOutput.replace(/\n$/, "") + "\n");
        }
      }
    }
    write(ourLine + "\n");
  } catch {
    // Last resort: still print the brand mark — never a blank line, never a throw.
    try {
      write("⬢ OL\n");
    } catch {
      // give up silently
    }
  }
}
