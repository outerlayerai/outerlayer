/**
 * MSW handlers for the context-sync mirror port's (`services/context-sync/mirror-port.ts`)
 * remaining write/read seams not covered by `context-save.ts` / `context-sync-event.ts`:
 *   - `context_blob` — content-addressed blob existence check (`hasBlob`), a
 *     `{ count: 'exact', head: true }` query that issues a real HTTP HEAD.
 *   - `rpc/create_context_snapshot` — the atomic snapshot-creation RPC
 *     (`createSnapshot`), which writes blobs + tree entries + excluded-skill
 *     counts in one call. Every invocation is captured verbatim so tests can
 *     pin the EXACT arg shape the port sends (camelCase -> snake_case mapping,
 *     the nested array field renames).
 *
 * Tests seed via {@link seedContextSnapshotMswState}; reset via
 * {@link resetContextSnapshotMswState}.
 */


import { http, HttpResponse } from 'msw';
import { getEqParam } from '@repo/test-msw';

const SUPABASE_URL = 'http://localhost:54321';

interface ContextBlobRow {
  app_id: string;
  blob_sha: string;
}

/** The exact wire shape `createSnapshot` sends to the RPC. */
export interface CreateContextSnapshotRpcArgs {
  p_app_id: string;
  p_tenant_id: string;
  p_branch: string | null;
  p_commit_sha: string;
  p_classifier_version: number;
  p_blobs: Array<{ blob_sha: string; content: string; size: number }>;
  p_entries: Array<{ path: string; blob_sha: string; kind: string; scope_path: string }>;
  p_excluded_counts: Array<{ scopePath: string; skillName: string; count: number }>;
}

interface State {
  contextBlobs: ContextBlobRow[];
  createSnapshotCalls: CreateContextSnapshotRpcArgs[];
  /** The RPC's returned snapshot id (success), or a forced error message. */
  createSnapshotResult: string | { error: string };
  forceHasBlobError?: { message: string };
}

const defaultState = (): State => ({
  contextBlobs: [],
  createSnapshotCalls: [],
  createSnapshotResult: 'snap-generated',
});

let state: State = defaultState();

export function seedContextSnapshotMswState(seed: Partial<State>): void {
  state = { ...state, ...seed };
}

export function resetContextSnapshotMswState(): void {
  state = defaultState();
}

/** Every `create_context_snapshot` RPC call this test has captured, in order. */
export function getCreateSnapshotCalls(): ReadonlyArray<CreateContextSnapshotRpcArgs> {
  return [...state.createSnapshotCalls];
}

export const contextSnapshotHandlers = [
  // `.select('blob_sha', { count: 'exact', head: true })` issues an HTTP HEAD;
  // postgrest-js reads the row count back out of the Content-Range header.
  http.head(`${SUPABASE_URL}/rest/v1/context_blob`, ({ request }) => {
    if (state.forceHasBlobError) {
      return HttpResponse.json({ message: state.forceHasBlobError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const blobSha = getEqParam(url, 'blob_sha');
    const total = state.contextBlobs.filter(
      (b) => (appId ? b.app_id === appId : true) && (blobSha ? b.blob_sha === blobSha : true),
    ).length;
    return new HttpResponse(null, {
      status: 200,
      headers: { 'content-range': `0-${Math.max(total - 1, 0)}/${total}` },
    });
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/create_context_snapshot`, async ({ request }) => {
    const body = (await request.json()) as CreateContextSnapshotRpcArgs;
    state.createSnapshotCalls.push(body);
    if (typeof state.createSnapshotResult === 'object') {
      return HttpResponse.json(
        { message: state.createSnapshotResult.error },
        { status: 500 },
      );
    }
    return HttpResponse.json(state.createSnapshotResult);
  }),
];
