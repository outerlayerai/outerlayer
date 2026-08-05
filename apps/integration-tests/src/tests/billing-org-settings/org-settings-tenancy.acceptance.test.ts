/**
 * Org-settings acceptance — tenant + permission scoping for org renames.
 *
 * Drives the real `updateOrganizationAction` Server Action through the
 * session-cookie fixture: real auth, real `tenant.update` RLS policy
 * (`supabase/schemas/12-rbac.sql:157`) and the matching `authorize()`
 * permission gate the action checks first. No external service involved —
 * unlike billing, nothing here needs mocking.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { createTenantWithOwner, createCrossTenantUser, cleanupTenantsAndUsers, type TenantUser } from './helpers';

import { updateOrganizationAction } from '@/features/org-settings/actions';
import { ActionErrorCodes } from '@/lib/action-kit';

describe('org-settings acceptance — tenant + permission scoping', () => {
  const admin = createSupabaseAdminClient();

  let orgA: TenantUser; // owner of A only
  let orgB: TenantUser; // owner of B only
  let dualOwner: TenantUser; // owner of B (home/claim tenant) AND owner of A
  let readerA: TenantUser; // read-only in A (home/claim tenant), no membership in B

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    dualOwner = await createCrossTenantUser(
      [
        { tenantId: orgB.tenantId, role: 'owner' },
        { tenantId: orgA.tenantId, role: 'owner' },
      ],
      'dual-owner-org-settings',
    );
    readerA = await createCrossTenantUser(
      [
        { tenantId: orgA.tenantId, role: 'read' },
        { tenantId: orgB.tenantId, role: 'read' },
      ],
      'reader-a',
    );
  }, 60000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    await cleanupTenantsAndUsers([orgA.tenantId, orgB.tenantId], [orgA, orgB, dualOwner, readerA]);
  });

  it('an update under org A writes only A\'s row, never the claim tenant\'s, leaving B untouched', async () => {
    // dualOwner's JWT claim names org B (their home/signup tenant); the
    // request is for org A, where they also hold a real owner membership.
    // A claim-tenant regression would either write B's row or fail outright.
    await actAsInOrg(dualOwner, orgA.tenantId);
    const newName = `renamed-org-a-${Date.now()}`;

    const result = await updateOrganizationAction({ companyName: newName });

    expect(result).toEqual({
      ok: true,
      data: { tenantId: orgA.tenantId, companyName: newName },
    });

    const { data: rowA } = await admin
      .from('tenant')
      .select('company_name')
      .eq('tenant_id', orgA.tenantId)
      .single();
    expect(rowA?.company_name).toBe(newName);

    // Org B is also dualOwner's claim/home tenant — one check covers both
    // "B's row is untouched" and "the claim tenant's row is untouched".
    const { data: rowB } = await admin
      .from('tenant')
      .select('company_name')
      .eq('tenant_id', orgB.tenantId)
      .single();
    expect(rowB?.company_name).not.toBe(newName);
  });

  it('an update without tenant.update is a typed failure, not a silent success — the row is unchanged', async () => {
    const { data: before } = await admin
      .from('tenant')
      .select('company_name')
      .eq('tenant_id', orgA.tenantId)
      .single();

    await actAsInOrg(readerA, orgA.tenantId);
    const result = await updateOrganizationAction({ companyName: 'should-never-land' });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: tenant.update' },
    });

    const { data: after } = await admin
      .from('tenant')
      .select('company_name')
      .eq('tenant_id', orgA.tenantId)
      .single();
    expect(after?.company_name).toBe(before?.company_name);
  });

  it('a non-member of B is forbidden on B\'s update — fail-closed, not just role-gated', async () => {
    await actAsInOrg(orgA, orgB.tenantId);
    const result = await updateOrganizationAction({ companyName: 'spoofed-name' });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: tenant.update' },
    });
  });
});
