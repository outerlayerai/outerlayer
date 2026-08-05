/**
 * The saved-filters mutations — the glue around `authorizedAction`: authorize
 * on `trace.read` narrowed to the caller's app, run the CRUD body, and map
 * business-rule rejections (name conflict, per-app cap, not-found) into the
 * `MutationOutcome`/`DeleteOutcome` shapes the hook branches on. The context
 * + permission seams are mocked; the queries run for real against the MSW
 * `saved_trace_filters` table (RLS itself isn't exercised here — the MSW
 * table has no policies — so app_id narrowing must come from the query, not
 * a database backstop).
 */

import { createMswRestClient } from '@/test-helpers/rest-client';
import {
  seedSupabaseMswState,
  getSupabaseMswState,
  type SavedTraceFilterRow,
} from '@/test-helpers/msw-handlers';

const { loadCtxMock, checkPermMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
}));
vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));

import { saveFilter, updateFilter, removeFilter } from './actions';

const APP_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_APP_ID = '660e8400-e29b-41d4-a716-446655440000';
const FILTER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function row(overrides: Partial<SavedTraceFilterRow> & { id: string }): SavedTraceFilterRow {
  return {
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    app_id: APP_ID,
    name: 'My view',
    filter_config: { v: 1, query: 'q=foo' },
    page: 'agents-sessions',
    created_at: '2026-07-13T10:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function seedFilters(rows: SavedTraceFilterRow[]) {
  seedSupabaseMswState({ savedTraceFilters: rows });
}

function currentFilters(): readonly SavedTraceFilterRow[] {
  return getSupabaseMswState().savedTraceFilters;
}

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: 'tenant-1',
    actor: { userId: 'user-2', role: 'member' },
  });
  checkPermMock.mockResolvedValue(true);
});

describe('saveFilter', () => {
  it('authorizes on trace.read narrowed to the app, inserts, and stamps the caller as creator', async () => {
    const res = await saveFilter({
      appId: APP_ID,
      name: 'New view',
      filter_config: { v: 1, query: 'q=bar' },
      page: 'agents-sessions',
    });

    expect(res).toMatchObject({ ok: true, data: { ok: true, filter: { name: 'New view' } } });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2' }),
      'trace.read',
      APP_ID,
    );
    expect(currentFilters()[0]).toMatchObject({ app_id: APP_ID, user_id: 'user-2' });
  });

  it('denies an actor lacking trace.read on this app, writing nothing', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await saveFilter({
      appId: APP_ID,
      name: 'New view',
      filter_config: {},
      page: 'agents-sessions',
    });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(currentFilters()).toHaveLength(0);
  });

  it('rejects a duplicate (app_id, name, page) as a business-rule outcome, not a thrown error', async () => {
    seedFilters([row({ id: FILTER_ID, name: 'Dup' })]);

    const res = await saveFilter({ appId: APP_ID, name: 'Dup', filter_config: {}, page: 'agents-sessions' });

    expect(res).toMatchObject({ ok: true, data: { ok: false, reason: 'name_conflict' } });
    expect(currentFilters()).toHaveLength(1);
  });

  it('rejects the 11th filter for an app as limit_exceeded', async () => {
    seedFilters(Array.from({ length: 10 }, (_, i) => row({ id: `f-${i}`, name: `View ${i}` })));

    const res = await saveFilter({ appId: APP_ID, name: 'One more', filter_config: {}, page: 'agents-sessions' });

    expect(res).toMatchObject({ ok: true, data: { ok: false, reason: 'limit_exceeded' } });
    expect(currentFilters()).toHaveLength(10);
  });
});

describe('updateFilter', () => {
  it('narrows the update to the caller-authorized app, returning a typed not_found (not silently updating) a filterId from a different app', async () => {
    seedFilters([row({ id: FILTER_ID, app_id: OTHER_APP_ID })]);

    const res = await updateFilter({ appId: APP_ID, filterId: FILTER_ID, name: 'Renamed' });

    expect(res).toMatchObject({ ok: true, data: { ok: false, reason: 'not_found' } });
    expect(currentFilters()[0]!.name).toBe('My view');
  });

  it('returns a typed not_found for an unknown filterId, never a thrown internal_error', async () => {
    const res = await updateFilter({ appId: APP_ID, filterId: FILTER_ID, name: 'Renamed' });

    expect(res).toMatchObject({ ok: true, data: { ok: false, reason: 'not_found' } });
  });

  it('updates a teammate-created filter — saved filters are tenant-shared, user_id is provenance only', async () => {
    seedFilters([row({ id: FILTER_ID, user_id: 'user-1' })]);

    const res = await updateFilter({ appId: APP_ID, filterId: FILTER_ID, name: 'Renamed' });

    expect(res).toMatchObject({ ok: true, data: { ok: true, filter: { name: 'Renamed' } } });
    expect(currentFilters()[0]).toMatchObject({ user_id: 'user-1', name: 'Renamed' });
  });

  it('rethrows a non-PGRST116 database error as internal_error, never misreading a transient failure as not_found', async () => {
    const chain = {
      from: () => chain,
      update: () => chain,
      eq: () => chain,
      select: () => chain,
      single: async () => ({ data: null, error: { code: '08006', message: 'connection refused' } }),
    };
    loadCtxMock.mockResolvedValue({
      db: chain,
      tenantId: 'tenant-1',
      actor: { userId: 'user-2', role: 'member' },
    });

    const res = await updateFilter({ appId: APP_ID, filterId: FILTER_ID, name: 'Renamed' });

    expect(res).toMatchObject({ ok: false, error: { code: 'internal_error' } });
  });
});

describe('removeFilter', () => {
  it('deletes a teammate-created filter within the authorized app', async () => {
    seedFilters([row({ id: FILTER_ID, user_id: 'user-1' })]);

    const res = await removeFilter({ appId: APP_ID, filterId: FILTER_ID });

    expect(res).toMatchObject({ ok: true, data: { ok: true } });
    expect(currentFilters()).toHaveLength(0);
  });

  it('reports not_found for a filterId from a different app instead of deleting it', async () => {
    seedFilters([row({ id: FILTER_ID, app_id: OTHER_APP_ID })]);

    const res = await removeFilter({ appId: APP_ID, filterId: FILTER_ID });

    expect(res).toMatchObject({ ok: true, data: { ok: false, reason: 'not_found' } });
    expect(currentFilters()).toHaveLength(1);
  });
});
