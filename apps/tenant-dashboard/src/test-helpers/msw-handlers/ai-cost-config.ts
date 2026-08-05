/**
 * MSW handlers for the `ai_cost_config` table (`AiCostService`, and the
 * admin-client widget read `fetchAiCostConfigForTenant`). The upsert path
 * models Postgres's RLS-driven distinction between the INSERT and UPDATE
 * halves of an `ON CONFLICT` upsert: a role holding `ai_cost_config.update`
 * but not `.insert` is denied only on a tenant's first-ever configure (no
 * existing row to match the UPDATE policy), which is the fail-closed
 * behaviour `forceInsertDenied` simulates.
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = 'http://localhost:54321';

export type AiCostConfigMswRow = {
  tenant_id: string;
  seat_count: number;
  cost_per_seat_usd: number;
};

type AiCostConfigMswState = {
  rows: AiCostConfigMswRow[];
  /** Simulates a role holding `ai_cost_config.update` but not `.insert`: the
   *  upsert is denied at the DB when no existing row matches (first-ever
   *  configure), matching Postgres RLS fail-closed behaviour. */
  forceInsertDenied?: boolean;
  /** Simulates a write that matches zero rows with NO explicit database
   *  error — the silent-no-op shape `.select().single()` exists to turn
   *  into a real error (D-9). Without the representation header a real
   *  zero-row PostgREST response is a bare 2xx with an empty body/array;
   *  `.select().single()`'s `Accept: vnd.pgrst.object` header is what makes
   *  PostgREST answer a zero-row match with PGRST116 instead. */
  forceSilentZeroRowMatch?: boolean;
};

const defaultState = (): AiCostConfigMswState => ({ rows: [] });

let state = defaultState();

export function resetAiCostConfigMswState() {
  state = defaultState();
}

export function seedAiCostConfigMswState(nextState: Partial<AiCostConfigMswState>) {
  state = {
    ...state,
    ...nextState,
    rows: nextState.rows ?? state.rows,
  };
}

function eqParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  return value?.startsWith('eq.') ? value.slice(3) : null;
}

function wantsSingle(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/vnd.pgrst.object+json');
}

export const aiCostConfigHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/ai_cost_config`, ({ request }) => {
    const url = new URL(request.url);
    const tenantId = eqParam(url, 'tenant_id');
    const rows = state.rows.filter((row) => (tenantId ? row.tenant_id === tenantId : true));

    if (wantsSingle(request)) {
      if (rows.length !== 1) {
        return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
      }
      return HttpResponse.json(rows[0]);
    }
    return HttpResponse.json(rows);
  }),

  // PostgREST routes an upsert through POST with `Prefer: resolution=merge-duplicates`
  // (supabase-js sends this automatically for `.upsert()`). A row with no existing
  // match takes the INSERT policy; a row that matches an existing tenant_id takes
  // the UPDATE policy — `forceInsertDenied` only blocks the former.
  http.post(`${SUPABASE_URL}/rest/v1/ai_cost_config`, async ({ request }) => {
    const body = (await request.json()) as Partial<AiCostConfigMswRow>;
    const tenantId = body.tenant_id ?? '';
    const existingIndex = state.rows.findIndex((row) => row.tenant_id === tenantId);
    const isInsert = existingIndex === -1;

    if (isInsert && state.forceInsertDenied) {
      return HttpResponse.json(
        {
          message: 'new row violates row-level security policy for table "ai_cost_config"',
          code: '42501',
        },
        { status: 403 },
      );
    }

    if (state.forceSilentZeroRowMatch) {
      // A caller requesting the single-object representation still gets a
      // real error on zero rows — this is exactly what `.select().single()`
      // buys. Without it, PostgREST just answers 2xx with nothing written.
      if (wantsSingle(request)) {
        return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
      }
      return HttpResponse.json([], { status: 201 });
    }

    const written: AiCostConfigMswRow = {
      tenant_id: tenantId,
      seat_count: body.seat_count ?? 0,
      cost_per_seat_usd: body.cost_per_seat_usd ?? 0,
    };
    if (isInsert) {
      state.rows.push(written);
    } else {
      state.rows[existingIndex] = written;
    }

    if (wantsSingle(request)) {
      return HttpResponse.json(written, { status: 201 });
    }
    return HttpResponse.json([written], { status: 201 });
  }),
];
