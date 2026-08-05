// @vitest-environment jsdom
/**
 * Unit tests for getAppRepoLabel — the benchmarks React Server Component (RSC)'s server-side resolver
 * for the app's linked repo label.
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md): the `git_connection` table
 * lookup is an HTTP boundary, served by MSW — never a Supabase client mock/spy.
 */

import { http, HttpResponse } from 'msw';
import { buildSingleResponse } from '@repo/test-msw';
import { server } from '../../test-helpers/msw-server';
import { getAppRepoLabel } from '../get-app-repo-label';

const SUPABASE_URL = 'http://localhost:54321';

describe('getAppRepoLabel', () => {
  it("resolves the app's connected repo", async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) =>
        buildSingleResponse(request, { repository: 'acme/payments' }),
      ),
    );

    expect(await getAppRepoLabel('app-1')).toBe('acme/payments');
  });

  it('falls back to a placeholder when the app has no git connection', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) =>
        buildSingleResponse(request, null),
      ),
    );

    expect(await getAppRepoLabel('app-1')).toBe('your linked repo');
  });

  it('falls back to a placeholder when the read fails', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, () => new HttpResponse(null, { status: 500 })),
    );

    expect(await getAppRepoLabel('app-1')).toBe('your linked repo');
  });
});
