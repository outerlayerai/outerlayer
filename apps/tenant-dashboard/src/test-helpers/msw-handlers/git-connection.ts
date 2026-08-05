/**
 * MSW handlers for the git-connect OAuth callback write path.
 *
 * The callbacks derive their tenant from the HMAC-signed OAuth state and build
 * a header-scoped Supabase client from it; every PostgREST call then carries
 * `X-Tenant-Id`. These handlers capture that header on the `git_connection`
 * upsert and the `git_branch` clear so tests assert the write followed the
 * SIGNED-STATE tenant, not the session claim — the property that lets the DB
 * drop the claim arm entirely. (The callback's org-name `tenant` read is
 * served by the membership handler's `tenant` GET via `seedMembershipMswState`.)
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';

export interface CapturedGitConnectionUpsert {
  /** The `X-Tenant-Id` header the scoped client sent, or null when absent. */
  tenantHeader: string | null;
  row: Record<string, unknown>;
}

let insertedGitConnections: CapturedGitConnectionUpsert[] = [];
let deletedGitBranchTenantHeaders: (string | null)[] = [];
/** When set, the upsert answers with this PostgREST error instead of writing. */
let gitConnectionUpsertError: { code: string; message: string } | null = null;

/**
 * Make the next `git_connection` upsert fail with a PostgREST error, so a test
 * can drive the callback's handling of a constraint the database owns (the
 * global unique on `installation_id`) without a live database.
 */
export function seedGitConnectionUpsertError(error: { code: string; message: string }) {
  gitConnectionUpsertError = error;
}

export function getInsertedGitConnections(): readonly CapturedGitConnectionUpsert[] {
  return insertedGitConnections;
}

export function getDeletedGitBranchTenantHeaders(): readonly (string | null)[] {
  return deletedGitBranchTenantHeaders;
}

export function resetGitConnectionMswState() {
  insertedGitConnections = [];
  deletedGitBranchTenantHeaders = [];
  gitConnectionUpsertError = null;
}

export const gitConnectionHandlers = [
  http.post(`${SUPABASE_URL}/rest/v1/git_connection`, async ({ request }) => {
    const body = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null;
    const rows = Array.isArray(body) ? body : body ? [body] : [];
    const tenantHeader = request.headers.get('x-tenant-id');
    if (gitConnectionUpsertError) {
      const { code, message } = gitConnectionUpsertError;
      return HttpResponse.json(
        { code, message, details: null, hint: null },
        { status: 409 },
      );
    }
    for (const row of rows) {
      insertedGitConnections.push({ tenantHeader, row });
    }
    const prefer = request.headers.get('prefer') ?? '';
    if (prefer.includes('return=representation')) {
      return HttpResponse.json(rows, { status: 201 });
    }
    return new HttpResponse(null, { status: 201 });
  }),

  http.delete(`${SUPABASE_URL}/rest/v1/git_branch`, ({ request }) => {
    deletedGitBranchTenantHeaders.push(request.headers.get('x-tenant-id'));
    return new HttpResponse(null, { status: 204 });
  }),
];
