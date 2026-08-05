/**
 * Sessions-list constants shared between the URL parser (`list-query.ts`,
 * `server-only`) and the client component (`components/agent-sessions.tsx`).
 * No `server-only` guard here — the client imports this module directly, so
 * pulling in the server-only one would fail the client bundle.
 */

/** Rows per page — the one place the URL's `page` (0-based) and the query's
 * `offset` agree on a page size, so the two can never drift apart. */
export const SESSIONS_PAGE_SIZE = 25;

/** The People segment's implicit default when `origin` is absent from the
 * URL — human-driven sessions plus worker runs (a worker run is a user
 * dispatching work to the cloud, so it lists with human sessions). Shared so
 * the client's pristine-segment state and the server's URL-parsing default
 * can never disagree on what an absent `origin` means. */
export const DEFAULT_ORIGIN = "interactive,worker";

/** Range presets → StartedAt lower bound, labeled by VALUE (never "all X").
 * Lives here rather than beside the filter bar that renders it: the React Server Component (RSC) page
 * resolves `from` from the same table, and a Server Component importing a
 * value out of a `"use client"` module gets an opaque client reference back,
 * not the array — every read of it then throws at request time. */
export const TIME_RANGES = [
  { key: "", label: "All time", hours: 0 },
  { key: "24h", label: "Last 24h", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 24 * 7 },
  { key: "30d", label: "Last 30 days", hours: 24 * 30 },
] as const;
