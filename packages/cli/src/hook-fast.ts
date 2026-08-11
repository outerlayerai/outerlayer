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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/**
 * Window inside which a second fire of the same (session, event) is treated
 * as the same underlying event. Claude Code has no dedupe of its own: when
 * hooks for one event are registered BOTH by the OuterLayer plugin and by a
 * settings file (`outerlayer init`), both fire, near-simultaneously. Long
 * enough to cover both invocations of one event; far shorter than any two
 * legitimate consecutive fires of the same event in one session.
 */
export const DOUBLE_FIRE_TTL_MS = 2000;

/** Fire markers older than this are dead weight; swept at SessionStart. */
const FIRE_MARKER_SWEEP_AFTER_MS = 60 * 60 * 1000;

/** Where this invocation was installed from. The plugin's launcher sets
 * OUTERLAYER_HOOK_SOURCE=plugin; hooks written by `init` set nothing. */
function hookSource(env: NodeJS.ProcessEnv = process.env): "plugin" | "settings" {
  return env.OUTERLAYER_HOOK_SOURCE === "plugin" ? "plugin" : "settings";
}

/**
 * True when this invocation is the FIRST fire of (sessionId, event) inside
 * DOUBLE_FIRE_TTL_MS — claimed via an O_EXCL marker file, so two concurrent
 * invocations resolve atomically. A stale marker is removed and re-claimed;
 * the create-after-remove race resolves through O_EXCL as well.
 *
 * Fail-open everywhere: no session id to key on, an unwritable spool, a
 * marker that vanishes mid-check — all claim as first. A double capture is
 * recoverable noise; a dropped session is data loss.
 */
export function claimEventFire(dir: string, sessionId: unknown, event: unknown, now: () => number = Date.now): boolean {
  try {
    if (typeof sessionId !== "string" || sessionId === "") return true;
    const key = `${String(event)}-${sessionId}`.replace(/[^A-Za-z0-9_.-]/g, "_");
    const marker = join(dir, `fire-${key}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        closeSync(openSync(marker, "wx"));
        return true;
      } catch {
        try {
          if (now() - statSync(marker).mtimeMs < DOUBLE_FIRE_TTL_MS) return false;
          rmSync(marker, { force: true });
        } catch {
          // marker vanished or is unreadable — retry the claim
        }
      }
    }
    return true;
  } catch {
    return true;
  }
}

/** Drop expired fire markers so the spool dir stays bounded. Runs once per
 * session (at SessionStart); any error is swallowed. */
function sweepFireMarkers(dir: string, now: () => number = Date.now): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("fire-")) continue;
      const p = join(dir, name);
      try {
        if (now() - statSync(p).mtimeMs > FIRE_MARKER_SWEEP_AFTER_MS) unlinkSync(p);
      } catch {
        // raced with another sweep — fine
      }
    }
  } catch {
    // never disrupt Claude Code
  }
}

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

/** Marker file: once written, {@link reportConnectNudge} never fires again on
 * this machine, ever — not per-session, not on a timer. */
const CONNECT_NUDGE_MARKER = "connect-nudge-shown";

/**
 * Nudges a machine that has the plugin capturing but nothing to sync TO —
 * once, ever. Only the plugin install path triggers this: `init`-written
 * settings hooks are a deliberate, already-informed install (the user read
 * `outerlayer init`'s own output), but enabling the plugin from `/plugin`
 * browse has no equivalent moment to mention `outerlayer login` exists.
 *
 * Strictly mutually exclusive with {@link reportSyncHealth}: that function
 * requires `config.json` to exist, this one requires it to be absent, so
 * the two can never both write to stdout for the same invocation.
 *
 * Same anti-nagging discipline as `reportSyncHealth`'s own docstring: a
 * repeated nudge is worse than none, so the marker is written BEFORE the
 * nudge is emitted (a crash after the write cannot loop this) and checked
 * unconditionally regardless of how many machines/sessions follow.
 */
export function reportConnectNudge(event: string, home = homedir(), write: (s: string) => void = (s) => process.stdout.write(s)): void {
  try {
    if (event !== "SessionStart") return;
    if (hookSource() !== "plugin") return;
    if (existsSync(join(home, ".outerlayer", "config.json"))) return;
    const dir = join(home, ".outerlayer");
    const marker = join(dir, CONNECT_NUDGE_MARKER);
    if (existsSync(marker)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
    write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "OuterLayer is installed but not connected to a dashboard yet. Run /outerlayer:connect to start capturing sessions.",
        },
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
      source: hookSource(),
    };
    // Plugin + settings double-install fires every hook twice; only the
    // first claimant captures (and reports/syncs — the loser must stay
    // completely silent or SessionStart context would arrive twice).
    if (!claimEventFire(dir, record.sessionId, record.event)) return;
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(record) + "\n");
    if (record.event === "SessionStart") sweepFireMarkers(dir);
    maybeAutoSync(String(record.event), home);
    reportSyncHealth(String(record.event), home);
    reportConnectNudge(String(record.event), home);
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
