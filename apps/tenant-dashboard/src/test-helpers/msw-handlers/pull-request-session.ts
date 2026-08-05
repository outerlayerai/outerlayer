/**
 * MSW handler for the PR↔session reconciliation boundary: `pull_request`
 * reads (the reconciler's provider-record lookups) and `pull_request_session`
 * reads/upserts/updates. Upserts honor the (app_id, pr_number, trace_id)
 * conflict key so tests can pin merge semantics, and every write is captured
 * for exact-payload assertions.
 */

import { http, HttpResponse } from "msw";

const SUPABASE_URL = "http://localhost:54321";

export type PullRequestMswRow = {
  pr_number: number;
  app_id: string;
  head_branch: string;
  opened_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  // Fate fields the outcome-score emitter reads; optional so reconciler
  // tests keep their minimal seeds.
  tenant_id?: string;
  state?: "open" | "closed" | "merged";
  reverted_at?: string | null;
  first_ci_status?: "success" | "failure" | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** Provider PR/MR page — read by the session-list outcome column. */
  url?: string | null;
};

export type PullRequestSessionMswRow = {
  id: string;
  tenant_id: string;
  app_id: string;
  pr_number: number;
  trace_id: string;
  session_id: string;
  method: "pr_link" | "branch";
  verification: "pending" | "confirmed" | "unmatched";
  git_branch: string;
  first_linked_at: string;
  last_reconciled_at: string;
};

type State = {
  pullRequests: PullRequestMswRow[];
  links: PullRequestSessionMswRow[];
};
let state: State = { pullRequests: [], links: [] };

export function resetPullRequestSessionMswState() {
  state = { pullRequests: [], links: [] };
}
export function seedPullRequestSessionMswState(next: Partial<State>) {
  state = {
    pullRequests: next.pullRequests ?? state.pullRequests,
    links: next.links ?? state.links,
  };
}
/** Current link rows (post-upsert/update), stable insertion order. */
export function getPullRequestSessionLinks(): readonly PullRequestSessionMswRow[] {
  return [...state.links];
}

type Filter = { column: string; kind: "eq" | "neq" | "in" | "gte" | "is"; values: string[] };

function parseFilters(url: URL): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    if (raw.startsWith("eq.")) filters.push({ column: key, kind: "eq", values: [raw.slice(3)] });
    else if (raw.startsWith("neq.")) filters.push({ column: key, kind: "neq", values: [raw.slice(4)] });
    else if (raw.startsWith("gte.")) filters.push({ column: key, kind: "gte", values: [raw.slice(4)] });
    else if (raw.startsWith("is.")) filters.push({ column: key, kind: "is", values: [raw.slice(3)] });
    else if (raw.startsWith("in.(")) {
      filters.push({
        column: key,
        kind: "in",
        values: raw
          .slice(4, -1)
          .split(",")
          .map((v) => v.replace(/^"|"$/g, "")),
      });
    }
  }
  return filters;
}

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.column];
    if (f.kind === "is") {
      // PostgREST `is.null` — the only `is.` form these handlers see.
      return f.values[0] === "null" ? value == null : String(value) === f.values[0];
    }
    if (f.kind === "gte") {
      // Timestamp comparison: ISO strings order lexicographically.
      return value != null && String(value) >= f.values[0]!;
    }
    if (f.kind === "neq") {
      return String(value) !== f.values[0];
    }
    return f.values.includes(String(value));
  });
}

export const pullRequestSessionHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/pull_request`, ({ request }) => {
    const url = new URL(request.url);
    const filters = parseFilters(url);
    let rows = state.pullRequests.filter((r) => matches(r as Record<string, unknown>, filters));
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));
    return HttpResponse.json(rows);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/pull_request_session`, ({ request }) => {
    const url = new URL(request.url);
    const filters = parseFilters(url);
    let rows = state.links.filter((r) => matches(r as Record<string, unknown>, filters));
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));
    return HttpResponse.json(rows);
  }),

  // Upsert: POST with on_conflict=app_id,pr_number,trace_id.
  http.post(`${SUPABASE_URL}/rest/v1/pull_request_session`, async ({ request }) => {
    const body = await request.json();
    const rows = (Array.isArray(body) ? body : [body]) as Partial<PullRequestSessionMswRow>[];
    for (const row of rows) {
      const key = (r: { app_id?: string; pr_number?: number; trace_id?: string }) =>
        `${r.app_id}:${r.pr_number}:${r.trace_id}`;
      const idx = state.links.findIndex((l) => key(l) === key(row));
      if (idx >= 0) {
        state.links[idx] = { ...state.links[idx]!, ...row } as PullRequestSessionMswRow;
      } else {
        state.links.push({
          id: `prs-link-${state.links.length + 1}`,
          session_id: "",
          git_branch: "",
          first_linked_at: row.last_reconciled_at ?? new Date(0).toISOString(),
          ...row,
        } as PullRequestSessionMswRow);
      }
    }
    return HttpResponse.json(rows, { status: 201 });
  }),

  // Update: PATCH filtered by in.(id,...) / eq.
  http.patch(`${SUPABASE_URL}/rest/v1/pull_request_session`, async ({ request }) => {
    const patch = (await request.json()) as Partial<PullRequestSessionMswRow>;
    const filters = parseFilters(new URL(request.url));
    for (const [i, row] of state.links.entries()) {
      if (matches(row as Record<string, unknown>, filters)) {
        state.links[i] = { ...row, ...patch };
      }
    }
    return HttpResponse.json([], { status: 200 });
  }),
];
