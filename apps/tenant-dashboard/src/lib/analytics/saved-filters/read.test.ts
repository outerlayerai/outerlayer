/**
 * `listSavedFilters` — the React Server Component (RSC) read an
 * agent-sessions/traces/requests
 * page seeds `useSavedViews` with. Runs the app+page projection against a
 * real client so the query shape (columns, filters, ordering) is exercised
 * against the MSW table.
 */

import { http, HttpResponse } from 'msw';
import { createMswRestClient } from '@/test-helpers/rest-client';
import { seedSupabaseMswState, type SavedTraceFilterRow } from '@/test-helpers/msw-handlers';
import { server } from '@/test-helpers/msw-server';

import { listSavedFilters } from './read';

const APP_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_APP_ID = '660e8400-e29b-41d4-a716-446655440000';

function row(overrides: Partial<SavedTraceFilterRow> & { id: string; name: string }): SavedTraceFilterRow {
  return {
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    app_id: APP_ID,
    filter_config: { v: 1, query: 'q=foo' },
    page: 'agents-sessions',
    created_at: '2026-07-13T10:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

it('returns only the app+page match, name-ascending, excluding a different app and a different page', async () => {
  seedSupabaseMswState({
    savedTraceFilters: [
      row({ id: 'f-1', name: 'Zebra' }),
      row({ id: 'f-2', name: 'Alpha' }),
      row({ id: 'f-3', name: 'Middle', page: 'traces' }),
      row({ id: 'f-4', name: 'Foreign', app_id: OTHER_APP_ID }),
    ],
  });

  const result = await listSavedFilters(createMswRestClient(), { appId: APP_ID, page: 'agents-sessions' });

  expect(result.map((f) => f.name)).toEqual(['Alpha', 'Zebra']);
});

it('returns an empty list when nothing matches, never throwing', async () => {
  const result = await listSavedFilters(createMswRestClient(), { appId: APP_ID, page: 'agents-sessions' });

  expect(result).toEqual([]);
});

it('requests name-ascending order explicitly on the wire, not just an incidentally-sorted mock', async () => {
  // The seeded mock always returns rows pre-sorted ascending regardless of
  // the query, so the first test alone can't tell `{ascending: true}` from
  // `{ascending: false}` (or from no order clause at all). Intercept the
  // actual request and assert the `order` param PostgREST would receive.
  let orderParam: string | null = null;
  server.use(
    http.get('http://localhost:54321/rest/v1/saved_trace_filters', ({ request }) => {
      orderParam = new URL(request.url).searchParams.get('order');
      return HttpResponse.json([]);
    }),
  );

  await listSavedFilters(createMswRestClient(), { appId: APP_ID, page: 'agents-sessions' });

  expect(orderParam).toBe('name.asc');
});

it('throws when the underlying query errors, instead of silently returning an empty list', async () => {
  server.use(
    http.get('http://localhost:54321/rest/v1/saved_trace_filters', () =>
      HttpResponse.json({ message: 'connection refused' }, { status: 500 }),
    ),
  );

  await expect(
    listSavedFilters(createMswRestClient(), { appId: APP_ID, page: 'agents-sessions' }),
  ).rejects.toThrow('Failed to fetch saved filters');
});
