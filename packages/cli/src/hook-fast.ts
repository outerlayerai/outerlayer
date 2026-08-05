// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The hook fast-path. Claude Code invokes `outerlayer hook <event>`
 * synchronously inside its own loop, so this must be BRUTALLY cheap:
 *
 *   - hard budget <50ms p95,
 *   - no network, no SQLite, no capture package, no commander — this file
 *     imports ONLY node builtins and is dispatched from index.ts BEFORE any
 *     heavy import is evaluated,
 *   - ALWAYS exit 0, even on internal failure (a nonzero exit or a thrown
 *     error could disrupt Claude Code — the one unforgivable failure). Errors
 *     are logged to a spool-adjacent file, never surfaced.
 *
 * It reads the hook JSON payload on stdin and appends one line to the spool
 * (`~/.outerlayer/spool/events.jsonl`). The daemon consumes the spool to know
 * which sessions to parse promptly; the transcript itself is the payload.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { assessSyncHealth, readSyncStatus } from "./sync-status.js";

export function spoolDir(home = homedir()): string {
  return join(home, ".outerlayer", "spool");
}

/** Reads the hook JSON payload. Default reads stdin (fd 0); injectable for
 * tests and benchmarks so no fd mocking is needed. */
export type StdinReader = () => string;

const readStdin: StdinReader = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

/** Debounce window for hook-triggered background sync. */
export const AUTO_SYNC_DEBOUNCE_MS = 5 * 60 * 1000;

/** Injectable spawner so tests never fork a real process. */
export type SpawnDetached = (command: string, args: string[]) => void;

const spawnDetached: SpawnDetached = (command, args) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
};

/**
 * Hook-triggered background sync: the dashboard is only as fresh as
 * the last MANUAL `outerlayer sync`, and everyone forgets to run it. On
 * SessionEnd/Stop, fire-and-forget `outerlayer sync --quiet` — detached,
 * output ignored, never awaited — debounced through a marker file so a busy
 * session doesn't stampede. Budget: the common path is ONE statSync (fresh
 * marker → return); the spawn path adds one small config read.
 *
 * Gated on cloud config being present AND `autoSync` not set to false in
 * ~/.outerlayer/config.json. Any error is swallowed: the hook contract
 * (always exit 0, never disrupt Claude Code) outranks syncing.
 */
export function maybeAutoSync(
  event: string,
  home = homedir(),
  spawnImpl: SpawnDetached = spawnDetached,
  now = Date.now(),
): void {
  try {
    if (event !== "SessionEnd" && event !== "Stop") return;
    const marker = join(spoolDir(home), "last-auto-sync");
    try {
      if (now - statSync(marker).mtimeMs < AUTO_SYNC_DEBOUNCE_MS) return;
    } catch {
      // no marker yet — proceed
    }
    const configPath = join(home, ".outerlayer", "config.json");
    if (!existsSync(configPath)) return;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      url?: string;
      apiKey?: string;
      appId?: string;
      autoSync?: boolean;
    };
    if (config.autoSync === false) return;
    if (!config.url || !config.apiKey || !config.appId) return;
    // Touch the marker BEFORE spawning: a crashed spawn just waits out one
    // debounce window instead of retry-stampeding every Stop event.
    writeFileSync(marker, String(now));
    // argv[1] is the CLI entry (dist/index.js) that dispatched this hook.
    spawnImpl(process.execPath, [process.argv[1]!, "sync", "--quiet"]);
  } catch {
    // never disrupt Claude Code
  }
}

/**
 * Surfaces a BROKEN sync at SessionStart.
 *
 * The background sync is deliberately silent, which means a dead endpoint or a
 * revoked key produces no signal at all until someone notices the dashboard
 * has stopped moving — in practice, days. SessionStart is the one moment we
 * can speak up for free, so a failing sync is reported here as
 * `additionalContext`: the assistant sees it and can raise it in-session,
 * which needs no UI and cannot be missed the way a log line can.
 *
 * Only hard FAILURES are reported. Staleness is deliberately excluded: "no
 * sync in 6h" is equally consistent with "wrote no code today", and a warning
 * that cries wolf on a quiet morning trains people to ignore the one that
 * matters. Staleness needs the pending-work signal that `doctor` and the
 * dashboard have and this budget cannot afford.
 *
 * Writes at most one small JSON object to stdout and never throws — an
 * unparseable hook response must not disrupt Claude Code.
 */
export function reportSyncHealth(event: string, home = homedir(), write: (s: string) => void = (s) => process.stdout.write(s)): void {
  try {
    if (event !== "SessionStart") return;
    // Absent config means the user never opted in — nothing to warn about.
    if (!existsSync(join(home, ".outerlayer", "config.json"))) return;
    const health = assessSyncHealth(readSyncStatus(home));
    if (health.level !== "error") return;
    const context = [`OuterLayer sync is failing on this machine: ${health.headline}`, ...health.details.map((d) => `  - ${d}`)].join("\n");
    write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      }),
    );
  } catch {
    // never disrupt Claude Code
  }
}

/** Run the fast path. `event` is argv[3] (e.g. SessionEnd). Never throws. */
export function runHookFast(event: string | undefined, home = homedir(), read: StdinReader = readStdin): void {
  try {
    const dir = spoolDir(home);
    mkdirSync(dir, { recursive: true });

    const stdin = read();

    let payload: Record<string, unknown> = {};
    try {
      payload = stdin ? (JSON.parse(stdin) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }

    // Keep only the small, useful fields — never the whole payload (bounded
    // spool). transcript_path is the pointer the daemon follows.
    const record = {
      t: new Date().toISOString(),
      event: event ?? payload.hook_event_name ?? "unknown",
      sessionId: payload.session_id ?? null,
      transcriptPath: payload.transcript_path ?? null,
      cwd: payload.cwd ?? null,
    };
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(record) + "\n");
    maybeAutoSync(String(record.event), home);
    reportSyncHealth(String(record.event), home);
  } catch (err) {
    // Last-resort: record to an error file, still exit 0.
    try {
      const dir = spoolDir(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "hook-errors.log"),
        `${new Date().toISOString()} ${err instanceof Error ? err.message : String(err)}\n`,
        { flag: "a" },
      );
    } catch {
      // give up silently — never disrupt Claude Code
    }
  }
}
