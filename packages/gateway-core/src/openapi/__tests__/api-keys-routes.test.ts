/**
 * API Keys route-handler tests — GET machine-key exclusion + DELETE revoke.
 *
 * The integration suite (apps/integration-tests/src/tests/api-keys/) covers
 * happy paths and cross-tenant isolation against live Supabase. This file
 * fills the unit-layer gaps those can't script cheaply:
 *
 *   - GET: the list MUST filter `is_machine = false` so managed-build /
 *     deployment SDK keys never appear in the user-facing list.
 *   - DELETE: revocation is now a single Postgres row delete — there is no
 *     external key provider to call and nothing to keep in sync. The digest
 *     cascades (ON DELETE CASCADE), so deleting the row stops verification.
 *       - lookup miss / lookup error → 404, no delete attempted
 *       - delete error → 500, row preserved (caller can retry)
 *       - delete ok → 204
 *
 * Visible-state-matches-auth-state: a 204 means the row (and its cascaded
 * digest) is gone, so the key can no longer authenticate; a 500 leaves the
 * row intact so it still both lists and verifies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Supabase stub — records the query-builder calls so we can assert the
// machine-key filter and the single delete keyed by the resolved row id.
// ---------------------------------------------------------------------------

const eqSpy = vi.fn(); // every `.eq(col, val)` on a SELECT chain
const deleteEqSpy = vi.fn(); // the `.eq(col, val)` on the DELETE chain
const lookupMaybeSingle = vi.fn(); // `.select().eq().eq().maybeSingle()` terminal
const listTerminal = vi.fn(); // `.select().eq().eq().order().range()` terminal
const deleteResult = vi.fn(); // `.delete().eq()` resolved value

function makeSupabaseStub() {
  return {
    from: vi.fn((_table: string) => {
      const selectChain: Record<string, unknown> = {
        eq: vi.fn((col: string, val: unknown) => {
          eqSpy(col, val);
          return selectChain;
        }),
        order: vi.fn(() => ({ range: vi.fn(() => listTerminal()) })),
        maybeSingle: lookupMaybeSingle,
      };
      return {
        select: vi.fn(() => selectChain),
        delete: vi.fn(() => ({
          eq: vi.fn((col: string, val: unknown) => {
            deleteEqSpy(col, val);
            return deleteResult();
          }),
        })),
      };
    }),
  };
}

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => Promise.resolve(makeSupabaseStub())),
  };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { ListApiKeys, RevokeApiKey } from '../routes/api-keys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Captured {
  body: unknown;
  status: number;
}

function makeDeleteContext(opts: { apiKeyId: string }): {
  ctx: AppContext;
  captured: () => Captured | null;
} {
  let captured: Captured | null = null;
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'user'
        ? { appId: 'app-uuid-1', tenantId: 'tenant-uuid-1', authMode: 'apikey', permissions: [] }
        : undefined,
    ),
    env: {},
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: { method: 'DELETE', path: `/v1/api-keys/${opts.apiKeyId}` },
  } as unknown as AppContext;

  return { ctx, captured: () => captured };
}

function makeQueryContext(): { ctx: AppContext; captured: () => Captured | null } {
  let captured: Captured | null = null;
  const ctx = {
    get: vi.fn((k: string) =>
      // No apiKeyId → the caller-env lookup is skipped and the list runs
      // straight through the app_id + is_machine filters.
      k === 'user' ? { appId: 'app-uuid-1', tenantId: 'tenant-uuid-1' } : undefined,
    ),
    env: {},
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: { method: 'GET', path: '/v1/api-keys' },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

// Chanfana's BaseRoute requires a route-options object.
const REVOKE_ROUTE_OPTIONS = {
  router: {},
  raiseUnknownParameters: false,
  route: '/v1/api-keys/{apiKeyId}',
  urlParams: ['apiKeyId'],
};

async function invokeRevoke(ctx: AppContext, apiKeyId: string): Promise<Response> {
  const route = new RevokeApiKey(REVOKE_ROUTE_OPTIONS as any);
  (route as unknown as { getValidatedData: () => Promise<unknown> }).getValidatedData =
    async () => ({ params: { apiKeyId } });
  return (await route.handle(ctx)) as Response;
}

async function invokeList(ctx: AppContext): Promise<void> {
  const route = new ListApiKeys(REVOKE_ROUTE_OPTIONS as any);
  (route as unknown as { getValidatedData: () => Promise<unknown> }).getValidatedData =
    async () => ({ query: { limit: 50, offset: 0 } });
  await route.handle(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ListApiKeys — excludes machine-minted keys', () => {
  it('constrains the list to is_machine = false (managed-build keys are hidden)', async () => {
    listTerminal.mockResolvedValue({
      data: [
        {
          id: 'row-1',
          app_id: 'app-uuid-1',
          name: 'CI key',
          created_at: '2026-04-01T00:00:00.000Z',
          environment_id: 'env-1',
          key_prefix: 'sk_outerlayer_ci01',
          permissions: [],
          expires_at: null,
        },
      ],
      count: 1,
      error: null,
    });

    const { ctx, captured } = makeQueryContext();
    await invokeList(ctx);

    expect(captured()?.status).toBe(200);
    // Both scoping filters are applied: tenant/app scope AND the machine-key
    // exclusion. Dropping the is_machine filter leaks deployment SDK keys.
    expect(eqSpy).toHaveBeenCalledWith('app_id', 'app-uuid-1');
    expect(eqSpy).toHaveBeenCalledWith('is_machine', false);
  });
});

describe('RevokeApiKey — single Postgres row delete (no external provider)', () => {
  it('returns 404 when the lookup finds no row, and attempts no delete', async () => {
    lookupMaybeSingle.mockResolvedValue({ data: null, error: null });

    const { ctx, captured } = makeDeleteContext({ apiKeyId: 'row-1' });
    await invokeRevoke(ctx, 'row-1');

    expect(captured()).toEqual({
      status: 404,
      body: expect.objectContaining({
        error: expect.objectContaining({ code: 'api_key_not_found' }),
      }),
    });
    expect(deleteEqSpy).not.toHaveBeenCalled();
  });

  it('returns 404 when the lookup itself errors, and attempts no delete', async () => {
    lookupMaybeSingle.mockResolvedValue({ data: null, error: { message: 'pg blip' } });

    const { ctx, captured } = makeDeleteContext({ apiKeyId: 'row-1' });
    await invokeRevoke(ctx, 'row-1');

    expect(captured()?.status).toBe(404);
    expect((captured()?.body as { error: { code: string } }).error.code).toBe('api_key_not_found');
    expect(deleteEqSpy).not.toHaveBeenCalled();
  });

  it('returns 500 + api_key_revoke_failed and preserves the row when the delete fails', async () => {
    lookupMaybeSingle.mockResolvedValue({
      data: { id: 'row-1', app_id: 'app-uuid-1' },
      error: null,
    });
    deleteResult.mockResolvedValue({ error: { message: 'pg deadlock' } });

    const { ctx, captured } = makeDeleteContext({ apiKeyId: 'row-1' });
    await invokeRevoke(ctx, 'row-1');

    expect(captured()?.status).toBe(500);
    expect((captured()?.body as { error: { code: string } }).error.code).toBe(
      'api_key_revoke_failed',
    );
    // The delete was attempted, keyed by the resolved row id — but it errored,
    // so the row (and its cascaded digest) survives for a retry.
    expect(deleteEqSpy).toHaveBeenCalledWith('id', 'row-1');
  });

  it('returns 204 and deletes exactly one row, keyed by the resolved row id', async () => {
    lookupMaybeSingle.mockResolvedValue({
      data: { id: 'row-1', app_id: 'app-uuid-1' },
      error: null,
    });
    deleteResult.mockResolvedValue({ error: null });

    const { ctx, captured } = makeDeleteContext({ apiKeyId: 'row-1' });
    const res = await invokeRevoke(ctx, 'row-1');

    expect(res.status).toBe(204);
    // 204 has no JSON body — nothing was passed through c.json.
    expect(captured()).toBeNull();
    // Revocation IS a single row delete by primary key; no provider round-trip.
    expect(deleteEqSpy).toHaveBeenCalledTimes(1);
    expect(deleteEqSpy).toHaveBeenCalledWith('id', 'row-1');
  });
});
