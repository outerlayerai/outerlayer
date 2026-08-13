#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Plugin hook launcher: the only logic the plugin carries.
 *
 * Claude Code invokes this synchronously on SessionStart/SessionEnd/Stop, so
 * it inherits the capture fast-path's contract:
 *
 *   - ALWAYS exits 0 — a hook failure must never disrupt the user's session.
 *     Every failure mode (CLI not installed yet, npm missing, offline, disk
 *     full, corrupt install) is swallowed.
 *   - node builtins only; no output of its own on stdout/stderr. The managed
 *     CLI's own stdout (the SessionStart health report) passes through.
 *   - latency: the common path is one stat + an in-process import of the
 *     managed CLI's dist entry, which dispatches its own <50ms fast path.
 *     There is deliberately NO second node spawn per event.
 *
 * Capture logic lives in the published `outerlayer` npm package, not here:
 * this script maintains a self-managed install under ~/.outerlayer/cli and
 * runs it. npm is only ever the *install* mechanism, never on the per-event
 * path, so version drift is npm's problem and the plugin manifest stays
 * static.
 *
 * When the CLI is not installed yet, the event is dropped and a detached
 * background install starts (lock-guarded against stampedes). Dropping is
 * safe: the transcript still exists on disk, and the next captured
 * SessionEnd/Stop catches the session up.
 *
 * `prewarm` (the Setup hook) installs in the foreground so an explicit
 * `claude --init` leaves the machine capture-ready.
 */
import { mkdirSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Reinstall cadence: old enough to pick up fixes, rare enough to be free. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** A lock older than this belongs to a crashed/hung install — break it. */
const INSTALL_LOCK_TTL_MS = 10 * 60 * 1000;

/** Foreground install budget for `prewarm`; the Setup hook's own timeout is
 * the real backstop, this just keeps us under it. */
const PREWARM_TIMEOUT_MS = 100_000;

const olHome = () => process.env.OUTERLAYER_HOME || join(homedir(), ".outerlayer");
const cliPrefix = () => join(olHome(), "cli");
const installedPkgJson = () => join(cliPrefix(), "node_modules", "outerlayer", "package.json");
const cliEntry = () => join(cliPrefix(), "node_modules", "outerlayer", "dist", "index.js");

/** npm resolves via PATH; overridable to pin a package manager (or a stub in
 * tests). */
const npmBin = () => process.env.OUTERLAYER_NPM || (process.platform === "win32" ? "npm.cmd" : "npm");

const installArgs = () => ["install", "--prefix", cliPrefix(), "--no-audit", "--no-fund", "--loglevel", "error", "outerlayer@latest"];

/**
 * O_EXCL lock so concurrent hooks (or plugin + settings double-fire) start at
 * most one install. Returns true when this invocation holds the lock. A stale
 * lock (crashed install) is broken after INSTALL_LOCK_TTL_MS.
 */
function takeInstallLock() {
  const lock = join(cliPrefix(), ".install-lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs < INSTALL_LOCK_TTL_MS) return false;
        rmSync(lock, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Fire-and-forget install/refresh. Never throws, never blocks the event. */
function startBackgroundInstall() {
  try {
    mkdirSync(cliPrefix(), { recursive: true });
    if (!takeInstallLock()) return;
    const child = spawn(npmBin(), installArgs(), { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // npm missing / spawn failure: capture simply stays dormant until the
    // CLI appears — never an error in the user's session.
  }
}

/** Foreground install for `prewarm`. Output discarded; failure swallowed. */
function prewarmInstall() {
  try {
    mkdirSync(cliPrefix(), { recursive: true });
    if (!takeInstallLock()) return;
    spawnSync(npmBin(), installArgs(), { stdio: "ignore", timeout: PREWARM_TIMEOUT_MS });
  } catch {
    // offline / npm missing — a later event's background install retries
  }
}

try {
  const event = process.argv[2];

  if (event === "prewarm") {
    prewarmInstall();
    process.exit(0);
  }

  let installedAtMs = 0;
  try {
    installedAtMs = statSync(installedPkgJson()).mtimeMs;
  } catch {
    // not installed yet
  }

  if (installedAtMs === 0) {
    startBackgroundInstall();
    process.exit(0); // this event is dropped by design — see header
  }

  if (Date.now() - installedAtMs > REFRESH_AFTER_MS) {
    startBackgroundInstall(); // refresh in the background, run current below
  }

  // Run the managed CLI in-process: its entry dispatches `hook <event>` off
  // process.argv before any heavy import, then exits 0 itself. Importing
  // instead of spawning avoids a second node startup per event.
  process.env.OUTERLAYER_HOOK_SOURCE = "plugin";
  process.argv = [process.argv[0], cliEntry(), "hook", String(event ?? "")];
  await import(pathToFileURL(cliEntry()).href);
  process.exit(0);
} catch {
  try {
    // An import failure means a broken/corrupt install — self-heal it.
    startBackgroundInstall();
  } catch {
    // give up silently
  }
  process.exit(0);
}
