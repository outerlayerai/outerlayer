/**
 * Supabase API Contract Tests
 *
 * Runs against the real service so the assumptions we make about it stay honest.
 *
 * These tests verify that our mocked Supabase behaviors match the real API.
 * If these tests fail, our mocks are out of sync with the actual Supabase behavior.
 *
 * Run these tests against the real local Supabase instance.
 */

import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../../lib/test-utils';

describe('Supabase API Contract Tests', () => {
  const supabaseAdmin = getSupabaseAdmin();

  describe('PostgREST .single() behavior', () => {
    const testTableName = 'profile';

    it('should return PGRST116 error when .single() finds no rows', async () => {
      // This is a critical assumption in many of our mocks
      const { data, error } = await supabaseAdmin
        .from(testTableName)
        .select('id')
        .eq('id', '00000000-0000-0000-0000-000000000000') // UUID that will never exist
        .single();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code).toBe('PGRST116');
      // Error message varies by Supabase version - just verify it indicates no/multiple rows issue
      expect(error?.message).toMatch(/rows|JSON object requested|Cannot coerce the result to a single/);
    });

    it('should return data (not array) when .single() finds exactly one row', async () => {
      // Create a temporary test record
      const testId = `contract-test-${Date.now()}`;
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: `${testId}@contract-test.com`,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (authError || !authUser.user) {
        throw new Error(`Failed to create test user: ${authError?.message}`);
      }

      try {
        // Insert profile
        await supabaseAdmin.from('profile').insert({
          id: authUser.user.id,
          email: `${testId}@contract-test.com`,
          name: 'Contract Test User',
        });

        // Query with .single()
        const { data, error } = await supabaseAdmin
          .from('profile')
          .select('id, email, name')
          .eq('id', authUser.user.id)
          .single();

        expect(error).toBeNull();
        expect(data).not.toBeNull();
        expect(typeof data).toBe('object');
        expect(Array.isArray(data)).toBe(false);
        expect(data?.id).toBe(authUser.user.id);
      } finally {
        // Cleanup
        await supabaseAdmin.from('profile').delete().eq('id', authUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      }
    });
  });

  describe('PostgREST array response behavior', () => {
    it('should return empty array (not error) when query finds no rows without .single()', async () => {
      const { data, error } = await supabaseAdmin
        .from('profile')
        .select('id')
        .eq('id', '00000000-0000-0000-0000-000000000000'); // UUID that will never exist

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(0);
    });
  });

  describe('RLS policy behavior', () => {
    it('should block authenticated users from reading audit_log', async () => {
      // Arrange: create auth user and sign in as non-service-role client
      const testEmail = `audit-rls-read-${Date.now()}@contract-test.com`;
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (authError || !authUser.user) {
        throw new Error(`Prerequisite failed: could not create auth user: ${authError?.message}`);
      }

      const { error: profileError } = await supabaseAdmin.from('profile').insert({
        id: authUser.user.id,
        email: testEmail,
        name: 'RLS Read Test',
      });

      if (profileError) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
        throw new Error(`Prerequisite failed: could not create profile: ${profileError.message}`);
      }

      // Insert a log entry via admin (only service_role can insert)
      const { data: logEntry, error: insertError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: authUser.user.id,
          action_type: 'contract_test',
          target_type: 'test',
          target_identifier: 'rls-read-test',
        })
        .select()
        .single();

      if (insertError || !logEntry) {
        await supabaseAdmin.from('profile').delete().eq('id', authUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
        throw new Error(`Prerequisite failed: could not insert audit log: ${insertError?.message}`);
      }

      const userClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331',
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
      );
      await userClient.auth.signInWithPassword({ email: testEmail, password: 'TestPassword123!' });

      try {
        // Act: authenticated user tries to SELECT
        const { data } = await userClient
          .from('audit_log')
          .select('*')
          .eq('id', logEntry.id);

        // Assert: RLS blocks — user sees 0 rows (service_role_select policy)
        expect(data).toHaveLength(0);
      } finally {
        await supabaseAdmin.from('audit_log').delete().eq('id', logEntry.id);
        await supabaseAdmin.from('profile').delete().eq('id', authUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      }
    });

    it('should block authenticated users from modifying audit_log', async () => {
      // Arrange: create auth user, sign in, seed an audit log entry
      const testEmail = `audit-rls-write-${Date.now()}@contract-test.com`;
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (authError || !authUser.user) {
        throw new Error(`Prerequisite failed: could not create auth user: ${authError?.message}`);
      }

      const { error: profileError } = await supabaseAdmin.from('profile').insert({
        id: authUser.user.id,
        email: testEmail,
        name: 'RLS Write Test',
      });

      if (profileError) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
        throw new Error(`Prerequisite failed: could not create profile: ${profileError.message}`);
      }

      const { data: logEntry, error: insertError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: authUser.user.id,
          action_type: 'contract_test',
          target_type: 'test',
          target_identifier: 'rls-write-test',
        })
        .select()
        .single();

      if (insertError || !logEntry) {
        await supabaseAdmin.from('profile').delete().eq('id', authUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
        throw new Error(`Prerequisite failed: could not insert audit log: ${insertError?.message}`);
      }

      const userClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331',
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
      );
      await userClient.auth.signInWithPassword({ email: testEmail, password: 'TestPassword123!' });

      try {
        // Act: authenticated user tries to UPDATE and DELETE
        await userClient
          .from('audit_log')
          .update({ action_type: 'hacked' })
          .eq('id', logEntry.id);

        await userClient
          .from('audit_log')
          .delete()
          .eq('id', logEntry.id);

        // Assert: record is completely unchanged (RLS blocked both operations)
        const { data: intact } = await supabaseAdmin
          .from('audit_log')
          .select('action_type, target_identifier')
          .eq('id', logEntry.id)
          .single();

        expect(intact).not.toBeNull();
        expect(intact!.action_type).toBe('contract_test');
        expect(intact!.target_identifier).toBe('rls-write-test');
      } finally {
        await supabaseAdmin.from('audit_log').delete().eq('id', logEntry.id);
        await supabaseAdmin.from('profile').delete().eq('id', authUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      }
    });
  });

  describe('Foreign key cascade behavior', () => {
    it('should CASCADE delete feature_flag_override when feature_flag is deleted', async () => {
      // Create a test flag
      const { data: flag, error: flagError } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: `contract-test-cascade-${Date.now()}`,
          description: 'Contract test for cascade delete',
          is_enabled: false,
          strategy: 'global',
        })
        .select()
        .single();

      if (flagError || !flag) {
        throw new Error(`Prerequisite failed: could not create feature_flag: ${flagError?.message}. Check that the table exists and has the expected schema.`);
      }

      // Get a tenant to create an override
      const { data: tenants } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id')
        .limit(1);

      if (!tenants || tenants.length === 0) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', flag.id);
        throw new Error('Prerequisite failed: no tenants available in database. Run test setup to create test tenants.');
      }

      const tenantId = tenants[0]!.tenant_id;

      // Create an override
      const { error: overrideError } = await supabaseAdmin
        .from('feature_flag_override')
        .insert({
          flag_id: flag.id,
          tenant_id: tenantId,
          is_enabled: true,
        });

      if (overrideError) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', flag.id);
        throw new Error(`Prerequisite failed: could not create feature_flag_override: ${overrideError.message}. Check FK constraints and table schema.`);
      }

      // Verify override exists
      const { data: beforeDelete } = await supabaseAdmin
        .from('feature_flag_override')
        .select('id')
        .eq('flag_id', flag.id);

      expect(beforeDelete).toHaveLength(1);

      // Delete the flag
      const { error: deleteError } = await supabaseAdmin
        .from('feature_flag')
        .delete()
        .eq('id', flag.id);

      expect(deleteError).toBeNull();

      // Verify override was cascade deleted
      const { data: afterDelete } = await supabaseAdmin
        .from('feature_flag_override')
        .select('id')
        .eq('flag_id', flag.id);

      expect(afterDelete).toHaveLength(0);
    });
  });

  describe('Count query behavior', () => {
    it('should return count in response when using count option', async () => {
      const { count, error } = await supabaseAdmin
        .from('profile')
        .select('id', { count: 'exact', head: true });

      expect(error).toBeNull();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
