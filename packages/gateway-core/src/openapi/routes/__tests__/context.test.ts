/**
 * Unit tests for `ListContextChanges` (GET /v1/context/changes).
 *
 * Pins two invariants a wiring-only test would miss:
 *   - App scoping: the query filters on the caller's `appId`, not just
 *     tenant (RLS on `context_snapshot` only owes tenant isolation for the
 *     gateway role — see `95-gateway-rls.sql`).
 *   - A genuine Supabase error surfaces as 500, never as an
 *     indistinguishable 200 + empty page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSelectChain, lastStub } = vi.hoisted(() => ({
  mockSelectChain: vi.fn(),
  lastStub: { current: null as null | ReturnType<typeof makeSupabaseStub> },
}));

function makeSupabaseStub() {
  const select = vi.fn(() => chain);
  const eq = vi.fn(() => chain);
  const order = vi.fn(() => chain);
  const range = vi.fn(() => mockSelectChain());
  const chain: Record<string, unknown> = { select, eq, order, range };
  const fromSpy = vi.fn((_table: string) => chain);
  return { from: fromSpy, select, eq, order, range };
}

vi.mock('../_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => {
      lastStub.current = makeSupabaseStub();
      return Promise.resolve(lastStub.current);
    }),
  };
});

import type { AppContext } from '../_shared';
import { ListContextChanges } from '../context';

function buildContext(): AppContext {
  return {
    req: { method: 'GET', path: '/v1/context/changes' },
    env: {},
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1' } : undefined)),
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as AppContext;
}

function routeWithValidatedData(query: Record<string, unknown>): ListContextChanges {
  const route = new ListContextChanges({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof ListContextChanges>[0]);
  route.getValidatedData = vi.fn().mockResolvedValue({ query });
  return route;
}

const SNAPSHOT_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  commit_sha: 'deadbeef',
  classifier_version: 3,
  created_at: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ListContextChanges', () => {
  it('projects rows to camelCase and passes through the exact total', async () => {
    mockSelectChain.mockResolvedValue({ data: [SNAPSHOT_ROW], error: null, count: 1 });

    const route = routeWithValidatedData({ limit: 20, offset: 0 });
    const c = buildContext();
    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: {
        snapshots: [
          {
            id: SNAPSHOT_ROW.id,
            commitSha: 'deadbeef',
            classifierVersion: 3,
            createdAt: SNAPSHOT_ROW.created_at,
          },
        ],
        pagination: { total: 1, limit: 20, offset: 0 },
      },
    });
  });

  it('scopes by app id, orders newest-first, and ranges by offset..offset+limit-1', async () => {
    mockSelectChain.mockResolvedValue({ data: [], error: null, count: 0 });

    const route = routeWithValidatedData({ limit: 10, offset: 20 });
    await route.handle(buildContext());

    expect(lastStub.current!.select).toHaveBeenCalledWith('id, commit_sha, classifier_version, created_at', {
      count: 'exact',
    });
    expect(lastStub.current!.eq).toHaveBeenCalledWith('app_id', 'app-1');
    expect(lastStub.current!.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(lastStub.current!.range).toHaveBeenCalledWith(20, 29);
  });

  it('ranges a single-row page (limit 1) to exactly [offset, offset], not [offset, offset+1]', async () => {
    mockSelectChain.mockResolvedValue({ data: [], error: null, count: 0 });

    const route = routeWithValidatedData({ limit: 1, offset: 5 });
    await route.handle(buildContext());

    expect(lastStub.current!.range).toHaveBeenCalledWith(5, 5);
  });

  it('returns 200 + empty page when there are no snapshots yet', async () => {
    mockSelectChain.mockResolvedValue({ data: [], error: null, count: 0 });

    const route = routeWithValidatedData({ limit: 20, offset: 0 });
    const c = buildContext();
    const result = (await route.handle(c)) as { body: { data: { snapshots: unknown[] } }; status: number };

    expect(result.status).toBe(200);
    expect(result.body.data.snapshots).toEqual([]);
  });

  it('returns 500 (not 200 + empty page) when the query errors', async () => {
    mockSelectChain.mockResolvedValue({ data: null, error: { message: 'connection reset' }, count: null });

    const route = routeWithValidatedData({ limit: 20, offset: 0 });
    const c = buildContext();
    const result = (await route.handle(c)) as { body: { error: { code: string } }; status: number };

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal_error');
  });
});
