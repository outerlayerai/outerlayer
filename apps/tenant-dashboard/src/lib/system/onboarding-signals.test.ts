/**
 * Tests for the service-role onboarding counts.
 *
 *  - `safeCount`/`safeMaybeRow` are pure guards: a Supabase `{ count, error }` /
 *    `{ data, error }` result becomes a number/row that NEVER throws and NEVER
 *    goes null-then-crash, so one broken signal can't collapse the whole
 *    checklist.
 *  - `countOnboardingSignals` is exercised end-to-end against MSW (the Supabase
 *    HTTP boundary). We assert BOTH the returned counts and the SCOPING — api
 *    keys / git are filtered by `app_id`, members by `tenant_id` + status —
 *    because that scoping is the security contract: the service-role client is
 *    steered only by the verified `TenantContext`.
 *
 * Per the tenant-dashboard testing rules the Supabase client is faked via MSW,
 * never a hand-rolled query-builder. `config-global.server` is a true seam
 * (server config) and may be `vi.mock`ed.
 */

vi.mock('server-only', () => ({}));

// The service-role client reads the service-role key from server config —
// provide it (the same seam the api-keys actions test mocks).
vi.mock('@/config-global.server', () => ({
  SUPABASE_SECRET_KEY: 'test-service-role-key',
  UNKEY_API_KEY: 'test-key',
}));

import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { buildSingleResponse } from '@repo/test-msw';
import { server } from '../../test-helpers/msw-server';
import { safeCount, safeMaybeRow, countOnboardingSignals } from './onboarding-signals';
import type { TenantContext } from '@/lib/analytics/tenant-context';

const SUPABASE_URL = 'http://localhost:54321';
/** Parse a PostgREST `?col=eq.value` filter. Pure URL parsing, not a client mock. */
const eqParam = (url: URL, key: string) => {
  const v = url.searchParams.get(key);
  return v?.startsWith('eq.') ? v.slice(3) : v;
};
/** PostgREST returns a head-count in the Content-Range header (`0-(n-1)/n`). */
const countHeaders = (n: number) => ({ 'content-range': `0-${Math.max(n - 1, 0)}/${n}` });

const ctx = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  appId: 'app-1',
  dataRetentionDays: -1,
} as unknown as TenantContext;

describe('safeCount', () => {
  it('returns the count when the query resolves with a number', async () => {
    await expect(safeCount(Promise.resolve({ count: 5, error: null }))).resolves.toBe(5);
  });

  it('returns 0 when the resolved count is null (failed count, not a throw)', async () => {
    await expect(
      safeCount(Promise.resolve({ count: null, error: { message: 'boom' } })),
    ).resolves.toBe(0);
  });

  it('returns 0 when the query rejects (client itself threw)', async () => {
    await expect(safeCount(Promise.reject(new Error('network down')))).resolves.toBe(0);
  });

  it('passes a real zero straight through (does not coerce 0 away)', async () => {
    await expect(safeCount(Promise.resolve({ count: 0, error: null }))).resolves.toBe(0);
  });
});

describe('safeMaybeRow', () => {
  it('returns the row when the query resolves with data', async () => {
    await expect(
      safeMaybeRow(Promise.resolve({ data: { provider: 'github' }, error: null })),
    ).resolves.toEqual({ provider: 'github' });
  });

  it('returns null for a no-row result and for an error payload', async () => {
    await expect(safeMaybeRow(Promise.resolve({ data: null, error: null }))).resolves.toBeNull();
    await expect(
      safeMaybeRow(Promise.resolve({ data: null, error: { message: 'boom' } })),
    ).resolves.toBeNull();
  });

  it('returns null when the query rejects (client itself threw)', async () => {
    await expect(safeMaybeRow(Promise.reject(new Error('network down')))).resolves.toBeNull();
  });
});

describe('countOnboardingSignals', () => {
  it('app-scopes api keys + git, tenant-scopes members + status, and returns every count', async () => {
    // Capture the actual filters PostgREST received so the scoping is pinned.
    let apiKeyAppId: string | null = null;
    let apiKeyTenantId: string | null = null;
    let memberTenantId: string | null = null;
    let memberStatusFilter: string | null = null;
    let gitConnAppId: string | null = null;
    let gitBranchAppId: string | null = null;

    server.use(
      http.head(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
        const url = new URL(request.url);
        apiKeyAppId = eqParam(url, 'app_id');
        apiKeyTenantId = eqParam(url, 'tenant_id');
        return new HttpResponse(null, { status: 200, headers: countHeaders(3) });
      }),
      http.head(`${SUPABASE_URL}/rest/v1/membership`, ({ request }) => {
        const url = new URL(request.url);
        memberTenantId = eqParam(url, 'tenant_id');
        memberStatusFilter = url.searchParams.get('status');
        return new HttpResponse(null, { status: 200, headers: countHeaders(4) });
      }),
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) => {
        const url = new URL(request.url);
        gitConnAppId = eqParam(url, 'app_id');
        return buildSingleResponse(request, {
          provider: 'github',
          installation_id: 'inst-9',
        });
      }),
      http.head(`${SUPABASE_URL}/rest/v1/git_branch`, ({ request }) => {
        const url = new URL(request.url);
        gitBranchAppId = eqParam(url, 'app_id');
        return new HttpResponse(null, { status: 200, headers: countHeaders(2) });
      }),
    );

    const result = await countOnboardingSignals(ctx);

    expect(result).toEqual({
      apiKeyCount: 3,
      memberCount: 4,
      gitProvider: 'github',
      gitInstallationId: 'inst-9',
      gitBranchCount: 2,
    });

    // Scoping contract (the reviewed bug): keys are app-bound, NOT tenant-bound.
    expect(apiKeyAppId).toBe('app-1');
    expect(apiKeyTenantId).toBeNull();
    // Members are tenant-scoped and limited to active/pending.
    expect(memberTenantId).toBe('tenant-1');
    expect(memberStatusFilter).toBe('in.(active,pending)');
    // Git connection + branch are app-bound, like keys.
    expect(gitConnAppId).toBe('app-1');
    expect(gitBranchAppId).toBe('app-1');
  });

  it('degrades each signal independently — a 500 on one query never zeroes the others', async () => {
    server.use(
      // api_key count and git_connection lookup fail outright …
      http.head(`${SUPABASE_URL}/rest/v1/api_key`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
      // … while membership and git_branch still return real counts.
      http.head(`${SUPABASE_URL}/rest/v1/membership`, () =>
        new HttpResponse(null, { status: 200, headers: countHeaders(2) }),
      ),
      http.head(`${SUPABASE_URL}/rest/v1/git_branch`, () =>
        new HttpResponse(null, { status: 200, headers: countHeaders(1) }),
      ),
    );

    const result = await countOnboardingSignals(ctx);

    // Member + branch survive; the broken key count and git lookup fall back to
    // 0/null without dragging anything else down.
    expect(result).toEqual({
      apiKeyCount: 0,
      memberCount: 2,
      gitProvider: null,
      gitInstallationId: null,
      gitBranchCount: 1,
    });
  });

  it('reports no-git as nulls when the app has no connection row', async () => {
    server.use(
      http.head(`${SUPABASE_URL}/rest/v1/api_key`, () =>
        new HttpResponse(null, { status: 200, headers: countHeaders(1) }),
      ),
      http.head(`${SUPABASE_URL}/rest/v1/membership`, () =>
        new HttpResponse(null, { status: 200, headers: countHeaders(1) }),
      ),
      // No git_connection row for this app — the PostgREST no-row contract.
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) =>
        buildSingleResponse(request, null),
      ),
      http.head(`${SUPABASE_URL}/rest/v1/git_branch`, () =>
        new HttpResponse(null, { status: 200, headers: countHeaders(0) }),
      ),
    );

    const result = await countOnboardingSignals(ctx);

    expect(result).toEqual({
      apiKeyCount: 1,
      memberCount: 1,
      gitProvider: null,
      gitInstallationId: null,
      gitBranchCount: 0,
    });
  });
});
