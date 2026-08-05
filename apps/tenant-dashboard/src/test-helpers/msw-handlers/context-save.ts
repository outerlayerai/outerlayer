/**
 * MSW handlers for the mirror tables the context save-path service's
 * production ports (`services/context-save/production-ports.ts`) read that
 * aren't covered elsewhere:
 *   - `context_head` — current synced (commit_sha, snapshot_id) per (app, branch).
 *   - `context_tree_entry` — snapshot membership (path -> blob_sha), including
 *     the prefix `like.` scan `snapshotPaths` issues for a skill-dir listing.
 *
 * Also backs the context-sync mirror port's (`services/context-sync/mirror-port.ts`)
 * single-table pointer move — `advanceHead`'s `context_head` PATCH, captured
 * into {@link getPatchedContextHeads} so tests can pin the exact update payload
 * (commit_sha/snapshot_id/synced_at) and the (app_id, branch) filter.
 *
 * `git_connection` and `git_branch` are covered by `managed-deployment-tables.ts`
 * (`seedManagedDeploymentTablesState`) and `api-keys.ts`
 * (`seedApiKeysMswState({ gitBranches: [...] })`) respectively; `app.require_pull_request`
 * by the shared `supabase.ts` `app` handler (`seedSupabaseMswState`) — not
 * duplicated here.
 *
 * Tests seed via {@link seedContextSaveMswState}; reset via
 * {@link resetContextSaveMswState}.
 */


import { http, HttpResponse } from 'msw';
import { buildSingleResponse, getEqParam } from '@repo/test-msw';

const SUPABASE_URL = 'http://localhost:54321';

interface ContextHeadRow {
  app_id: string;
  branch: string;
  snapshot_id: string;
}

interface ContextTreeEntryRow {
  snapshot_id: string;
  path: string;
  blob_sha: string;
}

export interface PatchedContextHead {
  appId: string;
  branch: string;
  update: Record<string, unknown>;
}

interface State {
  contextHeads: ContextHeadRow[];
  contextTreeEntries: ContextTreeEntryRow[];
  patchedContextHeads: PatchedContextHead[];
  /** Force `advanceHead`'s PATCH to return a PostgREST error envelope. */
  forceContextHeadPatchError?: { message: string };
}

const defaultState = (): State => ({
  contextHeads: [],
  contextTreeEntries: [],
  patchedContextHeads: [],
});

let state: State = defaultState();

export function seedContextSaveMswState(seed: Partial<State>): void {
  state = { ...state, ...seed };
}

export function resetContextSaveMswState(): void {
  state = defaultState();
}

/** Every `context_head` PATCH this test has captured, in call order. */
export function getPatchedContextHeads(): ReadonlyArray<PatchedContextHead> {
  return [...state.patchedContextHeads];
}

/** `?column=like.<pattern>` — PostgREST SQL-LIKE, `%` as the wildcard. Only a single trailing `%` is needed here (the service always builds `${prefix}/%`). */
function likeMatches(value: string, pattern: string): boolean {
  if (pattern.endsWith('%')) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

export const contextSaveHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/context_head`, ({ request }) => {
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const branch = getEqParam(url, 'branch');
    const row =
      state.contextHeads.find(
        (r) => (appId ? r.app_id === appId : true) && (branch ? r.branch === branch : true),
      ) ?? null;
    return buildSingleResponse(request, row);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/context_tree_entry`, ({ request }) => {
    const url = new URL(request.url);
    const snapshotId = getEqParam(url, 'snapshot_id');
    // `getEqParam` only strips an `eq.` prefix — a `like.` filter comes back
    // through it unchanged, so it must be excluded before treating "path" as
    // an exact-match filter (an earlier bug here filtered out every row
    // whenever `snapshotPaths` issued its `like.` scan).
    const rawPath = url.searchParams.get('path');
    const isLikeFilter = rawPath?.startsWith('like.') ?? false;
    const path = isLikeFilter ? null : getEqParam(url, 'path');
    const pathLike = isLikeFilter ? rawPath!.slice(5) : null;

    const rows = state.contextTreeEntries.filter((r) => {
      if (snapshotId && r.snapshot_id !== snapshotId) return false;
      if (path && r.path !== path) return false;
      if (pathLike && !likeMatches(r.path, pathLike)) return false;
      return true;
    });

    if (path) {
      // `headBlobSha` — a `.maybeSingle()` exact-path lookup.
      return buildSingleResponse(request, rows[0] ?? null);
    }
    // `snapshotPaths` — a plain list query (including the `like.` scan).
    return HttpResponse.json(rows);
  }),

  // PATCH /context_head — `advanceHead`'s single-table pointer move (no new
  // snapshot). Captures the exact (app_id, branch) filter + update payload so
  // tests can pin them, and applies the update in place so a subsequent GET
  // reflects it.
  http.patch(`${SUPABASE_URL}/rest/v1/context_head`, async ({ request }) => {
    if (state.forceContextHeadPatchError) {
      return HttpResponse.json(
        { message: state.forceContextHeadPatchError.message },
        { status: 500 },
      );
    }
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const branch = getEqParam(url, 'branch');
    const update = (await request.json()) as Record<string, unknown>;
    if (appId && branch) {
      state.patchedContextHeads.push({ appId, branch, update });
      const row = state.contextHeads.find((r) => r.app_id === appId && r.branch === branch);
      if (row) Object.assign(row, update);
    }
    return HttpResponse.json([], { status: 200 });
  }),
];
