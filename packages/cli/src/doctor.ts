// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, SUPPORTED_VERSIONS } from "@outerlayer/capture";
import { readSettings, settingsPath, REGISTERED_EVENTS, isOurHookCommand } from "./settings.js";
import { spoolDir } from "./hook-fast.js";
import { assessSyncHealth, readSyncStatus, SYNC_STALE_AFTER_MS } from "./sync-status.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** One-line remediation when not `pass`. */
  fix?: string;
}

export interface DoctorEnv {
  home?: string;
  cwd?: string;
  /** Injected for tests: resolves `claude --version` output, or throws. */
  claudeVersion?: () => string;
  /** Injected: which claude installs exist. */
  claudeInstalls?: () => string[];
  now?: () => number;
}

/** Run all doctor checks. Pure-ish: all IO is injectable. */
export function runDoctor(env: DoctorEnv = {}): Check[] {
  const home = env.home ?? homedir();
  const now = env.now ?? Date.now;
  return [
    checkClaudeDir(home),
    checkTranscripts(home, now),
    checkHooksInstalled(home, env.cwd),
    checkSpoolWritable(home),
    checkLastSync(home, now),
    checkDaemon(home),
    checkCleanupPeriod(home),
    checkDiskHeadroom(home),
    checkClaudeVersion(env),
    checkSettingsValid(home, env.cwd),
    ...checkInstalls(env),
  ];
}

function checkClaudeDir(home: string): Check {
  const dir = join(home, ".claude");
  return existsSync(dir)
    ? { name: "Claude Code home", status: "pass", detail: dir }
    : { name: "Claude Code home", status: "fail", detail: `${dir} not found`, fix: "Install Claude Code, or pass --root to point at your transcripts." };
}

function checkTranscripts(home: string, now: () => number): Check {
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) {
    return { name: "Transcripts", status: "warn", detail: "no projects directory yet", fix: "Run a Claude Code session, then re-check." };
  }
  let count = 0;
  let newest = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && st.size > 0) {
        count += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  walk(root);
  if (count === 0) {
    return { name: "Transcripts", status: "warn", detail: "0 transcripts found", fix: "Use Claude Code, then run `outerlayer scan`." };
  }
  const ageH = (now() - newest) / 3_600_000;
  const age = ageH < 1 ? "<1h ago" : ageH < 48 ? `${Math.round(ageH)}h ago` : `${Math.round(ageH / 24)}d ago`;
  return { name: "Transcripts", status: "pass", detail: `${count} transcripts, newest ${age}` };
}

function checkHooksInstalled(home: string, cwd?: string): Check {
  for (const scope of ["user", "project"] as const) {
    const path = settingsPath(scope, { home, cwd });
    let settings;
    try {
      settings = readSettings(path);
    } catch {
      continue;
    }
    if (!settings?.hooks) continue;
    const installed = REGISTERED_EVENTS.filter((event) =>
      (settings.hooks?.[event] ?? []).some((b) => (b.hooks ?? []).some(isOurHookCommand)),
    );
    if (installed.length === REGISTERED_EVENTS.length) {
      return { name: "Hooks installed", status: "pass", detail: `${installed.join(", ")} (${scope})` };
    }
    if (installed.length > 0) {
      return { name: "Hooks installed", status: "warn", detail: `only ${installed.join(", ")} installed`, fix: "Run `outerlayer init` to (re)install all lifecycle hooks." };
    }
  }
  return { name: "Hooks installed", status: "fail", detail: "no OuterLayer hooks found", fix: "Run `outerlayer init`." };
}

function checkSpoolWritable(home: string): Check {
  const dir = spoolDir(home);
  try {
    if (!existsSync(dir)) return { name: "Spool writable", status: "warn", detail: "spool not created yet", fix: "Run `outerlayer init` (creates the spool on first hook)." };
    accessSync(dir, constants.W_OK);
    return { name: "Spool writable", status: "pass", detail: dir };
  } catch {
    return { name: "Spool writable", status: "fail", detail: `${dir} not writable`, fix: "Fix permissions on ~/.outerlayer/spool." };
  }
}

/**
 * The background sync's only visible trace. It runs detached with its output
 * discarded, so without this record a sync that has been failing for days is
 * indistinguishable from one that ran clean a minute ago.
 *
 * Unlike the SessionStart hook, `doctor` is pulled deliberately by someone
 * already asking "is this working?" — so staleness is worth reporting here
 * even though it cannot be told apart from a quiet day.
 */
function checkLastSync(home: string, now: () => number): Check {
  const name = "Cloud sync";
  if (!existsSync(join(home, ".outerlayer", "config.json"))) {
    return { name, status: "warn", detail: "not configured — sessions stay on this machine", fix: "Run `outerlayer sync --url <url> --api-key <key> --app-id <id>` once to connect." };
  }
  const health = assessSyncHealth(readSyncStatus(home), now(), SYNC_STALE_AFTER_MS);
  const detail = [health.headline, ...health.details].join("; ");
  if (health.level === "error") {
    return { name, status: "fail", detail, fix: "Check the destination and API key in ~/.outerlayer/config.json, then run `outerlayer sync` to see the full error." };
  }
  if (health.level === "warn" || health.level === "unknown") {
    return { name, status: "warn", detail, fix: "Run `outerlayer sync` to confirm the connection works." };
  }
  return { name, status: "pass", detail };
}

function checkDaemon(home: string): Check {
  const pidfile = join(home, ".outerlayer", "daemon.pid");
  const heartbeat = join(home, ".outerlayer", "daemon.heartbeat");
  if (!existsSync(pidfile)) {
    return { name: "Daemon running", status: "warn", detail: "not running", fix: "Start it with `outerlayer watch` (or a login agent)." };
  }
  try {
    const beatMs = statSync(heartbeat).mtimeMs;
    const staleMin = (Date.now() - beatMs) / 60000;
    if (staleMin > 30) {
      return { name: "Daemon running", status: "warn", detail: `heartbeat ${Math.round(staleMin)}m stale`, fix: "Restart `outerlayer watch`." };
    }
    return { name: "Daemon running", status: "pass", detail: "heartbeat fresh" };
  } catch {
    return { name: "Daemon running", status: "warn", detail: "pidfile present, no heartbeat", fix: "Restart `outerlayer watch`." };
  }
}

function checkCleanupPeriod(home: string): Check {
  const path = join(home, ".claude", "settings.json");
  let settings;
  try {
    settings = readSettings(path);
  } catch {
    return { name: "Retention (cleanupPeriodDays)", status: "warn", detail: "settings unreadable" };
  }
  const raw = (settings as Record<string, unknown> | null)?.cleanupPeriodDays;
  const days = typeof raw === "number" ? raw : 30; // Claude Code default
  if (days === 0) {
    return {
      name: "Retention (cleanupPeriodDays)",
      status: "fail",
      detail: "set to 0 — this DISABLES transcript persistence (upstream anthropics/claude-code#23710 and #59248)",
      fix: "Remove cleanupPeriodDays or set it ≥14; run `outerlayer watch` to mirror before deletion.",
    };
  }
  if (days < 14) {
    return { name: "Retention (cleanupPeriodDays)", status: "warn", detail: `${days}d — transcripts deleted quickly`, fix: "Run `outerlayer watch` so raws are mirrored before cleanup." };
  }
  return { name: "Retention (cleanupPeriodDays)", status: "pass", detail: `${days}d` };
}

function checkDiskHeadroom(home: string): Check {
  // Cheap heuristic: ensure ~/.outerlayer's parent is writable; real df is
  // platform-specific and not worth a native dep here.
  try {
    accessSync(home, constants.W_OK);
    return { name: "Disk headroom", status: "pass", detail: "home writable (raw mirror capped at 5 GiB, LRU)" };
  } catch {
    return { name: "Disk headroom", status: "fail", detail: "home not writable", fix: "Free space / fix permissions on your home directory." };
  }
}

function checkClaudeVersion(env: DoctorEnv): Check {
  let version: string;
  try {
    version = (env.claudeVersion ?? defaultClaudeVersion)();
  } catch {
    return { name: "Claude Code version", status: "warn", detail: "could not run `claude --version`", fix: "Ensure `claude` is on PATH." };
  }
  const parsed = version.match(/\d+\.\d+\.\d+/)?.[0];
  if (!parsed) return { name: "Claude Code version", status: "warn", detail: `unrecognized: ${version}` };
  if (compareVersions(parsed, SUPPORTED_VERSIONS.max) > 0) {
    return { name: "Claude Code version", status: "warn", detail: `${parsed} is newer than validated (${SUPPORTED_VERSIONS.max}) — parser runs best-effort`, fix: "Update OuterLayer if you see parse warnings." };
  }
  if (compareVersions(parsed, SUPPORTED_VERSIONS.min) < 0) {
    return { name: "Claude Code version", status: "warn", detail: `${parsed} is older than validated (${SUPPORTED_VERSIONS.min})` };
  }
  return { name: "Claude Code version", status: "pass", detail: parsed };
}

function checkSettingsValid(home: string, cwd?: string): Check {
  for (const scope of ["user", "project"] as const) {
    const path = settingsPath(scope, { home, cwd });
    if (!existsSync(path)) continue;
    try {
      readSettings(path);
    } catch (err) {
      return { name: "Settings JSON valid", status: "fail", detail: `${path} is corrupt`, fix: err instanceof Error ? err.message : "Fix the JSON syntax." };
    }
  }
  return { name: "Settings JSON valid", status: "pass", detail: "all settings files parse" };
}

function checkInstalls(env: DoctorEnv): Check[] {
  let installs: string[];
  try {
    installs = (env.claudeInstalls ?? defaultClaudeInstalls)();
  } catch {
    return [];
  }
  if (installs.length > 1) {
    return [{ name: "Claude Code installs", status: "warn", detail: `multiple found: ${installs.join(", ")}`, fix: "Multiple installs can diverge in version; keep one." }];
  }
  return [];
}

function defaultClaudeVersion(): string {
  return execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
}
function defaultClaudeInstalls(): string[] {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["-a", "claude"], { encoding: "utf8", timeout: 5000 });
    return out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** Overall exit status: fail if any fail, else 0. */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
