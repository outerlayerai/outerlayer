/**
 * Integration Tests for app_authorize() with Custom Roles
 *
 * Tests the custom role branch in app_authorize():
 * - app_member_role with custom_role_id grants per-app permissions
 * - app_member_role custom role lacking permission denies access
 * - Fallback to org-level authorize() when no app_member_role record
 * - ON DELETE SET NULL leaves user without per-app access
 * - Cross-tenant escalation prevention
 * - Owner bypass of app-level custom role restrictions
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createCustomRole,
  createTestApp,
  createAppMemberRole,
  assignCustomRole,
  setCustomRoleClaim,
  SameTenantUser,
} from './helpers';

describe('app_authorize() with custom roles', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string; name: string };

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    testApp = await createTestApp(supabaseAdmin, tenantId);
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  afterEach(async () => {
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await assignCustomRole(supabaseAdmin, readUser.membershipId, null);
    await setCustomRoleClaim(supabaseAdmin, readUser.id, null, readUser.client);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // app_member_role with custom_role_id grants per-app permissions
  // ---------------------------------------------------------------------------
  it('should grant app-level permission when app_member_role has custom_role_id with matching permission', async () => {
    // Arrange
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'App SSO Viewer', [
      'sso_config.read',
      'app.read',
    ]);
    await createAppMemberRole(supabaseAdmin, {
      membershipId: readUser.membershipId,
      appId: testApp.id,
      tenantId,
      role: 'read',
      customRoleId: customRole.id,
    });
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: true })
      .eq('id', readUser.membershipId);

    // Act
    const { data: authResult } = await readUser.client.rpc('app_authorize', {
      requested_permission: 'sso_config.read',
      target_app_id: testApp.id,
    });

    // Assert
    expect(authResult).toBe(true);

    // Cleanup
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: false })
      .eq('id', readUser.membershipId);
  });

  // ---------------------------------------------------------------------------
  // Deny when custom role lacks the permission
  // ---------------------------------------------------------------------------
  it('should deny app-level permission when app_member_role custom role lacks the permission', async () => {
    // Arrange -- custom role with sso_config.read but NOT app.update
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Limited App Role', [
      'sso_config.read',
    ]);
    await createAppMemberRole(supabaseAdmin, {
      membershipId: readUser.membershipId,
      appId: testApp.id,
      tenantId,
      role: 'read',
      customRoleId: customRole.id,
    });
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: true })
      .eq('id', readUser.membershipId);

    // Act
    const { data: authResult } = await readUser.client.rpc('app_authorize', {
      requested_permission: 'app.update',
      target_app_id: testApp.id,
    });

    // Assert
    expect(authResult).toBe(false);

    // Cleanup
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: false })
      .eq('id', readUser.membershipId);
  });

  // ---------------------------------------------------------------------------
  // Fall back to org-level authorize() when no app_member_role exists
  // ---------------------------------------------------------------------------
  it('should fall back to org-level authorize when no app_member_role record exists for the user', async () => {
    // Arrange -- readUser has no app_member_role, is NOT app-scoped
    // Built-in 'read' role has app.read permission

    // Act
    const { data: authResult } = await readUser.client.rpc('app_authorize', {
      requested_permission: 'app.read',
      target_app_id: testApp.id,
    });

    // Assert -- falls through to org-level authorize() which checks built-in role
    expect(authResult).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Deny access for app-scoped user when app_member_role is removed
  // Note: ON DELETE SET NULL on custom_role FK cannot cascade because the
  // chk_role_or_custom_role constraint rejects NULL/NULL. Instead, we test
  // the scenario where the app_member_role row is deleted (no per-app assignment).
  // ---------------------------------------------------------------------------
  it('should deny access for app-scoped user when app_member_role is removed', async () => {
    // Arrange -- create custom role, assign via app_member_role, then remove it
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Soon Gone App Role', [
      'sso_config.read',
      'app.read',
    ]);
    const amr = await createAppMemberRole(supabaseAdmin, {
      membershipId: readUser.membershipId,
      appId: testApp.id,
      tenantId,
      role: 'read',
      customRoleId: customRole.id,
    });
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: true })
      .eq('id', readUser.membershipId);

    // Remove the app_member_role entirely
    await supabaseAdmin
      .from('app_member_role')
      .delete()
      .eq('id', amr.id);

    // Act -- app_authorize finds no app_member_role record
    // Falls through to is_app_scoped check -> is_app_scoped = true -> deny
    const { data: authResult } = await readUser.client.rpc('app_authorize', {
      requested_permission: 'sso_config.read',
      target_app_id: testApp.id,
    });

    // Assert
    expect(authResult).toBe(false);

    // Cleanup
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: false })
      .eq('id', readUser.membershipId);
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant escalation prevention in app_authorize custom role branch
  // ---------------------------------------------------------------------------
  it('should deny access when app_member_role custom_role_id references a role from a different tenant', async () => {
    // Arrange -- create a second tenant with a custom role
    const otherOwner = await createTenantWithOwner();
    const otherTenantId = otherOwner.tenantId;
    const otherRole = await createCustomRole(supabaseAdmin, otherTenantId, 'Other Tenant App Role', [
      'sso_config.read',
      'app.read',
      'app.update',
    ]);

    // Insert app_member_role with cross-tenant custom_role_id via admin
    // (bypasses RLS to simulate data corruption or attack)
    await supabaseAdmin.from('app_member_role').insert({
      membership_id: readUser.membershipId,
      app_id: testApp.id,
      tenant_id: tenantId,
      role: 'read',
      custom_role_id: otherRole.id,
    });
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: true })
      .eq('id', readUser.membershipId);

    // Act
    const { data: authResult } = await readUser.client.rpc('app_authorize', {
      requested_permission: 'sso_config.read',
      target_app_id: testApp.id,
    });

    // Assert -- tenant cross-check in app_authorize should deny
    expect(authResult).toBe(false);

    // Cleanup
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: false })
      .eq('id', readUser.membershipId);
    await cleanupCustomRoles(supabaseAdmin, otherTenantId);
    await cleanupTenantAndUsers(otherTenantId, [otherOwner]);
  });

  // ---------------------------------------------------------------------------
  // Owner bypass of app-level restrictions
  // ---------------------------------------------------------------------------
  it('should allow owner to bypass app-level custom role restrictions', async () => {
    // Arrange -- even though there is no app_member_role for owner,
    // owner should always get full access via the owner bypass in app_authorize.

    // Act
    const { data: authResult } = await ownerUser.client.rpc('app_authorize', {
      requested_permission: 'app.update',
      target_app_id: testApp.id,
    });

    // Assert -- owner bypass should return true
    expect(authResult).toBe(true);
  });
});
