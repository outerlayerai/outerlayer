/**
 * MSW handlers for the two SECURITY DEFINER RPCs behind
 * `features/oauth-grants` (`68-oauth-grants.sql`):
 * `list_current_user_oauth_grants` and `revoke_current_user_oauth_grant`.
 * PostgREST routes both at `POST /rest/v1/rpc/<name>`.
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = 'http://localhost:54321';

type OAuthGrantRowFixture = {
  session_id: string;
  client_id: string;
  client_name: string | null;
  scopes: string | null;
  created_at: string;
  refreshed_at: string | null;
};

type OAuthGrantsMswState = {
  grants: OAuthGrantRowFixture[];
  /** Session ids a `revoke_current_user_oauth_grant` call succeeds for —
   * defaults to every seeded grant's id. */
  revocableSessionIds?: string[];
};

const defaultState = (): OAuthGrantsMswState => ({ grants: [] });

let state = defaultState();

export function resetOAuthGrantsMswState() {
  state = defaultState();
}

export function seedOAuthGrantsMswState(nextState: Partial<OAuthGrantsMswState>) {
  state = { ...state, ...nextState };
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export const oauthGrantsHandlers = [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/list_current_user_oauth_grants`, () => {
    return HttpResponse.json(state.grants);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/revoke_current_user_oauth_grant`, async ({ request }) => {
    const body = await readJsonBody<{ target_session_id?: string }>(request);
    const revocable = state.revocableSessionIds ?? state.grants.map((g) => g.session_id);
    const revoked = !!body.target_session_id && revocable.includes(body.target_session_id);
    if (revoked) {
      state.grants = state.grants.filter((g) => g.session_id !== body.target_session_id);
    }
    return HttpResponse.json(revoked);
  }),
];
