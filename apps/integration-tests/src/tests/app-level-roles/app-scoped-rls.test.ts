/**
 * Integration Tests for App-Scoped RLS Policies
 *
 * Verifies that per-app roles correctly filter access on app-scoped tables
 * (app, template, api_key) via app_authorize() in RLS policies.
 *
 * All users share a single tenant so RLS tenant_id checks work correctly.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { ensureDefaultEnvironment } from '../../lib/environment-test-utils';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  SameTenantUser,
} from './helpers';

describe('App-Scoped RLS Policies integration', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let writeUser: SameTenantUser;
  let adminUser: SameTenantUser;
  let tenantId: string;

  let testApp1: { id: string };
  let testApp2: { id: string };
  let testApp1DefaultEnvId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    writeUser = await addUserToTenant(tenantId, 'write');
    adminUser = await addUserToTenant(tenantId, 'admin');

    // Create test apps
    const { data: app1 } = await supabaseAdmin
      .from('app')
      .insert({ name: `RLS App 1 ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
      .select('id')
      .single();
    testApp1 = app1!;

    const { data: app2 } = await supabaseAdmin
      .from('app')
      .insert({ name: `RLS App 2 ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
      .select('id')
      .single();
    testApp2 = app2!;

    // Api_key.environment_id is NOT NULL. Raw `from('app')`
    // inserts don't auto-create the default env (production action does), so
    // seed it explicitly for the app whose api_key rows the tests insert.
    testApp1DefaultEnvId = await ensureDefaultEnvironment(testApp1.id, tenantId);

  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser, writeUser, adminUser]);
  });

  beforeEach(async () => {
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await supabaseAdmin.from('membership').update({ is_app_scoped: false }).eq('tenant_id', tenantId);
  });

  // ---------------------------------------------------------------------------
  // App table — read role
  // ---------------------------------------------------------------------------
  describe('App table - Read role', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });
    });

    it('should allow SELECT on assigned app', async () => {
      const { data, error } = await readUser.client
        .from('app').select('id').eq('id', testApp1.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('should deny SELECT on unassigned app', async () => {
      const { data, error } = await readUser.client
        .from('app').select('id').eq('id', testApp2.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should deny INSERT with read role', async () => {
      const { error } = await readUser.client
        .from('app').insert({ name: 'Should Fail', tenant_id: tenantId });
      expect(error).not.toBeNull();
    });

    it('should deny UPDATE on assigned app with read role', async () => {
      const { error } = await readUser.client
        .from('app').update({ name: 'No' }).eq('id', testApp1.id);
      // RLS blocks either with error or 0 affected rows
      if (error) {
        expect(error.message).toContain('row-level security');
      } else {
        const { data } = await supabaseAdmin.from('app').select('name').eq('id', testApp1.id).single();
        expect(data!.name).not.toBe('No');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // App table — write role
  // ---------------------------------------------------------------------------
  describe('App table - Write role', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', writeUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: writeUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'write',
        created_by: ownerUser.id,
      });
    });

    it('should allow SELECT on assigned app', async () => {
      const { data, error } = await writeUser.client
        .from('app').select('id').eq('id', testApp1.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('should deny UPDATE on assigned app (write role lacks app.update)', async () => {
      const { error } = await writeUser.client
        .from('app').update({ name: 'Should Not Work' }).eq('id', testApp1.id);
      // RLS blocks either with error or 0 affected rows
      if (error) {
        expect(error.message).toContain('row-level security');
      } else {
        const { data } = await supabaseAdmin.from('app').select('name').eq('id', testApp1.id).single();
        expect(data!.name).not.toBe('Should Not Work');
      }
    });

    it('should deny DELETE on assigned app with write role', async () => {
      const { error } = await writeUser.client
        .from('app').delete().eq('id', testApp1.id);
      if (error) {
        expect(error.message).toContain('row-level security');
      } else {
        // App must still exist
        const { data } = await supabaseAdmin.from('app').select('id').eq('id', testApp1.id).single();
        expect(data).not.toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // App table — admin role
  // ---------------------------------------------------------------------------
  describe('App table - Admin role', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', adminUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: adminUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'admin',
        created_by: ownerUser.id,
      });
    });

    it('should allow SELECT on assigned app', async () => {
      const { data, error } = await adminUser.client
        .from('app').select('id').eq('id', testApp1.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('should allow DELETE on assigned app with admin role', async () => {
      // Create a temp app and assign admin role
      const { data: tempApp } = await supabaseAdmin
        .from('app')
        .insert({ name: `Temp ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
        .select('id')
        .single();

      await supabaseAdmin.from('app_member_role').insert({
        membership_id: adminUser.membershipId,
        app_id: tempApp!.id,
        tenant_id: tenantId,
        role: 'admin',
        created_by: ownerUser.id,
      });

      const { error } = await adminUser.client.from('app').delete().eq('id', tempApp!.id);
      expect(error).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // API Key table — per-app scoping
  // ---------------------------------------------------------------------------
  describe('API Key table - per-app scoping', () => {
    let testApiKey: { id: string };

    beforeAll(async () => {
      const { data } = await supabaseAdmin
        .from('api_key')
        .insert({
          name: `Test Key ${Date.now()}`,
          api_key_id: `key-${Date.now()}`,
          app_id: testApp1.id,
          environment_id: testApp1DefaultEnvId,
          tenant_id: tenantId,
          created_by: ownerUser.id,
        })
        .select('id')
        .single();
      testApiKey = data!;
    });

    afterAll(async () => {
      if (testApiKey) await supabaseAdmin.from('api_key').delete().eq('id', testApiKey.id);
    });

    it('should allow scoped user with api_key.read to see keys for assigned app', async () => {
      // Use writeUser — write role has api_key.read; read role does not
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', writeUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: writeUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'write',
        created_by: ownerUser.id,
      });

      const { data, error } = await writeUser.client
        .from('api_key').select('id').eq('app_id', testApp1.id);
      expect(error).toBeNull();
      expect(data!.some(k => k.id === testApiKey.id)).toBe(true);
    });

    it('should deny scoped user access to API keys for unassigned app', async () => {
      // writeUser has write role on app1 only — should not see app2 keys
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', writeUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: writeUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'write',
        created_by: ownerUser.id,
      });

      const { data, error } = await writeUser.client
        .from('api_key').select('id').eq('app_id', testApp2.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should deny read-role user access to API keys (no api_key.read permission)', async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      const { data, error } = await readUser.client
        .from('api_key').select('id').eq('app_id', testApp1.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-scoped user fallback
  // ---------------------------------------------------------------------------
  describe('Non-scoped user fallback', () => {
    it('should fall back to org-level permissions when no records exist', async () => {
      const { data, error } = await readUser.client.from('app').select('id');
      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect org-level permission limits for non-scoped user', async () => {
      const { error } = await readUser.client
        .from('app').insert({ name: 'Fail', tenant_id: tenantId });
      expect(error).not.toBeNull();
    });
  });
});
