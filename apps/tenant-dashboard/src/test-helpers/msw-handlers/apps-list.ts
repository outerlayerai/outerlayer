/**
 * MSW handler for the org apps-list read (`features/apps/service.ts`).
 *
 * The apps-list `select` disambiguates its `git_connection` / `git_branch` /
 * `environment` embeds with explicit `!<fk_name>` hints (two composite FKs
 * relate each child table to `app`, so PostgREST needs the hint to pick
 * one) — this handler claims a request only when its `select` carries that
 * hint, so it never intercepts the other `app` MSW handlers' plain reads.
 * Rows are seeded pre-shaped (already carrying their nested embeds) since
 * MSW returns canned JSON rather than resolving a real PostgREST join.
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = 'http://localhost:54321';

export interface AppsListMswRow {
  id: string;
  name: string;
  display_name: string | null;
  created_at: string;
  updated_at: string | null;
  git_connection: Array<{
    app_id: string;
    installation_id: number | null;
    repository: string | null;
    provider: string | null;
  }>;
  git_branch: Array<{ app_id: string; branch_name: string }>;
  environment: Array<{ name: string; is_default: boolean; current_version: number }>;
}

let rows: AppsListMswRow[] = [];
let capturedSelect: string | null = null;

export function seedAppsListMswState(seed: AppsListMswRow[]): void {
  rows = seed;
}

/** The `?select=` this handler last saw — asserts the service's projection + FK hints. */
export function getCapturedAppsListSelect(): string | null {
  return capturedSelect;
}

export function resetAppsListMswState(): void {
  rows = [];
  capturedSelect = null;
}

export const appsListHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
    const url = new URL(request.url);
    const select = url.searchParams.get('select') ?? '';
    if (rows.length === 0 || !select.includes('git_connection!')) {
      return undefined;
    }
    capturedSelect = select;
    return HttpResponse.json(rows);
  }),
];
