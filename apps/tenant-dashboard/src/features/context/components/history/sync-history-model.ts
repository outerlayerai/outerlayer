/**
 * View-model mapping for the Context › History panel. A `context_sync_event`
 * row (the insert-only sync-attempt ledger) is projected into the flat shape the
 * list renders — one place to pin every derivation: the primary
 * text is the commit message with a short-SHA fallback, the SHA is truncated for
 * the monospace column, and the error only rides synced≠failed rows.
 *
 * Pure + total: no sorting here. The newest-first ordering is the query's job
 * (`created_at DESC`); the mapper preserves input order so a positional
 * assertion over a fixture pins both the mapping AND the order the list shows.
 */
import type { ContextSyncEventRow } from "../../types";

export type { ContextSyncEventRow };

type SyncStatus = "synced" | "failed";
type SyncTrigger = "link" | "push" | "resync";

export interface SyncHistoryRow {
  id: string;
  status: SyncStatus;
  trigger: SyncTrigger;
  /** commit_message, else the short SHA, else a last-resort placeholder. */
  primaryText: string;
  /** 7-char SHA for the monospace column; null when the attempt never resolved HEAD. */
  shortSha: string | null;
  branch: string;
  createdAt: string;
  durationMs: number | null;
  /** Full error text for the failed-row expansion; null on synced rows. */
  error: string | null;
}

/** First 7 chars of a commit SHA (git's default short form); null passes through. */
export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/** DB `status`/`trigger` are open TEXT; narrow defensively, defaulting to the failed/push edge. */
function asStatus(value: string): SyncStatus {
  return value === "synced" ? "synced" : "failed";
}
function asTrigger(value: string): SyncTrigger {
  return value === "link" || value === "resync" ? value : "push";
}

export function toSyncHistoryRow(event: ContextSyncEventRow): SyncHistoryRow {
  const status = asStatus(event.status);
  const sha = shortSha(event.commit_sha);
  return {
    id: event.id,
    status,
    trigger: asTrigger(event.trigger),
    primaryText: event.commit_message?.trim() || sha || "(unknown commit)",
    shortSha: sha,
    branch: event.branch,
    createdAt: event.created_at,
    durationMs: event.duration_ms,
    error: status === "failed" ? event.error : null,
  };
}

export function toSyncHistoryRows(
  events: readonly ContextSyncEventRow[],
): SyncHistoryRow[] {
  return events.map(toSyncHistoryRow);
}

/** Human duration for the row: sub-second in ms, else seconds to one decimal; null → no cell. */
export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
