/**
 * MSW handlers for tables that env-var resolution, worker dispatch, and the
 * git webhook auth paths query, but that are NOT covered by the shared
 * supabase.ts handler (which focuses on auth + platform-admin tables).
 *
 * Specifically:
 *   - `app` extended with a few extra columns (entry_point, runtime,
 *     fly_app_name, commit_sha) — distinct from the shared `app` handler
 *     which only exposes id/tenant_id.
 *   - `git_connection` — provider + installation_id for auth resolution.
 *   - `env_var` — sorted key list for cache hash inputs.
 *
 * Tests seed via {@link seedManagedDeploymentTablesState}; reset via
 * {@link resetManagedDeploymentTablesState}.
 */

import { http, HttpResponse } from 'msw';
import {
  buildSingleResponse,
  filterByEqParams,
  getEqParam,
  projectSelectedFields,
  wantsSingle,
} from '@repo/test-msw';

const SUPABASE_URL = 'http://localhost:54321';

interface AppManagedRow {
  id: string;
  tenant_id?: string;
  entry_point?: string | null;
  runtime?: string | null;
  fly_app_name?: string | null;
  /** Last-synced HEAD — seedable for tests that exercise commit-pointer /
   *  dispatch flows keyed off the app's current commit. */
  commit_sha?: string | null;
}

interface GitConnectionRow {
  app_id: string;
  /** Tenant owner of the connection — read by the resync action to scope the
   *  sync. Optional because most consumers key off app_id alone. */
  tenant_id?: string;
  /** `'gitlab'` models a legacy row shape the schema still allows; no code path creates new ones. */
  provider: 'github' | 'gitlab';
  installation_id: number | null;
  /** Per-repo webhook secret; encrypted on the real column. Optional
   *  because most tests don't need to seed it. */
  webhook_secret?: string;
  /** owner/repo — read by the push webhook handler to find every app
   *  connected to the pushed repository. */
  repository?: string;
  /** Stale webhook pointer the disconnect flow clears — null once tidied. */
  webhook_id?: string | null;
}

export interface EnvVarRow {
  /** Row id — required for the `getValue` id-lookup path. */
  id?: string;
  app_id: string;
  /**
   * Environment the var belongs to (`NOT NULL` in the schema).
   * Seed it on rows used in env-scoped tests so `EnvVarService` queries
   * filtered by `environment_id` resolve.
   */
  environment_id?: string | null;
  /** Kind target ('all' | 'development' | 'preview' | 'promoted') for a
   *  kind-scoped row — mutually exclusive with `environment_id`. */
  target_kind?: string | null;
  key: string;
  /** Vault secret reference. The update leg reads/writes this on the row
   *  fake so tests can assert it stays unchanged across an in-place
   *  secret-value replacement (the id, unlike the value, does not change). */
  vault_secret_id?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

interface EnvironmentRow {
  /** Environment UUID — matches `environment.id`. */
  id: string;
  /** The app this env belongs to. Tests use this to validate (id, app_id) pairing. */
  app_id: string;
  name?: string;
  is_default?: boolean;
  /** Kind-classification inputs for `EnvVarService.collectAll`'s
   *  env→target-kind resolution (`@repo/env-kind` `envTargetOf`). */
  current_version?: number;
  is_ephemeral?: boolean;
}

interface State {
  apps: AppManagedRow[];
  gitConnections: GitConnectionRow[];
  envVars: EnvVarRow[];
  environments: EnvironmentRow[];
}

const defaultState = (): State => ({
  apps: [],
  gitConnections: [],
  envVars: [],
  environments: [],
});

let state: State = defaultState();

export interface CapturedGitConnectionUpdate {
  appId: string | null;
  patch: Record<string, unknown>;
  /** The `X-Tenant-Id` header the scoped client sent, or null when absent —
   *  distinguishes a request-tenant-scoped server client from an unscoped
   *  or service-role (admin) client, neither of which attaches this header. */
  tenantHeader: string | null;
}

let updatedGitConnections: CapturedGitConnectionUpdate[] = [];

export function seedManagedDeploymentTablesState(seed: Partial<State>): void {
  state = { ...state, ...seed };
}

export function resetManagedDeploymentTablesState(): void {
  state = defaultState();
  updatedGitConnections = [];
}

export function getUpdatedGitConnections(): readonly CapturedGitConnectionUpdate[] {
  return updatedGitConnections;
}

export const managedDeploymentTablesHandlers = [
  // GET /app — overrides the shared `app` handler when this file's state is
  // seeded. We register this BEFORE the shared handler in the index so it
  // wins for tests that need entry_point/runtime/fly_app_name.
  //
  // CRITICAL: when no test has seeded *our* state.apps, return undefined to
  // fall through to the shared handler. Otherwise this handler would claim
  // every /app request and break unrelated tests (e.g. analytics/tenant-context)
  // that seed via `seedSupabaseMswState({apps: [...]})` against the SHARED
  // handler's separate state.
  http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
    if (state.apps.length === 0) {
      return undefined;
    }
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const row = id
      ? (state.apps.find((a) => a.id === id) ?? null)
      : (state.apps[0] ?? null);
    return buildSingleResponse(request, row);
  }),

  // GET /git_connection — supports the auth-resolution single-row lookup
  // (by app_id) and the push webhook handler's repository-scoped LIST (it
  // dispatches context-sync to every app connected to the pushed repository).
  http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) => {
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const repository = getEqParam(url, 'repository');
    const rows = state.gitConnections.filter((c) => {
      if (appId && c.app_id !== appId) return false;
      if (repository && c.repository !== repository) return false;
      return true;
    });
    const accept = request.headers.get('accept') ?? '';
    if (accept.includes('vnd.pgrst.object')) {
      return buildSingleResponse(request, rows[0] ?? null);
    }
    return HttpResponse.json(rows);
  }),

  // PATCH /git_connection — the disconnect flow's webhook cleanup
  // (`.update({ webhook_id: null }).eq('app_id', appId)`). Captured
  // unconditionally — including an unfiltered `appId: null` mass update —
  // so a "does nothing" test that only checks `state.gitConnections` can't
  // pass against a write that actually escaped the `app_id` filter.
  http.patch(`${SUPABASE_URL}/rest/v1/git_connection`, async ({ request }) => {
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    updatedGitConnections.push({
      appId,
      patch,
      tenantHeader: request.headers.get('x-tenant-id'),
    });
    state.gitConnections = state.gitConnections.map((row) =>
      !appId || row.app_id === appId ? { ...row, ...patch } : row,
    );
    return new HttpResponse(null, { status: 204 });
  }),

  // GET /env_var — supports both shapes EnvVarService issues:
  //   - list query filtered by app_id (+ optional environment_id)
  //   - single-row lookup by id (filtered by app_id + environment_id), which
  //     the JS client sends with `.single()` so it expects an object, not an
  //     array. `buildSingleResponse` honours the Accept header for that.
  // The projected columns follow the `?select=` clause so callers asking for
  // `id, key, created_at, updated_at` get exactly those fields.
  http.get(`${SUPABASE_URL}/rest/v1/env_var`, ({ request }) => {
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const environmentId = getEqParam(url, 'environment_id');
    const id = getEqParam(url, 'id');

    const rows = state.envVars.filter((r) => {
      if (id && r.id !== id) return false;
      if (appId && r.app_id !== appId) return false;
      if (environmentId && r.environment_id !== environmentId) return false;
      return true;
    });

    const projected = rows.map((r) =>
      // `projectSelectedFields` is keyed by an open record; the row interface
      // has optional members, so widen it to the structural index signature.
      projectSelectedFields(url, r as unknown as Record<string, unknown>),
    );

    // An id-scoped query is a `.single()` lookup — defer to buildSingleResponse
    // so the Accept-header contract is honoured.
    if (id) {
      return buildSingleResponse(request, projected[0] ?? null);
    }
    return HttpResponse.json(projected);
  }),

  // DELETE /env_var — `EnvVarService.delete`'s row removal, by id
  // (scoped to app_id in the same call).
  http.delete(`${SUPABASE_URL}/rest/v1/env_var`, ({ request }) => {
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const appId = getEqParam(url, 'app_id');
    const matched = state.envVars.filter((r) => {
      if (id && r.id !== id) return false;
      if (appId && r.app_id !== appId) return false;
      return true;
    });
    state.envVars = state.envVars.filter((r) => !matched.includes(r));
    return HttpResponse.json(matched);
  }),

  // POST /env_var — `EnvVarService.set`'s insert leg
  // (`.insert({...}).select("id, key").single()`).
  http.post(`${SUPABASE_URL}/rest/v1/env_var`, async ({ request }) => {
    const body = (await request.json()) as Partial<EnvVarRow>;
    const row: EnvVarRow = {
      id: `env-var-${state.envVars.length + 1}`,
      ...body,
    } as EnvVarRow;
    state.envVars.push(row);
    return HttpResponse.json(wantsSingle(request) ? row : [row], { status: 201 });
  }),

  // PATCH /env_var — `EnvVarService.set`'s update leg
  // (`.update({ vault_secret_id }).eq("id", existing.id)`).
  http.patch(`${SUPABASE_URL}/rest/v1/env_var`, async ({ request }) => {
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const patch = (await request.json()) as Partial<EnvVarRow>;
    const matched = state.envVars.filter((r) => !id || r.id === id);
    for (const row of matched) Object.assign(row, patch);
    return HttpResponse.json(wantsSingle(request) ? (matched[0] ?? null) : matched);
  }),

  // GET /environment — supports `EnvVarService.set`'s pairing check
  // (environment.id = envId AND environment.app_id = appId) AND
  // `resolveEnvIdForStorage`'s lookups (by name, or by is_default=true for the
  // default env). The handler returns null when no row matches, which callers
  // treat as "not found" (env doesn't belong to this app / no default env).
  http.get(`${SUPABASE_URL}/rest/v1/environment`, ({ request }) => {
    if (state.environments.length === 0) return undefined;
    const url = new URL(request.url);
    // `id` / `app_id` / `name` / `is_default` filters are honored only when
    // present, so callers that filter solely by id/app_id keep their existing
    // behavior. `filterByEqParams` also honors `in.(…)`, which the batched
    // default-environment lookup in `pr-session-comment/read.ts` sends.
    const rows = filterByEqParams(
      url,
      state.environments.map((e) => ({ ...e, is_default: e.is_default ?? false })),
      ['id', 'app_id', 'name', 'is_default'],
    );
    // Single-row callers (`.single()`/`.maybeSingle()`) keep their existing
    // shape; list callers get the full filtered array.
    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }
    return HttpResponse.json(rows);
  }),
];
