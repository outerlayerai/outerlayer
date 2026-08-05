/**
 * MSW handlers for the `env_escalation` table
 * (supabase/schemas/72-env-escalation.sql).
 *
 * Backs EnvEscalationService: list (GET app_id=eq&status=in&order&limit),
 * the transition pre-read (GET app_id=eq&id=eq), and the guarded update
 * (PATCH app_id=eq&id=eq&status=eq .select().maybeSingle()). Modeled on the
 * eval-run handler.
 */

import { http, HttpResponse } from "msw";

const SUPABASE_URL = "http://localhost:54321";

export type EnvEscalationMswRow = {
  id: string;
  tenant_id: string;
  app_id: string;
  eval_run_id?: string | null;
  repo: string;
  base_commit: string;
  task_ids: string[];
  last_errors: Array<{ stage?: string; excerpt?: string; setup?: string }>;
  attempts: number;
  cost_usd: number;
  suggested_next_steps: string;
  status: "open" | "acked" | "resolved";
  created_at: string;
  updated_at?: string | null;
  updated_by?: string | null;
};

type EnvEscalationMswState = {
  rows: EnvEscalationMswRow[];
  forceUpdateError?: { message: string };
};

const defaultState = (): EnvEscalationMswState => ({ rows: [] });
let state = defaultState();

export function resetEnvEscalationMswState() {
  state = defaultState();
}

export function seedEnvEscalationMswState(nextState: Partial<EnvEscalationMswState>) {
  state = { ...state, ...nextState, rows: nextState.rows ?? state.rows };
}

/** Read-only snapshot for assertions (transition effects). */
export function getEnvEscalationMswState(): readonly EnvEscalationMswRow[] {
  return [...state.rows];
}

function opParam(url: URL, key: string, op: string): string | null {
  const value = url.searchParams.get(key);
  return value?.startsWith(`${op}.`) ? value.slice(op.length + 1) : null;
}

function matchesFilters(row: EnvEscalationMswRow, url: URL): boolean {
  const appId = opParam(url, "app_id", "eq");
  if (appId !== null && row.app_id !== appId) return false;
  const idEq = opParam(url, "id", "eq");
  if (idEq !== null && row.id !== idEq) return false;
  const statusEq = opParam(url, "status", "eq");
  if (statusEq !== null && row.status !== statusEq) return false;
  const statusIn = opParam(url, "status", "in");
  if (statusIn !== null) {
    const wanted = statusIn.replace(/^\(/, "").replace(/\)$/, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
    if (!wanted.includes(row.status)) return false;
  }
  return true;
}

export const envEscalationHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/env_escalation`, ({ request }) => {
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

  http.patch(`${SUPABASE_URL}/rest/v1/env_escalation`, async ({ request }) => {
    if (state.forceUpdateError) {
      return HttpResponse.json({ message: state.forceUpdateError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    const patch = (await request.json()) as Partial<EnvEscalationMswRow>;
    const updated: EnvEscalationMswRow[] = [];
    state.rows = state.rows.map((row) => {
      if (!matchesFilters(row, url)) return row;
      const next = { ...row, ...patch };
      updated.push(next);
      return next;
    });
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      return HttpResponse.json(updated[0] ?? null);
    }
    return HttpResponse.json(updated);
  }),
];
