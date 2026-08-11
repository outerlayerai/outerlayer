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

const { mockSelectChain } = vi.hoisted(() => ({
  mockSelectChain: vi.fn(),
}));

function makeSupabaseStub() {
  const fromSpy = vi.fn((_table: string) => {
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range: vi.fn(() => mockSelectChain()),
    };
    return chain;
  });
  return { from: fromSpy };
}

vi.mock('../_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => Promise.resolve(makeSupabaseStub())),
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
