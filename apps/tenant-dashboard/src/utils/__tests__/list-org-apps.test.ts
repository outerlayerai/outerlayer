// @vitest-environment jsdom
/**
 * Unit tests for listOrgApps — the server-side companion to the breadcrumb
 * AppSelect's app list. It lists the apps visible to the caller within the
 * request tenant (RLS-scoped), ordered alphabetically, so the `[appName]`
 * layout can seed the breadcrumb once instead of the client running its own
 * SWR-backed query.
 *
 * Per the tenant-dashboard testing rules the Supabase client is faked via
 * MSW (the HTTP boundary), never a hand-rolled query-builder — so the
 * ordering call is pinned by inspecting the actual outgoing `order` query
 * param, not a mocked `.order()` spy.
 */

import { http, HttpResponse } from 'msw';
import { server } from '../../test-helpers/msw-server';
import { listOrgApps } from '../list-org-apps';

const SUPABASE_URL = 'http://localhost:54321';

describe('listOrgApps', () => {
  it('lists apps ordered ascending by name (the breadcrumb scan order)', async () => {
    let orderParam: string | null = null;
    let selectParam: string | null = null;
    const rows = [
      { id: 'id-a', name: 'app-a', display_name: 'Triage Bot' },
      { id: 'id-b', name: 'app-b', display_name: null },
    ];
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
        const url = new URL(request.url);
        orderParam = url.searchParams.get('order');
        selectParam = url.searchParams.get('select');
        return HttpResponse.json(rows);
      }),
    );

    const result = await listOrgApps();

    expect(result).toEqual(rows);
    // Ascending, not descending — a flipped `ascending` would reverse the
    // breadcrumb's scan order.
    expect(orderParam).toBe('name.asc');
    expect(selectParam).toBe('id,name,display_name');
  });

  it('returns an empty array, not null, when the read resolves no rows', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/app`, () => HttpResponse.json(null)),
    );

    const result = await listOrgApps();

    expect(result).toEqual([]);
  });
});
