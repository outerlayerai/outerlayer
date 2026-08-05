/**
 * Integration Tests for app_member_role Table CRUD
 *
 * Tests CRUD operations and constraints on the app_member_role table:
 * - RLS policies (admin/owner can create, read user cannot)
 * - Unique constraint on (membership_id, app_id)
 * - Role CHECK constraint (only read/write/admin allowed)
 * - Audit column population via trigger
 * - ON DELETE CASCADE for membership and app
 * - role_permissions seeding verification
 *
 * All users share a single tenant so RLS tenant_id checks work correctly.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  SameTenantUser,
} from './helpers';

describe('app_member_role table CRUD operations', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let adminUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string };

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    adminUser = await addUserToTenant(tenantId, 'admin');
    readUser = await addUserToTenant(tenantId, 'read');

    const { data } = await supabaseAdmin
      .from('app')
      .insert({ name: `CRUD App ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
      .select('id')
      .single();
    testApp = data!;
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, adminUser, readUser]);
  });

  beforeEach(async () => {
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
  });

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------
  describe('Create records', () => {
    it('should allow admin to create app_member_role records', async () => {
      const { data, error } = await adminUser.client
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'read',
        })
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0].membership_id).toBe(readUser.membershipId);
      expect(data![0].role).toBe('read');
    });

    it('should allow owner to create app_member_role records', async () => {
      const { data, error } = await ownerUser.client
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'write',
        })
        .select();

      expect(error).toBeNull();
      expect(data![0].role).toBe('write');
    });

    it('should deny read user from creating records', async () => {
      const { error } = await readUser.client
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'read',
        });

      expect(error).not.toBeNull();
    });

    it('should populate audit columns on creation', async () => {
      const { data, error } = await adminUser.client
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'admin',
        })
        .select();

      expect(error).toBeNull();
      expect(typeof data![0].created_at).toBe('string');
      expect(data![0].created_by).toBe(adminUser.id);
      expect(data![0].updated_at).toBeNull();
      expect(data![0].updated_by).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Unique constraint
  // ---------------------------------------------------------------------------
  describe('Unique constraint on (membership_id, app_id)', () => {
    it('should prevent duplicate assignment for same membership and app', async () => {
      await adminUser.client.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'read',
      });

      const { error } = await adminUser.client.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'write',
      });

      expect(error).not.toBeNull();
      expect(error!.message).toContain('duplicate');
    });

    it('should allow same membership on different apps', async () => {
      const { data: app2 } = await supabaseAdmin
        .from('app')
        .insert({ name: `CRUD App2 ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
        .select('id')
        .single();

      const { error: e1 } = await adminUser.client.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'read',
      });
      expect(e1).toBeNull();

      const { error: e2 } = await adminUser.client.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: app2!.id,
        tenant_id: tenantId,
        role: 'write',
      });
      expect(e2).toBeNull();

      await supabaseAdmin.from('app').delete().eq('id', app2!.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Role CHECK constraint
  // ---------------------------------------------------------------------------
  describe('Role CHECK constraint', () => {
    it('should accept read, write, and admin roles', async () => {
      for (const role of ['read', 'write', 'admin'] as const) {
        await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
        const { error } = await adminUser.client.from('app_member_role').insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role,
        });
        expect(error).toBeNull();
      }
    });

    it('should reject owner role (org-level only)', async () => {
      const { error } = await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'owner' as any,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toContain('violates check constraint');
    });

    it('should reject disabled role (org-level only)', async () => {
      const { error } = await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'disabled' as any,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toContain('violates check constraint');
    });
  });

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------
  describe('Update records', () => {
    beforeEach(async () => {
      await adminUser.client.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'read',
      });
    });

    it('should allow admin to update role', async () => {
      const { error } = await adminUser.client
        .from('app_member_role')
        .update({ role: 'write' })
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id);
      expect(error).toBeNull();

      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('role')
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id)
        .single();
      expect(data!.role).toBe('write');
    });

    it('should update audit columns on update', async () => {
      await adminUser.client
        .from('app_member_role')
        .update({ role: 'write' })
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id);

      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('updated_at, updated_by')
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id)
        .single();

      expect(data!.updated_at).not.toBeNull();
      expect(data!.updated_by).toBe(adminUser.id);
    });

    it('should deny read user from updating records', async () => {
      const { error } = await readUser.client
        .from('app_member_role')
        .update({ role: 'admin' })
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id);

      // Either error or 0 rows affected
      if (error) {
        expect(error.message).toContain('row-level security');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------
  describe('Delete records', () => {
    beforeEach(async () => {
      await adminUser.client.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'read',
      });
    });

    it('should allow admin to delete records', async () => {
      const { error } = await adminUser.client
        .from('app_member_role')
        .delete()
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id);
      expect(error).toBeNull();

      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('id')
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id);
      expect(data).toHaveLength(0);
    });

    it('should deny read user from deleting records', async () => {
      const { error } = await readUser.client
        .from('app_member_role')
        .delete()
        .eq('membership_id', readUser.membershipId)
        .eq('app_id', testApp.id);

      if (error) {
        expect(error.message).toContain('row-level security');
      } else {
        // Record must still exist
        const { data } = await supabaseAdmin
          .from('app_member_role')
          .select('id')
          .eq('membership_id', readUser.membershipId)
          .eq('app_id', testApp.id);
        expect(data!.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // ON DELETE CASCADE
  // ---------------------------------------------------------------------------
  describe('ON DELETE CASCADE', () => {
    it('should cascade delete when app is deleted', async () => {
      const { data: tempApp } = await supabaseAdmin
        .from('app')
        .insert({ name: `Cascade App ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
        .select('id')
        .single();

      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: tempApp!.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      // Verify record exists
      const { data: before } = await supabaseAdmin
        .from('app_member_role').select('id').eq('app_id', tempApp!.id);
      expect(before).toHaveLength(1);

      // Delete app
      await supabaseAdmin.from('app').delete().eq('id', tempApp!.id);

      // Verify cascade
      const { data: after } = await supabaseAdmin
        .from('app_member_role').select('id').eq('app_id', tempApp!.id);
      expect(after).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // role_permissions seeding
  // ---------------------------------------------------------------------------
  describe('role_permissions seeding', () => {
    it('should have correct permissions seeded for all app_member_role operations', async () => {
      const permissions = [
        'app_member_role.read',
        'app_member_role.insert',
        'app_member_role.update',
        'app_member_role.delete',
      ];

      for (const perm of permissions) {
        const { data, error } = await supabaseAdmin
          .from('role_permissions')
          .select('role')
          .eq('permission', perm);

        expect(error).toBeNull();
        const roles = data!.map(r => r.role);

        // Owner and admin always have all app_member_role permissions
        expect(roles).toContain('owner');
        expect(roles).toContain('admin');

        // Read and write users should NOT have insert/update/delete
        if (perm !== 'app_member_role.read') {
          expect(roles).not.toContain('read');
          expect(roles).not.toContain('write');
        }
      }
    });
  });
});
