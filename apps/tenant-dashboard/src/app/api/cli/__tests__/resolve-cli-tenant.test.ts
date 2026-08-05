/**
 * Tests: resolveCliTenant — the CLI's tenant resolver.
 *
 * Precedence: explicit X-Tenant-Id header → profile.last_active_tenant_id →
 * sole active membership → deny. Supabase is an HTTP boundary → MSW; the
 * client under test is the same bearer-scoped client `createCliSupabaseClient`
 * builds, not a mock, so this pins the exact query shape (table, columns,
 * filters) resolveCliTenant sends. MSW has no RLS, so it proves the
 * function's control flow and query construction, not that Postgres actually
 * scopes the rows — that's the integration-tier's job.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createCliSupabaseClient } from '../auth-helper';
import { resolveCliTenant } from '../resolve-cli-tenant';
import {
  seedSupabaseAuth,
  seedMembershipMswState,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';

const USER_ID = 'cli-resolver-user';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function cliUser() {
  return { ...mockUser, id: USER_ID, app_metadata: {} };
}

function makeRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/cli/apps', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCliTenant', () => {
  describe('precedence 1: explicit X-Tenant-Id header', () => {
    it('resolves the header tenant when the caller is an active member of it', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'owner', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(
        supabase,
        user!,
        makeRequest({ 'x-tenant-id': TENANT_A }),
      );

      expect(result).toEqual({ ok: true, tenantId: TENANT_A });
    });

    it('denies outright when the header names a tenant the caller is not an active member of, never falling through', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'owner', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(
        supabase,
        user!,
        makeRequest({ 'x-tenant-id': TENANT_B }),
      );

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Not an active member of the requested tenant',
      });
    });

    it('denies when the header names a tenant the caller is a DISABLED member of', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'disabled', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest({ 'x-tenant-id': TENANT_A }));

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Not an active member of the requested tenant',
      });
    });
  });

  describe('precedence 2: profile.last_active_tenant_id', () => {
    it('resolves the preferred tenant when no header is present and the caller is still an active member of it', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedSupabaseMswState({
        profiles: [{ id: USER_ID, email: 'cli@test.local', last_active_tenant_id: TENANT_A }],
      });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'owner', status: 'active' },
          { id: 'm-2', user_id: USER_ID, tenant_id: TENANT_B, role: 'read', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({ ok: true, tenantId: TENANT_A });
    });

    it('falls through to sole membership when the preferred tenant is a DISABLED membership', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedSupabaseMswState({
        profiles: [{ id: USER_ID, email: 'cli@test.local', last_active_tenant_id: TENANT_A }],
      });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'disabled', status: 'active' },
          { id: 'm-2', user_id: USER_ID, tenant_id: TENANT_B, role: 'owner', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({ ok: true, tenantId: TENANT_B });
    });
  });

  describe('precedence 3: sole active membership', () => {
    it('resolves the one active membership when there is no header and no usable preference', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'owner', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({ ok: true, tenantId: TENANT_A });
    });

    it('excludes a disabled membership, resolving null tenant when it is the only row', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'disabled', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({ ok: false, status: 403, error: 'No tenant associated with user' });
    });

    it('excludes a pending (not yet accepted) membership, resolving null tenant when it is the only row', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'admin', status: 'pending' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({ ok: false, status: 403, error: 'No tenant associated with user' });
    });
  });

  describe('precedence 4: deny', () => {
    it('denies with an explicit multi-org message when there is no header, no preference, and more than one active membership', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      seedMembershipMswState({
        memberships: [
          { id: 'm-1', user_id: USER_ID, tenant_id: TENANT_A, role: 'owner', status: 'active' },
          { id: 'm-2', user_id: USER_ID, tenant_id: TENANT_B, role: 'read', status: 'active' },
        ],
      });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'Multiple organizations found — switch to the one you want in the dashboard, then retry',
      });
    });

    it('denies with "No tenant associated with user" when the caller has no active membership at all', async () => {
      const session = seedSupabaseAuth({ user: cliUser() });
      const supabase = createCliSupabaseClient(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      )!;
      const { data: { user } } = await supabase.auth.getUser();

      const result = await resolveCliTenant(supabase, user!, makeRequest());

      expect(result).toEqual({ ok: false, status: 403, error: 'No tenant associated with user' });
    });
  });
});
