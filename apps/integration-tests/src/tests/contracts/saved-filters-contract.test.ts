/**
 * Saved Trace Filters — Supabase Contract Tests
 *
 * Runs against the real service so the assumptions we make about it stay honest.
 *
 * These tests verify that the Supabase PostgREST responses for
 * saved_trace_filters match the shapes our unit test mocks assume.
 * If these fail, the unit-test mocks in
 * apps/tenant-dashboard/src/lib/analytics/saved-filters/{actions,read}.test.ts
 * are out of sync with real Supabase behavior.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createAuthenticatedUser,
  cleanupTestUsers,
  checkTableExists,
  requirePrerequisite,
  createTimedTestSuite,
  TestUser,
  PrerequisiteCheck,
} from '../../lib/test-utils';

const { timedIt } = createTimedTestSuite('integration');

describe('Saved Trace Filters — Supabase Contract Tests', () => {
  const admin = createSupabaseAdminClient();
  let testUser: TestUser;
  let prerequisite: PrerequisiteCheck;

  // A real app owned by the test user's tenant. The composite (tenant_id,
  // app_id) foreign key means a filter can no longer name an app id that does
  // not exist. Generated per run rather than hardcoded so parallel suites
  // cannot collide on the same app primary key.
  let testAppId: string;

  beforeAll(async () => {
    prerequisite = await checkTableExists('saved_trace_filters');
    if (prerequisite.available) {
      testUser = await createAuthenticatedUser('admin');

      const { data, error } = await admin
        .from('app')
        .insert({
          tenant_id: testUser.tenantId,
          name: `saved-filters-contract-${Date.now()}`,
          created_by: testUser.id,
        })
        .select('id')
        .single();
      if (error) throw new Error(`seed app: ${error.message}`);
      testAppId = data.id;
    }
  });

  afterAll(async () => {
    if (prerequisite.available && testUser) {
      await admin.from('saved_trace_filters').delete().eq('user_id', testUser.id);
      if (testAppId) await admin.from('app').delete().eq('id', testAppId);
      await cleanupTestUsers();
    }
  });

  // --------------------------------------------------------------------------
  // Response shape: .select().order() → { data: array, error: null }
  // --------------------------------------------------------------------------

  describe('.select().order() response shape', () => {
    timedIt(
      'should return an array (not null) when no rows match',
      async () => {
        requirePrerequisite(prerequisite);

        const { data, error } = await admin
          .from('saved_trace_filters')
          .select('id, name, filter_config, created_at, updated_at')
          .eq('user_id', '00000000-0000-0000-0000-000000000000')
          .order('name', { ascending: true });

        expect(error).toBeNull();
        expect(Array.isArray(data)).toBe(true);
        expect(data).toHaveLength(0);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Response shape: .insert().select().single() → { data: object, error: null }
  // --------------------------------------------------------------------------

  describe('.insert().select().single() response shape', () => {
    timedIt(
      'should return a single object (not array) when insertion succeeds',
      async () => {
        requirePrerequisite(prerequisite);

        const insertedName = `contract-insert-${Date.now()}`;
        const insertedFilterConfig = { version: 1, search: 'test' };
        const { data, error } = await admin
          .from('saved_trace_filters')
          .insert({
            user_id: testUser.id,
            tenant_id: testUser.tenantId,
            app_id: testAppId,
            name: insertedName,
            filter_config: insertedFilterConfig,
          })
          .select('id, name, filter_config, created_at')
          .single();

        expect(error).toBeNull();
        expect(data).not.toBeNull();
        expect(typeof data).toBe('object');
        expect(Array.isArray(data)).toBe(false);
        expect(data!.id).toBeDefined();
        expect(typeof data!.id).toBe('string');
        expect(data!.name).toBe(insertedName);
        expect(data!.filter_config).toEqual(insertedFilterConfig);
        expect(typeof data!.created_at).toBe('string');

        // Cleanup
        await admin.from('saved_trace_filters').delete().eq('id', data!.id);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Response shape: .update().eq().select().single()
  // --------------------------------------------------------------------------

  describe('.update().eq().select().single() response shape', () => {
    timedIt(
      'should return the updated object when update succeeds',
      async () => {
        requirePrerequisite(prerequisite);

        const { data: created } = await admin
          .from('saved_trace_filters')
          .insert({
            user_id: testUser.id,
            tenant_id: testUser.tenantId,
            app_id: testAppId,
            name: `contract-update-${Date.now()}`,
            filter_config: { version: 1, search: 'original' },
          })
          .select('id')
          .single();

        const { data, error } = await admin
          .from('saved_trace_filters')
          .update({ name: 'Contract Updated' })
          .eq('id', created!.id)
          .select('id, name, filter_config, created_at, updated_at')
          .single();

        expect(error).toBeNull();
        expect(data).not.toBeNull();
        expect(typeof data).toBe('object');
        expect(Array.isArray(data)).toBe(false);
        expect(data!.name).toBe('Contract Updated');

        // Cleanup
        await admin.from('saved_trace_filters').delete().eq('id', created!.id);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Response shape: .delete().eq() → { error: null }
  // --------------------------------------------------------------------------

  describe('.delete().eq() response shape', () => {
    timedIt(
      'should return null error when delete succeeds',
      async () => {
        requirePrerequisite(prerequisite);

        const { data: created } = await admin
          .from('saved_trace_filters')
          .insert({
            user_id: testUser.id,
            tenant_id: testUser.tenantId,
            app_id: testAppId,
            name: `contract-delete-${Date.now()}`,
            filter_config: { version: 1, search: 'delete-me' },
          })
          .select('id')
          .single();

        const { error } = await admin
          .from('saved_trace_filters')
          .delete()
          .eq('id', created!.id);

        expect(error).toBeNull();
      },
    );
  });

  // --------------------------------------------------------------------------
  // Unique constraint violation → error code 23505
  // --------------------------------------------------------------------------

  describe('Unique constraint violation', () => {
    timedIt(
      'should return error code 23505 when inserting a duplicate name',
      async () => {
        requirePrerequisite(prerequisite);

        const uniqueName = `contract-dup-${Date.now()}`;

        const { data: first } = await admin
          .from('saved_trace_filters')
          .insert({
            user_id: testUser.id,
            tenant_id: testUser.tenantId,
            app_id: testAppId,
            name: uniqueName,
            filter_config: { version: 1, search: 'first' },
          })
          .select('id')
          .single();

        const { data: second, error } = await admin
          .from('saved_trace_filters')
          .insert({
            user_id: testUser.id,
            tenant_id: testUser.tenantId,
            app_id: testAppId,
            name: uniqueName,
            filter_config: { version: 1, search: 'second' },
          })
          .select('id')
          .single();

        expect(second).toBeNull();
        expect(error).not.toBeNull();
        expect(error!.code).toBe('23505');

        // Cleanup
        await admin.from('saved_trace_filters').delete().eq('id', first!.id);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Count query → { count: number, error: null }
  // --------------------------------------------------------------------------

  describe('Count query behavior', () => {
    timedIt(
      'should return a numeric count when using count option',
      async () => {
        requirePrerequisite(prerequisite);

        const { count, error } = await admin
          .from('saved_trace_filters')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', testUser.id);

        expect(error).toBeNull();
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThanOrEqual(0);
      },
    );
  });
});
