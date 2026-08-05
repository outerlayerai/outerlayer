import { http, HttpResponse } from 'msw';
import {
  buildSingleResponse,
  filterByEqParams,
  getEqParam,
  wantsSingle,
} from '@repo/test-msw';

const SUPABASE_URL = 'http://localhost:54321';

type ApiKeyRow = {
  id: string;
  api_key_id: string;
  app_id: string;
  name: string;
  tenant_id?: string;
  /** Env pin — NULL for a kind-scoped key (it has no single env). */
  environment_id?: string | null;
  /** Env-kind scope — set ONLY on a kind-scoped key (env pin NULL). */
  allowed_env_kinds?: string[] | null;
  /** Grant surface — read by the api-key audit pre-image lookups. */
  permissions?: string[];
};

type GitBranchRow = {
  id: string;
  app_id: string;
  /** Tracked branch name — filtered by the resync action's lookup. */
  branch_name?: string;
  /** Used by the resync action's `.order('created_at', {ascending: false})`
   *  no-tracked-branch fallback (most recently created branch wins). */
  created_at?: string;
};

type EnvironmentRow = {
  id: string;
  app_id: string;
  is_default: boolean;
  /** Env name; read by the API keys settings UI's environment-scope picker. */
  name?: string;
};

type ApiKeysMswState = {
  apiKeys: ApiKeyRow[];
  gitBranches: GitBranchRow[];
  environments: EnvironmentRow[];
  /**
   * Simulates RLS hiding `environment` / `git_branch` from
   * the caller's user-scoped client (an app-scoped custom role need not grant
   * those reads). When set, the GET handlers for these tables return empty
   * results unless the request's `apikey` header equals this value — i.e.
   * unless the read came through the service-role (admin) client.
   */
  rlsServiceRoleKey: string | null;
};

const defaultState = (): ApiKeysMswState => ({
  apiKeys: [],
  gitBranches: [{ id: 'branch-1', app_id: 'app-1' }],
  // Every app has a default environment. `createApiKey`
  // resolves it before inserting the env-NOT-NULL api_key row.
  environments: [{ id: 'env-default-1', app_id: 'app-1', is_default: true, name: 'dev' }],
  rlsServiceRoleKey: null,
});

let state = defaultState();

/** True when simulated RLS hides rows from this (non-service-role) request. */
function hiddenByRls(request: Request) {
  return (
    state.rlsServiceRoleKey !== null &&
    request.headers.get('apikey') !== state.rlsServiceRoleKey
  );
}

function withCountHeaders(total: number) {
  return {
    'content-range': `0-${Math.max(total - 1, 0)}/${total}`,
    'content-type': 'application/json',
  };
}

export function resetApiKeysMswState() {
  state = defaultState();
}

export function seedApiKeysMswState(nextState: Partial<ApiKeysMswState>) {
  state = {
    ...state,
    ...nextState,
    apiKeys: nextState.apiKeys ?? state.apiKeys,
    gitBranches: nextState.gitBranches ?? state.gitBranches,
    environments: nextState.environments ?? state.environments,
  };
}

export const apiKeysHandlers = [
  // The settings list reads keys scoped by app + environment
  // (`api_key?select=...&app_id=eq.<id>&environment_id=eq.<id>`).
  http.get(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
    const url = new URL(request.url);
    let rows = filterByEqParams(url, state.apiKeys, [
      'id',
      'api_key_id',
      'app_id',
      'environment_id',
    ]);

    // The settings list now asks for "this env's pinned keys OR any kind-scoped
    // key" via `or=(environment_id.eq.<id>,allowed_env_kinds.not.is.null)`.
    const or = url.searchParams.get('or');
    if (or) {
      const envId = or.match(/environment_id\.eq\.([^,)]+)/)?.[1];
      rows = filterByEqParams(url, state.apiKeys, ['app_id']).filter(
        (k) =>
          (envId != null && k.environment_id === envId) ||
          (Array.isArray(k.allowed_env_kinds) && k.allowed_env_kinds.length > 0),
      );
    }

    return HttpResponse.json(wantsSingle(request) ? (rows[0] ?? null) : rows);
  }),

  http.head(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
    const url = new URL(request.url);
    // Simulates RLS hiding rows from a caller without api_key.read: the
    // entitlement count read runs service-role for exactly this reason.
    const visible = hiddenByRls(request) ? [] : state.apiKeys;
    const apiKeys = filterByEqParams(url, visible, ['tenant_id']);

    return new HttpResponse(null, {
      status: 200,
      headers: withCountHeaders(apiKeys.length),
    });
  }),

  http.get(`${SUPABASE_URL}/rest/v1/git_branch`, ({ request }) => {
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    // Queued-push promotion narrows to the tracked branch and reads with
    // `.maybeSingle()` — honor the filter and the single-object Accept.
    const branchName = getEqParam(url, 'branch_name');
    const visible = hiddenByRls(request) ? [] : state.gitBranches;
    let rows = visible.filter((branch) => {
      if (appId && branch.app_id !== appId) return false;
      if (branchName && (branch as { branch_name?: string }).branch_name !== branchName) return false;
      return true;
    });

    // `.order('created_at', { ascending: false|true })` — the resync action's
    // no-tracked-branch fallback picks the most/least recently created row.
    // PostgREST encodes this as `?order=created_at.desc|asc`.
    const order = url.searchParams.get('order');
    if (order === 'created_at.desc' || order === 'created_at.asc') {
      const sign = order === 'created_at.desc' ? -1 : 1;
      rows = [...rows].sort(
        (a, b) => sign * (Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '')),
      );
    }
    // `.limit(n)` — must actually slice server-side: a GET `.maybeSingle()`
    // unwraps client-side (postgrest-js issue #361 workaround) and treats an
    // array with MORE THAN ONE row as an error (PGRST116, "multiple rows
    // returned"), silently resolving to `data: null` — so without this, a
    // fixture with >1 matching row makes `.order().limit(1).maybeSingle()`
    // look like "no row found" instead of picking the ordered top row.
    const limit = url.searchParams.get('limit');
    if (limit !== null) rows = rows.slice(0, Number(limit));

    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }
    return HttpResponse.json(rows);
  }),

  // `resolveDefaultEnvironmentId` issues
  // `environment?select=id&app_id=eq.<id>&is_default=eq.true` with a
  // single-object Accept header. The annotation-queue create route instead
  // resolves a specific env by `id=eq.<id>&app_id=eq.<id>` to denormalize its
  // name, so this handler also honours an `id` filter.
  http.get(`${SUPABASE_URL}/rest/v1/environment`, ({ request }) => {
    const url = new URL(request.url);
    // RLS gating (origin) + env resolution by app_id/id/name/is_default.
    // `name` — `resolveEnvIdForStorage` resolves an explicit env selection by
    // name.
    const visible = hiddenByRls(request) ? [] : state.environments;
    const rows = filterByEqParams(url, visible, [
      'app_id',
      'id',
      'name',
      'is_default',
    ]);
    const row = rows[0] ?? null;

    if (!row && wantsSingle(request)) {
      // `.maybeSingle()` tolerates zero rows — PostgREST returns null body.
      return HttpResponse.json(null);
    }

    return HttpResponse.json(wantsSingle(request) ? row : rows);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/api_key`, async ({ request }) => {
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    const insertedRows = rows.map((row, index) => ({
      id: `api-key-${state.apiKeys.length + index + 1}`,
      ...(row as Omit<ApiKeyRow, 'id'>),
    }));

    state.apiKeys.push(...insertedRows);

    return HttpResponse.json(wantsSingle(request) ? insertedRows[0] : insertedRows, {
      status: 201,
    });
  }),

  // Row revocation — key deletion is a plain row delete (the digest cascades).
  // Used by the settings delete action and the eval-run key rollback/revoke.
  http.delete(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
    const url = new URL(request.url);
    const matched = filterByEqParams(url, state.apiKeys, [
      'id',
      'api_key_id',
      'app_id',
      'name',
    ]);
    state.apiKeys = state.apiKeys.filter((key) => !matched.includes(key));
    return HttpResponse.json(matched);
  }),
];
