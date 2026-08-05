/**
 * Integration Tests for custom_access_token_hook with custom_role_id
 *
 * Tests that the JWT hook correctly reads custom_role_id from the membership
 * table and includes it in the JWT claims.
 *
 * The hook fires on every token refresh (sign-in, refreshSession).
 * We verify by refreshing the session and decoding the JWT access_token
 * to check the custom_role_id claim.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createCustomRole,
  assignCustomRole,
  SameTenantUser,
} from './helpers';

/**
 * Decode a JWT access_token and return the payload (claims).
 * We only need the payload (middle segment), not signature verification.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  return JSON.parse(payload);
}

describe('custom_access_token_hook custom_role_id in JWT', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  afterEach(async () => {
    await assignCustomRole(supabaseAdmin, readUser.membershipId, null);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // custom_role_id in JWT when membership has custom_role_id set
  // ---------------------------------------------------------------------------
  it('should include custom_role_id in JWT claims when membership has custom_role_id set', async () => {
    // Arrange -- create and assign custom role
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'JWT Test Role', [
      'sso_config.read',
      'app.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

    // Act -- refresh session to trigger the hook
    const { data: session } = await readUser.client.auth.refreshSession();

    // Assert -- decode the JWT and check custom_role_id
    expect(session.session).not.toBeNull();
    const claims = decodeJwtPayload(session.session!.access_token);
    expect(claims.custom_role_id).toBe(customRole.id);
  });

  // ---------------------------------------------------------------------------
  // custom_role_id is null when no custom role assigned
  // ---------------------------------------------------------------------------
  it('should set custom_role_id to null in JWT when membership has no custom role', async () => {
    // Arrange -- ensure no custom role is assigned
    await assignCustomRole(supabaseAdmin, readUser.membershipId, null);

    // Act -- refresh session
    const { data: session } = await readUser.client.auth.refreshSession();

    // Assert
    expect(session.session).not.toBeNull();
    const claims = decodeJwtPayload(session.session!.access_token);
    // The hook explicitly sets null (not omits)
    expect(claims.custom_role_id).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // reads custom_role_id from correct membership for active tenant
  // ---------------------------------------------------------------------------
  it('should read custom_role_id from the correct membership when user has multiple tenants', async () => {
    // Arrange -- create a second tenant and add the same user
    const otherOwner = await createTenantWithOwner();
    const otherTenantId = otherOwner.tenantId;

    // Add readUser to second tenant
    const { data: otherMembership } = await supabaseAdmin
      .from('membership')
      .insert({
        user_id: readUser.id,
        tenant_id: otherTenantId,
        role: 'read',
        status: 'active',
      })
      .select('id')
      .single();

    // Create custom roles in each tenant
    const roleInTenant1 = await createCustomRole(supabaseAdmin, tenantId, 'Tenant 1 Role', [
      'sso_config.read',
    ]);
    const roleInTenant2 = await createCustomRole(supabaseAdmin, otherTenantId, 'Tenant 2 Role', [
      'app.read',
    ]);

    // Assign different custom roles in each tenant
    await assignCustomRole(supabaseAdmin, readUser.membershipId, roleInTenant1.id);
    await supabaseAdmin
      .from('membership')
      .update({ custom_role_id: roleInTenant2.id })
      .eq('id', otherMembership!.id);

    // readUser's JWT has tenant_id pointing to tenantId (tenant 1)
    // Act -- refresh session
    const { data: session } = await readUser.client.auth.refreshSession();

    // Assert -- should use tenant 1's custom role
    expect(session.session).not.toBeNull();
    const claims = decodeJwtPayload(session.session!.access_token);
    expect(claims.custom_role_id).toBe(roleInTenant1.id);

    // Cleanup
    await supabaseAdmin
      .from('membership')
      .update({ custom_role_id: null })
      .eq('id', otherMembership!.id);
    await supabaseAdmin.from('membership').delete().eq('id', otherMembership!.id);
    await cleanupCustomRoles(supabaseAdmin, otherTenantId);
    await cleanupTenantAndUsers(otherTenantId, [otherOwner]);
  });
});
