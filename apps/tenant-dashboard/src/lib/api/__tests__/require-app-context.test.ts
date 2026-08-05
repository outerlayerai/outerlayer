/**
 * Tests: requireAppContext resolves + verifies the app under the URL-derived
 * tenant only.
 *
 * The tenant is observable through MSW here because verifyAppAccess filters the
 * `app` lookup by `tenant_id`, and the shared supabase handler honors that eq
 * filter — so an app seeded under the URL tenant but not the claim tenant proves
 * which tenant the gatekeeper scoped the check to. Boundary: MSW over the
 * Supabase HTTP traffic (per apps/tenant-dashboard/CLAUDE.md), the JWT from the
 * seeded session cookie, and the middleware-derived header controlled through
 * next/headers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { getSupabaseTestCookieStore } from '../../../test-helpers/supabase-session';

vi.mock('server-only', () => ({}));

const headersGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { requireAppContext } from '../require-app-context';
import {
  seedSupabaseAuth,
  seedSupabaseMswState,
} from '../../../test-helpers/msw-handlers';

const CLAIM_TENANT = 'tenant-claim';
const URL_TENANT = 'tenant-url';
const APP_ID = 'app-1';

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { tenant_id: CLAIM_TENANT },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};

describe('requireAppContext — tenant derivation', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser });
  });

  it('verifies the app under the URL tenant and returns it, ignoring the claim', async () => {
    headersGet.mockReturnValue(URL_TENANT);
    // The app belongs to the URL tenant, NOT the claim tenant. Only a check
    // scoped to the URL tenant finds it.
    seedSupabaseMswState({ apps: [{ id: APP_ID, tenant_id: URL_TENANT }] });

    const result = await requireAppContext(APP_ID);

    expect(result).toMatchObject({ ok: true, tenantId: URL_TENANT, appId: APP_ID });
  });

  it('denies when the app belongs to a tenant other than the URL tenant', async () => {
    headersGet.mockReturnValue(URL_TENANT);
    seedSupabaseMswState({ apps: [{ id: APP_ID, tenant_id: 'tenant-other' }] });

    const result = await requireAppContext(APP_ID);

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('denies when no header is present, even though the claim names a tenant with a matching app', async () => {
    headersGet.mockReturnValue(null);
    seedSupabaseMswState({ apps: [{ id: APP_ID, tenant_id: CLAIM_TENANT }] });

    const result = await requireAppContext(APP_ID);

    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});
