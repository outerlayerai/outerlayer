// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Last-sync status record — the local half of sync observability.
 *
 * The hook-triggered background sync runs detached with `stdio: "ignore"`, so
 * its exit status reaches nobody: a dead endpoint, a revoked key, or a monthly
 * cap all fail exactly as loudly as success. The only symptom is a dashboard
 * that quietly stops moving, which is invisible until someone thinks to look.
 * Every sync therefore records its outcome here, and the surfaces that users
 * DO look at (`doctor`, the SessionStart hook) read it back.
 *
 * Imports node builtins ONLY — the hook fast path imports this file and must
 * stay inside its <50ms budget.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SyncStatusError {
  /** HTTP status when the failure was an HTTP response; absent for network
   * errors, config errors, and crashes. */
  status?: number;
  message: string;
}

export interface SyncStatus {
  /** ISO timestamp of the run this record describes. */
  at: string;
  ok: boolean;
  /** Destination host — a sync succeeding against the WRONG destination looks
   * identical to a healthy one locally, so the surfaces name it. */
  url?: string;
  appId?: string;
  /** Sessions shipped by this run. */
  synced?: number;
  /** Sessions this run collected but did not ship (the backlog). */
  pending?: number;
  error?: SyncStatusError;
  /**
   * ISO timestamp of the last run that SUCCEEDED, carried forward across
   * failures. Without it, a run of failures would erase the only evidence of
   * how long the outage has lasted — the number that makes it actionable.
   */
  lastOkAt?: string;
}

/** A successful sync older than this is worth mentioning. Chosen to be longer
 * than a normal working gap (lunch, a meeting) but far shorter than the
 * ~28 hours an unnoticed outage can otherwise run. */
export const SYNC_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function syncStatusPath(home = homedir()): string {
  return join(home, ".outerlayer", "last-sync.json");
}

/** Reads the status record. Returns null when absent or unreadable — a
 * corrupt record must never be louder than a missing one. */
export function readSyncStatus(home = homedir()): SyncStatus | null {
  try {
    const raw = readFileSync(syncStatusPath(home), "utf8");
    const parsed = JSON.parse(raw) as SyncStatus;
    if (!parsed || typeof parsed.at !== "string" || typeof parsed.ok !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Records the outcome of a sync run. Never throws: a status-write failure must
 * not turn an otherwise-successful sync into a failed one.
 *
 * `lastOkAt` is preserved from the previous record when this run failed, so
 * consecutive failures keep pointing at the last time data actually landed.
 */
export function writeSyncStatus(status: SyncStatus, home = homedir()): void {
  try {
    const previous = readSyncStatus(home);
    const merged: SyncStatus = {
      ...status,
      lastOkAt: status.ok ? status.at : (status.lastOkAt ?? previous?.lastOkAt),
    };
    const path = syncStatusPath(home);
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    // Write-then-rename: the SessionStart hook may read this concurrently and
    // must never see a half-written record.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // never fail a sync over its own bookkeeping
  }
}

export type SyncHealthLevel = "ok" | "warn" | "error" | "unknown";

export interface SyncHealth {
  level: SyncHealthLevel;
  /** One line, safe to show on its own. */
  headline: string;
  /** Supporting lines: what broke, for how long, what to run next. */
  details: string[];
}

/** Past-tense phrasing: "just now", "5h ago". The bare unit from `formatAge`
 * reads wrong at the extremes ("just now ago"). */
export function formatAgo(ms: number): string {
  const age = formatAge(ms);
  return age === "just now" || age === "unknown" ? age : `${age} ago`;
}

/** Compact human duration: "3m", "5h", "2d". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Classifies sync health for display.
 *
 * A failed run is an `error` regardless of age — it is unambiguous and needs
 * no activity signal to interpret. Staleness after a SUCCESSFUL run is only a
 * `warn`, because "no sync in 6h" is equally consistent with "wrote no code
 * today"; the callers that can distinguish those (the dashboard, which knows
 * the app's ingest cadence) escalate it, the ones that cannot do not.
 */
export function assessSyncHealth(
  status: SyncStatus | null,
  now: number = Date.now(),
  staleAfterMs: number = SYNC_STALE_AFTER_MS,
): SyncHealth {
  if (!status) {
    return {
      level: "unknown",
      headline: "no sync has run on this machine yet",
      details: ["run `outerlayer sync` once to verify the connection"],
    };
  }

  const host = status.url ? safeHost(status.url) : "the configured endpoint";

  if (!status.ok) {
    const brokenFor = status.lastOkAt
      ? formatAgo(now - Date.parse(status.lastOkAt))
      : null;
    const details: string[] = [];
    details.push(
      status.error?.status
        ? `HTTP ${status.error.status} from ${host}: ${status.error.message}`
        : `${host}: ${status.error?.message ?? "unknown error"}`,
    );
    details.push(
      brokenFor
        ? `last successful sync ${brokenFor}`
        : "no successful sync has ever been recorded for this destination",
    );
    if (status.pending) details.push(`${status.pending} session(s) waiting to ship`);
    details.push("run `outerlayer doctor` for the full picture");
    return {
      level: "error",
      headline: `sync is FAILING — last attempt ${formatAgo(now - Date.parse(status.at))}`,
      details,
    };
  }

  const age = now - Date.parse(status.at);
  if (age > staleAfterMs) {
    return {
      level: "warn",
      headline: `last successful sync ${formatAgo(age)}`,
      details: [`destination ${host}`, "expected continuously while you are coding"],
    };
  }

  return {
    level: "ok",
    headline: `synced ${formatAgo(age)} → ${host}`,
    details: [],
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
