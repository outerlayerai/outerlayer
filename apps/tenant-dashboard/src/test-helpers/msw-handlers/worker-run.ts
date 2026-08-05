/**
 * MSW handlers for `worker_run` + `worker_run_event`
 * (supabase/schemas/73-worker-run.sql).
 *
 * Backs WorkerRunService (create/get/list/count/sum/cancel/patch) and the
 * worker routes' event queries. Modeled on the eval-run handler, extended with
 * count-header support (concurrency check) and the child event table.
 */

import { http, HttpResponse } from "msw";
import { buildSingleResponse, wantsSingle } from "@repo/test-msw";

const SUPABASE_URL = "http://localhost:54321";

type WorkerRunMswRow = {
  id: string;
  tenant_id: string;
  app_id: string;
  environment_id?: string | null;
  agent: string;
  task_prompt: string;
  attachments?: Array<{ name: string; mime: string; size_bytes: number }>;
  base_branch: string;
  status: string;
  dispatch: string;
  machine_id?: string | null;
  outcome?: string | null;
  branch_name?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  failure_code?: string | null;
  error_message?: string | null;
  cost_usd?: number | null;
  num_turns?: number | null;
  wall_clock_cap_s: number;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  workspace_id?: string | null;
  turn_index?: number;
  created_at: string;
  created_by?: string | null;
  updated_at?: string | null;
};

type WorkerRunEventMswRow = {
  id: string;
  worker_run_id: string;
  tenant_id: string;
  app_id: string;
  seq: number;
  event_type: string;
  payload: unknown;
  created_at: string;
};

type WorkerRunMswState = {
  rows: WorkerRunMswRow[];
  events: WorkerRunEventMswRow[];
  /** Force a 500 on the matching PostgREST verb so service error guards fire. */
  forceInsertError?: { message: string }; // POST  → create
  forceSelectError?: { message: string }; // GET   → get/list/listByEnvironment/sumDuration
  forceUpdateError?: { message: string }; // PATCH → cancel/patch/markProvisioning/fail
  forceCountError?: { message: string }; // HEAD  → countActiveForTenant
};

const defaultState = (): WorkerRunMswState => ({ rows: [], events: [] });
let state = defaultState();

export function resetWorkerRunMswState() {
  state = defaultState();
}

export function seedWorkerRunMswState(nextState: Partial<WorkerRunMswState>) {
  state = {
    ...state,
    ...nextState,
    rows: nextState.rows ?? state.rows,
    events: nextState.events ?? state.events,
  };
}

export function getWorkerRunMswState(): readonly WorkerRunMswRow[] {
  return [...state.rows];
}

export function getWorkerRunEventMswState(): readonly WorkerRunEventMswRow[] {
  return [...state.events];
}

function opParam(url: URL, key: string, op: string): string | null {
  const value = url.searchParams.get(key);
  return value?.startsWith(`${op}.`) ? value.slice(op.length + 1) : null;
}

function matchesRun(row: WorkerRunMswRow, url: URL): boolean {
  const appId = opParam(url, "app_id", "eq");
  if (appId !== null && row.app_id !== appId) return false;
  const idEq = opParam(url, "id", "eq");
  if (idEq !== null && row.id !== idEq) return false;
  const tenantEq = opParam(url, "tenant_id", "eq");
  if (tenantEq !== null && row.tenant_id !== tenantEq) return false;
  const statusIn = url.searchParams.get("status");
  if (statusIn?.startsWith("in.")) {
    const set = statusIn
      .slice(3)
      .replace(/^\(/, "")
      .replace(/\)$/, "")
      .split(",")
      // PostgREST quotes list values ("queued","running",…) — strip them.
      .map((s) => s.replace(/^"|"$/g, ""));
    if (!set.includes(row.status)) return false;
  }
  const createdGte = opParam(url, "created_at", "gte");
  if (createdGte !== null && Date.parse(row.created_at) < Date.parse(createdGte)) return false;
  const envRef = opParam(url, "workspace_id", "eq");
  if (envRef !== null && (row as { workspace_id?: string }).workspace_id !== envRef) return false;
  return true;
}

function countResponse(url: URL) {
  const total = state.rows.filter((row) => matchesRun(row, url)).length;
  return new HttpResponse(null, {
    status: 200,
    headers: {
      "content-range": `0-${Math.max(total - 1, 0)}/${total}`,
      "content-type": "application/json",
    },
  });
}

export const workerRunHandlers = [
  // `.select("id", { count: "exact", head: true })` issues an HTTP HEAD.
  http.head(`${SUPABASE_URL}/rest/v1/worker_run`, ({ request }) => {
    if (state.forceCountError) {
      return HttpResponse.json({ message: state.forceCountError.message }, { status: 500 });
    }
    return countResponse(new URL(request.url));
  }),

  http.get(`${SUPABASE_URL}/rest/v1/worker_run`, ({ request }) => {
    if (state.forceSelectError) {
      return HttpResponse.json({ message: state.forceSelectError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    // Order: turn_index asc (env thread) when requested, else created_at desc.
    const order = url.searchParams.get("order") ?? "";
    let rows = state.rows.filter((row) => matchesRun(row, url));
    if (order.startsWith("turn_index.")) {
      rows = rows.sort(
        (a, b) => ((a as { turn_index?: number }).turn_index ?? 0) - ((b as { turn_index?: number }).turn_index ?? 0),
      );
    } else {
      rows = rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));

    // `.single()` / `.maybeSingle()` (the callback route's base_branch +
    // workspace_id lookup) sets an object Accept → return one row, not an
    // array. `buildSingleResponse` returns a 406 for 0 rows, which supabase-js
    // maps to null for maybeSingle.
    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }

    // Count query (head=true / Prefer: count=exact) → Content-Range only.
    const prefer = request.headers.get("prefer") ?? "";
    if (prefer.includes("count=exact")) {
      const total = rows.length;
      return new HttpResponse(prefer.includes("head=true") ? null : JSON.stringify(rows), {
        status: 200,
        headers: {
          "content-range": `0-${Math.max(total - 1, 0)}/${total}`,
          "content-type": "application/json",
        },
      });
    }
    return HttpResponse.json(rows);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/worker_run`, async ({ request }) => {
    if (state.forceInsertError) {
      return HttpResponse.json({ message: state.forceInsertError.message }, { status: 500 });
    }
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    const inserted = rows.map((row, index) => {
      const r = row as Partial<WorkerRunMswRow>;
      return {
        id: `worker-run-${state.rows.length + index + 1}`,
        status: r.status ?? "queued",
        dispatch: r.dispatch ?? "local",
        agent: r.agent ?? "claude-code",
        task_prompt: r.task_prompt ?? "",
        base_branch: r.base_branch ?? "",
        wall_clock_cap_s: r.wall_clock_cap_s ?? 1800,
        environment_id: r.environment_id ?? null,
        created_by: r.created_by ?? null,
        machine_id: r.machine_id ?? null,
        outcome: r.outcome ?? null,
        duration_ms: r.duration_ms ?? null,
        updated_at: null,
        ...r,
        created_at: r.created_at ?? new Date().toISOString(),
      } as WorkerRunMswRow;
    });
    state.rows.push(...inserted);
    const accept = request.headers.get("accept") ?? "";
    const single = accept.includes("application/vnd.pgrst.object+json");
    return HttpResponse.json(single ? inserted[0] : inserted, { status: 201 });
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/worker_run`, async ({ request }) => {
    if (state.forceUpdateError) {
      return HttpResponse.json({ message: state.forceUpdateError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    const patch = (await request.json()) as Partial<WorkerRunMswRow>;
    const updated: WorkerRunMswRow[] = [];
    state.rows = state.rows.map((row) => {
      if (matchesRun(row, url)) {
        const next = { ...row, ...patch };
        updated.push(next);
        return next;
      }
      return row;
    });
    // PostgREST returns the mutated rows only when asked (supabase-js `.select()`
    // sets Prefer: return=representation); otherwise 204.
    const prefer = request.headers.get("prefer") ?? "";
    if (prefer.includes("return=representation")) {
      const accept = request.headers.get("accept") ?? "";
      const single = accept.includes("application/vnd.pgrst.object+json");
      return HttpResponse.json(single ? (updated[0] ?? null) : updated, { status: 200 });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${SUPABASE_URL}/rest/v1/worker_run_event`, ({ request }) => {
    const url = new URL(request.url);
    const runId = opParam(url, "worker_run_id", "eq");
    const seqGt = opParam(url, "seq", "gt");
    let events = state.events.filter((e) => (runId ? e.worker_run_id === runId : true));
    if (seqGt !== null) events = events.filter((e) => e.seq > Number(seqGt));
    events = events.sort((a, b) => a.seq - b.seq);
    return HttpResponse.json(events);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/worker_run_event`, async ({ request }) => {
    const body = await request.json();
    const rows = (Array.isArray(body) ? body : [body]) as Array<Partial<WorkerRunEventMswRow>>;
    for (const r of rows) {
      // Honor the unique (worker_run_id, seq): ignore duplicates (upsert).
      const dup = state.events.some(
        (e) => e.worker_run_id === r.worker_run_id && e.seq === r.seq,
      );
      if (dup) continue;
      state.events.push({
        id: `evt-${state.events.length + 1}`,
        worker_run_id: r.worker_run_id!,
        tenant_id: r.tenant_id!,
        app_id: r.app_id!,
        seq: r.seq!,
        event_type: r.event_type!,
        payload: r.payload ?? {},
        created_at: new Date().toISOString(),
      });
    }
    return new HttpResponse(null, { status: 201 });
  }),
];
