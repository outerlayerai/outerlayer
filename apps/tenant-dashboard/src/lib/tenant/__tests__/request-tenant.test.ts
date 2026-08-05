import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

const headersGet = vi.fn();
vi.mock('next/headers', () => ({
  headers: () => ({ get: headersGet }),
}));

import {
  extractOrgName,
  getRequestTenantId,
  resolveRequestTenantId,
} from '../request-tenant';
import { seedMembershipMswState } from '../../../test-helpers/msw-handlers';

const client = () => createClient('http://localhost:54321', 'test-anon-key');

describe('extractOrgName', () => {
  it('reads the org slug from a page path', () => {
    expect(extractOrgName('/orgs/acme/apps/x/env/dev/settings')).toBe('acme');
  });

  it('reads the org slug from a canonical API path', () => {
    expect(extractOrgName('/api/orgs/acme/apps/123/dashboards')).toBe('acme');
  });

  it('decodes a percent-encoded slug', () => {
    expect(extractOrgName('/orgs/acme%20labs/apps')).toBe('acme labs');
  });

  it('returns null when the path carries no org', () => {
    expect(extractOrgName('/settings')).toBeNull();
    expect(extractOrgName('/api/agents/sessions')).toBeNull();
    expect(extractOrgName('/orgs')).toBeNull();
  });
});

describe('getRequestTenantId', () => {
  beforeEach(() => headersGet.mockReset());

  it('returns the tenant the middleware derived onto the request header', async () => {
    headersGet.mockReturnValue('tenant-A');
    await expect(getRequestTenantId()).resolves.toBe('tenant-A');
    expect(headersGet).toHaveBeenCalledWith('x-tenant-id');
  });

  it('returns undefined when no header is present (claim fallback)', async () => {
    headersGet.mockReturnValue(null);
    await expect(getRequestTenantId()).resolves.toBeUndefined();
  });
});

describe('resolveRequestTenantId', () => {
  it('resolves an active member org to its tenant id', async () => {
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'u1', tenant_id: 'tenant-A', role: 'admin', status: 'active' },
      ],
      tenants: [{ tenant_id: 'tenant-A', organization_name: 'org-a' }],
    });

    await expect(resolveRequestTenantId(client(), 'u1', 'org-a')).resolves.toBe('tenant-A');
  });

  it('resolves case-insensitively (org names are unique on lower())', async () => {
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'u1', tenant_id: 'tenant-A', role: 'admin', status: 'active' },
      ],
      tenants: [{ tenant_id: 'tenant-A', organization_name: 'org-a' }],
    });

    // A URL slug that differs only in case must still resolve the same tenant.
    await expect(resolveRequestTenantId(client(), 'u1', 'Org-A')).resolves.toBe('tenant-A');
  });

  it('returns null for an org the user is not a member of', async () => {
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'u1', tenant_id: 'tenant-A', role: 'admin', status: 'active' },
      ],
      tenants: [
        { tenant_id: 'tenant-A', organization_name: 'org-a' },
        { tenant_id: 'tenant-B', organization_name: 'org-b' },
      ],
    });

    await expect(resolveRequestTenantId(client(), 'u1', 'org-b')).resolves.toBeNull();
  });

  it('returns null when the membership for that org is not active', async () => {
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'u1', tenant_id: 'tenant-A', role: 'admin', status: 'pending' },
      ],
      tenants: [{ tenant_id: 'tenant-A', organization_name: 'org-a' }],
    });

    await expect(resolveRequestTenantId(client(), 'u1', 'org-a')).resolves.toBeNull();
  });
});
