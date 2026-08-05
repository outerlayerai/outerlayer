/**
 * MSW handlers for the `eval_run` table (supabase/schemas/71-eval-run.sql).
 *
 * Backs EvalRunService: create (POST .select().single()), get (GET
 * app_id=eq&id=eq), list (GET app_id=eq&order=created_at.desc&limit), and the
 * status/card write-backs (PATCH app_id=eq&id=eq).
 */

import { http, HttpResponse } from "msw";

const SUPABASE_URL = "http://localhost:54321";

export type EvalRunMswRow = {
  id: string;
  tenant_id: string;
  app_id: string;
  environment_id?: string | null;
  status: string;
  repo_label: string;
  request: unknown;
  card?: unknown | null;
  cost_usd?: number;
  error?: string | null;
  created_at: string;
  created_by?: string | null;
  updated_at?: string | null;
};

type EvalRunMswState = {
  rows: EvalRunMswRow[];
  forceInsertError?: { message: string };
  forceUpdateError?: { message: string };
};

const defaultState = (): EvalRunMswState => ({ rows: [] });
let state = defaultState();

export function resetEvalRunMswState() {
  state = defaultState();
}

export function seedEvalRunMswState(nextState: Partial<EvalRunMswState>) {
  state = { ...state, ...nextState, rows: nextState.rows ?? state.rows };
}

/** Read-only snapshot for assertions (insert + update effects). */
export function getEvalRunMswState(): readonly EvalRunMswRow[] {
  return [...state.rows];
}

function opParam(url: URL, key: string, op: string): string | null {
  const value = url.searchParams.get(key);
  return value?.startsWith(`${op}.`) ? value.slice(op.length + 1) : null;
}

function matchesFilters(row: EvalRunMswRow, url: URL): boolean {
  const appId = opParam(url, "app_id", "eq");
  if (appId !== null && row.app_id !== appId) return false;
  const idEq = opParam(url, "id", "eq");
  if (idEq !== null && row.id !== idEq) return false;
  return true;
}

export const evalRunHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/eval_run`, ({ request }) => {
    const url = new URL(request.url);
    let rows = state.rows
      .filter((row) => matchesFilters(row, url))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      // maybeSingle(): zero rows → null body with 200, one row → the object.
      return HttpResponse.json(rows[0] ?? null);
    }
    return HttpResponse.json(rows);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/eval_run`, async ({ request }) => {
    if (state.forceInsertError) {
      return HttpResponse.json({ message: state.forceInsertError.message }, { status: 500 });
    }
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    const inserted = rows.map((row, index) => {
      const r = row as Partial<EvalRunMswRow>;
      return {
        id: `eval-run-${state.rows.length + index + 1}`,
        status: r.status ?? "queued",
        repo_label: r.repo_label ?? "",
        request: r.request ?? {},
        card: r.card ?? null,
        cost_usd: r.cost_usd ?? 0,
        error: r.error ?? null,
        environment_id: r.environment_id ?? null,
        created_by: r.created_by ?? null,
        updated_at: null,
        ...r,
        created_at: r.created_at ?? new Date().toISOString(),
      } as EvalRunMswRow;
    });
    state.rows.push(...inserted);
    const accept = request.headers.get("accept") ?? "";
    const single = accept.includes("application/vnd.pgrst.object+json");
    return HttpResponse.json(single ? inserted[0] : inserted, { status: 201 });
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/eval_run`, async ({ request }) => {
    if (state.forceUpdateError) {
      return HttpResponse.json({ message: state.forceUpdateError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    const patch = (await request.json()) as Partial<EvalRunMswRow>;
    state.rows = state.rows.map((row) =>
      matchesFilters(row, url) ? { ...row, ...patch } : row,
    );
    return new HttpResponse(null, { status: 204 });
  }),
];
