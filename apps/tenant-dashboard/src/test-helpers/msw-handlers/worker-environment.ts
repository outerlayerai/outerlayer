/**
 * MSW handler for `worker_workspace`. Backs
 * WorkerEnvironmentService: create, get, list (neq destroyed), count head, and
 * the acquire-for-turn lock (update where current_run_id is null). Mutating
 * updates evaluate filters against seeded rows so the lock's exclusivity is
 * exercised for real.
 */

import { http, HttpResponse } from "msw";
import { buildSingleResponse, wantsSingle } from "@repo/test-msw";

const SUPABASE_URL = "http://localhost:54321";

type WorkerEnvironmentMswRow = {
  id: string;
  tenant_id: string;
  app_id: string;
  environment_id?: string | null;
  agent: string;
  base_branch: string;
  work_branch?: string | null;
  substrate: string;
  machine_ref?: string | null;
  workspace_ref?: string | null;
  session_ref?: string | null;
  status: string;
  current_run_id?: string | null;
  idle_ttl_s: number;
  last_active_at?: string | null;
  failure_reason?: string | null;
  created_at: string;
  created_by?: string | null;
  updated_at?: string | null;
};

type State = {
  rows: WorkerEnvironmentMswRow[];
  /** Force a 500 on the matching PostgREST verb so service error guards fire. */
  forceInsertError?: { message: string }; // POST  → create
  forceSelectError?: { message: string }; // GET   → get/list
  forceUpdateError?: { message: string }; // PATCH → acquireForTurn/completeTurn/markMachine/destroy/fail
  forceCountError?: { message: string }; // HEAD  → countActiveForTenant
};
let state: State = { rows: [] };

export function resetWorkerEnvironmentMswState() {
  state = { rows: [] };
}
export function seedWorkerEnvironmentMswState(next: Partial<State>) {
  state = { ...state, ...next, rows: next.rows ?? state.rows };
}
export function getWorkerEnvironmentMswState(): readonly WorkerEnvironmentMswRow[] {
  return [...state.rows];
}

interface Filter {
  kind: "eq" | "neq" | "is-null";
  column: string;
  value?: string;
}

function parseFilters(url: URL): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (raw.startsWith("eq.")) filters.push({ kind: "eq", column: key, value: raw.slice(3) });
    else if (raw.startsWith("neq.")) filters.push({ kind: "neq", column: key, value: raw.slice(4) });
    else if (raw === "is.null") filters.push({ kind: "is-null", column: key });
  }
  return filters;
}

function matches(row: WorkerEnvironmentMswRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = (row as Record<string, unknown>)[f.column];
    if (f.kind === "eq") return String(v) === f.value;
    if (f.kind === "neq") return String(v) !== f.value;
    return v === null || v === undefined; // is-null
  });
}

export const workerEnvironmentHandlers = [
  http.head(`${SUPABASE_URL}/rest/v1/worker_workspace`, ({ request }) => {
    if (state.forceCountError) {
      return HttpResponse.json({ message: state.forceCountError.message }, { status: 500 });
    }
    const filters = parseFilters(new URL(request.url));
    const total = state.rows.filter((r) => matches(r, filters)).length;
    return new HttpResponse(null, {
      status: 200,
      headers: { "content-range": `0-${Math.max(total - 1, 0)}/${total}`, "content-type": "application/json" },
    });
  }),

  http.get(`${SUPABASE_URL}/rest/v1/worker_workspace`, ({ request }) => {
    if (state.forceSelectError) {
      return HttpResponse.json({ message: state.forceSelectError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    let rows = state.rows.filter((r) => matches(r, parseFilters(url)));
    rows = rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));
    // `.maybeSingle()` (the detail read) sets an object Accept → return one row,
    // not an array; `buildSingleResponse` gives a 406 for 0 rows, which
    // supabase-js maps to null.
    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }
    return HttpResponse.json(rows);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/worker_workspace`, async ({ request }) => {
    if (state.forceInsertError) {
      return HttpResponse.json({ message: state.forceInsertError.message }, { status: 500 });
    }
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    const inserted = rows.map((row, i) => {
      const r = row as Partial<WorkerEnvironmentMswRow>;
      return {
        id: `worker-env-${state.rows.length + i + 1}`,
        status: r.status ?? "creating",
        substrate: r.substrate ?? "local",
        agent: r.agent ?? "claude-code",
        base_branch: r.base_branch ?? "",
        idle_ttl_s: r.idle_ttl_s ?? 1800,
        current_run_id: r.current_run_id ?? null,
        session_ref: r.session_ref ?? null,
        machine_ref: r.machine_ref ?? null,
        environment_id: r.environment_id ?? null,
        created_by: r.created_by ?? null,
        updated_at: null,
        ...r,
        created_at: r.created_at ?? new Date().toISOString(),
      } as WorkerEnvironmentMswRow;
    });
    state.rows.push(...inserted);
    const accept = request.headers.get("accept") ?? "";
    const single = accept.includes("application/vnd.pgrst.object+json");
    return HttpResponse.json(single ? inserted[0] : inserted, { status: 201 });
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/worker_workspace`, async ({ request }) => {
    if (state.forceUpdateError) {
      return HttpResponse.json({ message: state.forceUpdateError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    const filters = parseFilters(url);
    const patch = (await request.json()) as Partial<WorkerEnvironmentMswRow>;
    const updated: WorkerEnvironmentMswRow[] = [];
    state.rows = state.rows.map((row) => {
      if (matches(row, filters)) {
        const next = { ...row, ...patch };
        updated.push(next);
        return next;
      }
      return row;
    });
    const prefer = request.headers.get("prefer") ?? "";
    if (prefer.includes("return=representation")) {
      const accept = request.headers.get("accept") ?? "";
      const single = accept.includes("application/vnd.pgrst.object+json");
      return HttpResponse.json(single ? (updated[0] ?? null) : updated, { status: 200 });
    }
    return new HttpResponse(null, { status: 204 });
  }),
];
