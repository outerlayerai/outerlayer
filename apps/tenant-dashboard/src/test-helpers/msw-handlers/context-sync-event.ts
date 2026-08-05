/**
 * MSW handler for `context_sync_event` — the insert-only sync attempt ledger.
 * Backs two boundaries: the mirror port's `recordSyncEvent` (POST insert) and
 * the Context tab's History panel read (GET, filtered by app_id, newest-first).
 * Inserts are captured verbatim so tests can pin the exact recorded payload.
 */

import { http, HttpResponse } from "msw";

const SUPABASE_URL = "http://localhost:54321";

export type ContextSyncEventMswRow = {
  id: string;
  app_id: string;
  tenant_id: string;
  branch: string;
  commit_sha: string | null;
  commit_message: string | null;
  trigger: "link" | "push" | "resync";
  status: "synced" | "failed";
  error: string | null;
  duration_ms: number | null;
  snapshot_id: string | null;
  created_at: string;
};

type State = {
  rows: ContextSyncEventMswRow[];
  /** Force a 500 on the matching PostgREST verb so error guards fire. */
  forceInsertError?: { message: string };
  forceSelectError?: { message: string };
};
let state: State = { rows: [] };

export function resetContextSyncEventMswState() {
  state = { rows: [] };
}
export function seedContextSyncEventMswState(next: Partial<State>) {
  state = { ...state, ...next, rows: next.rows ?? state.rows };
}
/** Every row inserted through the POST handler, in insertion order. */
export function getInsertedContextSyncEvents(): readonly ContextSyncEventMswRow[] {
  return [...state.rows];
}

interface Filter {
  kind: "eq" | "is-null";
  column: string;
  value?: string;
}

function parseFilters(url: URL): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (raw.startsWith("eq.")) filters.push({ kind: "eq", column: key, value: raw.slice(3) });
    else if (raw === "is.null") filters.push({ kind: "is-null", column: key });
  }
  return filters;
}

function matches(row: ContextSyncEventMswRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = (row as Record<string, unknown>)[f.column];
    if (f.kind === "eq") return String(v) === f.value;
    return v === null || v === undefined; // is-null
  });
}

export const contextSyncEventHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/context_sync_event`, ({ request }) => {
    if (state.forceSelectError) {
      return HttpResponse.json({ message: state.forceSelectError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    let rows = state.rows.filter((r) => matches(r, parseFilters(url)));
    // The History panel reads newest-first (created_at DESC).
    rows = rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const total = rows.length;
    // `.range(from, to)` arrives as offset+limit query params.
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.get("limit");
    if (offset > 0) rows = rows.slice(offset);
    if (limit !== null) rows = rows.slice(0, Number(limit));
    // `{ count: "exact" }` sends `Prefer: count=exact`; postgrest-js reads the
    // total back out of the Content-Range header.
    const headers: Record<string, string> = {};
    if ((request.headers.get("prefer") ?? "").includes("count=exact")) {
      const to = rows.length === 0 ? offset : offset + rows.length - 1;
      headers["content-range"] = `${offset}-${to}/${total}`;
    }
    return HttpResponse.json(rows, { headers });
  }),

  http.post(`${SUPABASE_URL}/rest/v1/context_sync_event`, async ({ request }) => {
    if (state.forceInsertError) {
      return HttpResponse.json({ message: state.forceInsertError.message }, { status: 500 });
    }
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    const inserted = rows.map((row, i) => {
      const r = row as Partial<ContextSyncEventMswRow>;
      return {
        id: r.id ?? `context-sync-event-${state.rows.length + i + 1}`,
        commit_sha: r.commit_sha ?? null,
        commit_message: r.commit_message ?? null,
        error: r.error ?? null,
        duration_ms: r.duration_ms ?? null,
        snapshot_id: r.snapshot_id ?? null,
        ...r,
        created_at: r.created_at ?? new Date().toISOString(),
      } as ContextSyncEventMswRow;
    });
    state.rows.push(...inserted);
    const accept = request.headers.get("accept") ?? "";
    const single = accept.includes("application/vnd.pgrst.object+json");
    const prefer = request.headers.get("prefer") ?? "";
    if (prefer.includes("return=representation")) {
      return HttpResponse.json(single ? inserted[0] : inserted, { status: 201 });
    }
    return new HttpResponse(null, { status: 201 });
  }),
];
