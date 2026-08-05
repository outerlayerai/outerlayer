/**
 * Integration Tests for Saved Trace Filters
 *
 * Tests CRUD operations, RLS policies, unique constraints, and trigger
 * behavior against a real local Supabase instance.
 *
 * Database interactions are validated against the real database rather than
 * mocks, because a mock cannot catch a broken policy or constraint.
 */

import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../lib/supabase-admin';
import { retryOnTransientError } from '../lib/retry';
import { createTenantScopedClient } from '../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, type SameTenantUser } from './app-level-roles/helpers';
import {
  createAuthenticatedUser,
  cleanupTestUsers,
  checkTableExists,
  requirePrerequisite,
  createTimedTestSuite,
  TestUser,
  PrerequisiteCheck,
} from '../lib/test-utils';

const { timedIt } = createTimedTestSuite('integration');

// ============================================================================
// Helpers
// ============================================================================

/** Stable test app IDs — one per test user for scoping */
const TEST_APP_ID_A = '11111111-1111-1111-1111-111111111111';
const TEST_APP_ID_B = '22222222-2222-2222-2222-222222222222';

/**
 * These have to be real app rows owned by the matching tenant. The composite
 * (tenant_id, app_id) foreign key on saved_trace_filters means a filter can no
 * longer point at an app id that does not exist, or at one belonging to another
 * tenant.
 */
async function seedApp(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  appId: string,
  tenantId: string,
  createdBy: string,
) {
  const { error } = await admin
    .from('app')
    .insert({ id: appId, tenant_id: tenantId, name: `saved-filters-${appId.slice(0, 8)}`, created_by: createdBy });
  if (error) throw new Error(`seed app ${appId}: ${error.message}`);
}

const filterConfig = (search: string) => ({
  version: 1,
  search,
  searchField: 'all' as const,
});

async function cleanupFilters(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
) {
  await admin.from('saved_trace_filters').delete().eq('user_id', userId);
}

// ============================================================================
// Tests
// ============================================================================

describe('Saved Trace Filters Integration Tests', () => {
  let supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;
  let userA: TestUser;
  let userB: TestUser;
  let prerequisite: PrerequisiteCheck;

  beforeAll(async () => {
    supabaseAdmin = createSupabaseAdminClient();
    prerequisite = await checkTableExists('saved_trace_filters');

    if (prerequisite.available) {
      // Create two users in separate tenants for RLS isolation testing
      userA = await createAuthenticatedUser('admin');
      userB = await createAuthenticatedUser('admin');

      await seedApp(supabaseAdmin, TEST_APP_ID_A, userA.tenantId, userA.id);
      await seedApp(supabaseAdmin, TEST_APP_ID_B, userB.tenantId, userB.id);
    }
  });

  afterAll(async () => {
    if (prerequisite.available) {
      // Clean up saved filters before users (FK constraint)
      if (userA) await cleanupFilters(supabaseAdmin, userA.id);
      if (userB) await cleanupFilters(supabaseAdmin, userB.id);
      await supabaseAdmin.from('app').delete().in('id', [TEST_APP_ID_A, TEST_APP_ID_B]);
      await cleanupTestUsers();
    }
  });

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  describe('CRUD Operations', () => {
    timedIt(
      'should create a saved filter when valid data is provided',
      async () => {
        requirePrerequisite(prerequisite);

        const { data, error } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Error traces',
            filter_config: filterConfig('error'),
          })
          .select('id, name, filter_config, created_at')
          .single();

        expect(error).toBeNull();
        expect(data).not.toBeNull();
        expect(data!.name).toBe('Error traces');
        expect(data!.filter_config).toEqual(filterConfig('error'));
        expect(Number.isNaN(Date.parse(data!.created_at))).toBe(false);

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', data!.id);
      },
    );

    timedIt(
      'should list all filters for a user when multiple exist',
      async () => {
        requirePrerequisite(prerequisite);

        // Create two filters
        const { data: f1 } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Filter Alpha',
            filter_config: filterConfig('alpha'),
          })
          .select('id')
          .single();

        const { data: f2 } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Filter Beta',
            filter_config: filterConfig('beta'),
          })
          .select('id')
          .single();

        // List via admin (bypasses RLS)
        const { data: filters, error } = await supabaseAdmin
          .from('saved_trace_filters')
          .select('id, name')
          .eq('user_id', userA.id)
          .order('name', { ascending: true });

        expect(error).toBeNull();
        expect(filters!.length).toBeGreaterThanOrEqual(2);
        const names = filters!.map((f) => f.name);
        expect(names).toContain('Filter Alpha');
        expect(names).toContain('Filter Beta');

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', f1!.id);
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', f2!.id);
      },
    );

    timedIt(
      'should update a filter name when a new name is provided',
      async () => {
        requirePrerequisite(prerequisite);

        const { data: created } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Original Name',
            filter_config: filterConfig('test'),
          })
          .select('id')
          .single();

        const { data: updated, error } = await supabaseAdmin
          .from('saved_trace_filters')
          .update({ name: 'Renamed' })
          .eq('id', created!.id)
          .select('id, name, updated_at')
          .single();

        expect(error).toBeNull();
        expect(updated!.name).toBe('Renamed');

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', created!.id);
      },
    );

    timedIt(
      'should delete a filter when it exists',
      async () => {
        requirePrerequisite(prerequisite);

        const { data: created } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'To Delete',
            filter_config: filterConfig('delete-me'),
          })
          .select('id')
          .single();

        const { error } = await supabaseAdmin
          .from('saved_trace_filters')
          .delete()
          .eq('id', created!.id);

        expect(error).toBeNull();

        // Verify deleted
        const { data: gone } = await supabaseAdmin
          .from('saved_trace_filters')
          .select('id')
          .eq('id', created!.id);

        expect(gone).toHaveLength(0);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Constraints
  // --------------------------------------------------------------------------

  describe('Constraints', () => {
    timedIt(
      'should reject duplicate names for the same user and tenant',
      async () => {
        requirePrerequisite(prerequisite);

        // Idempotent + transient-resilient: clear any row left by a prior run,
        // then insert the first filter, retrying only on infra 502s. Without the
        // retry a transient 502 left `first` null, so the duplicate-detection
        // below asserted against a row that was never created (and `first!.id`
        // deref'd null in cleanup).
        await supabaseAdmin
          .from('saved_trace_filters')
          .delete()
          .eq('user_id', userA.id)
          .eq('tenant_id', userA.tenantId)
          .eq('app_id', TEST_APP_ID_A)
          .eq('name', 'Duplicate Test');
        const { data: first, error: firstError } = await retryOnTransientError(() =>
          supabaseAdmin
            .from('saved_trace_filters')
            .insert({
              user_id: userA.id,
              tenant_id: userA.tenantId,
              app_id: TEST_APP_ID_A,
              name: 'Duplicate Test',
              filter_config: filterConfig('first'),
            })
            .select('id')
            .single(),
        );
        expect(firstError).toBeNull();
        expect(first).not.toBeNull();

        const { error: dupError } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Duplicate Test',
            filter_config: filterConfig('second'),
          });

        expect(dupError).not.toBeNull();
        expect(dupError!.code).toBe('23505'); // unique_violation

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', first!.id);
      },
    );

    timedIt(
      'should allow the same name across different tenants',
      async () => {
        requirePrerequisite(prerequisite);

        const { data: filterA } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Cross Tenant',
            filter_config: filterConfig('a'),
          })
          .select('id')
          .single();

        const { data: filterB, error } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userB.id,
            tenant_id: userB.tenantId,
            app_id: TEST_APP_ID_B,
            name: 'Cross Tenant',
            filter_config: filterConfig('b'),
          })
          .select('id')
          .single();

        expect(error).toBeNull();
        expect(filterB!.id).toEqual(expect.any(String));

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', filterA!.id);
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', filterB!.id);
      },
    );

    timedIt(
      'should reject names exceeding 100 characters',
      async () => {
        requirePrerequisite(prerequisite);

        const longName = 'x'.repeat(101);
        const { error } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: longName,
            filter_config: filterConfig('test'),
          });

        expect(error).not.toBeNull();
        // CHECK constraint violation
        expect(error!.code).toBe('23514');
      },
    );
  });

  // --------------------------------------------------------------------------
  // Trigger Behavior
  // --------------------------------------------------------------------------

  describe('Trigger Behavior', () => {
    timedIt(
      'should set updated_at when a filter is modified',
      async () => {
        requirePrerequisite(prerequisite);

        const { data: created } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'Trigger Test',
            filter_config: filterConfig('before'),
          })
          .select('id, created_at, updated_at')
          .single();

        // Initially updated_at should be null
        expect(created!.updated_at).toBeNull();

        // Small delay to ensure timestamp differs
        await new Promise((r) => setTimeout(r, 50));

        const { data: updated } = await supabaseAdmin
          .from('saved_trace_filters')
          .update({ name: 'Trigger Test Updated' })
          .eq('id', created!.id)
          .select('id, updated_at')
          .single();

        expect(updated!.updated_at).not.toBeNull();
        expect(new Date(updated!.updated_at!).getTime()).toBeGreaterThan(
          new Date(created!.created_at).getTime(),
        );

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', created!.id);
      },
    );
  });

  // --------------------------------------------------------------------------
  // RLS Policy Enforcement
  // --------------------------------------------------------------------------

  describe('RLS Policy Enforcement', () => {
    timedIt(
      "a member's authenticated client does not see another TENANT's filter (userA/userB are separate tenants — this is cross-tenant RLS, not same-tenant per-user scoping; see 'Same-tenant SHARED filters' below for the within-tenant contract)",
      async () => {
        requirePrerequisite(prerequisite);

        // Create a filter for userA via admin
        const { data: filterA } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'UserA Filter',
            filter_config: filterConfig('a-only'),
          })
          .select('id')
          .single();

        // Create a filter for userB via admin
        const { data: filterB } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userB.id,
            tenant_id: userB.tenantId,
            app_id: TEST_APP_ID_B,
            name: 'UserB Filter',
            filter_config: filterConfig('b-only'),
          })
          .select('id')
          .single();

        // UserA's authenticated client should only see their own filter
        const { data: userAFilters, error } = await userA.client
          .from('saved_trace_filters')
          .select('id, name');

        expect(error).toBeNull();
        const userANames = userAFilters!.map((f) => f.name);
        expect(userANames).toContain('UserA Filter');
        expect(userANames).not.toContain('UserB Filter');

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', filterA!.id);
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', filterB!.id);
      },
    );

    timedIt(
      "a member of one tenant cannot modify another TENANT's filter (cross-tenant RLS)",
      async () => {
        requirePrerequisite(prerequisite);

        // Create a filter for userB via admin
        const { data: filterB } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userB.id,
            tenant_id: userB.tenantId,
            app_id: TEST_APP_ID_B,
            name: 'Protected Filter',
            filter_config: filterConfig('protected'),
          })
          .select('id')
          .single();

        // UserA tries to update userB's filter — RLS should block
        await userA.client
          .from('saved_trace_filters')
          .update({ name: 'Hacked' })
          .eq('id', filterB!.id);

        // Verify the filter is unchanged
        const { data: intact } = await supabaseAdmin
          .from('saved_trace_filters')
          .select('name')
          .eq('id', filterB!.id)
          .single();

        expect(intact!.name).toBe('Protected Filter');

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', filterB!.id);
      },
    );

    timedIt(
      "a member of one tenant cannot delete another TENANT's filter (cross-tenant RLS)",
      async () => {
        requirePrerequisite(prerequisite);

        // Create a filter for userB via admin
        const { data: filterB } = await supabaseAdmin
          .from('saved_trace_filters')
          .insert({
            user_id: userB.id,
            tenant_id: userB.tenantId,
            app_id: TEST_APP_ID_B,
            name: 'Undeletable',
            filter_config: filterConfig('safe'),
          })
          .select('id')
          .single();

        // UserA tries to delete userB's filter — RLS should block
        await userA.client
          .from('saved_trace_filters')
          .delete()
          .eq('id', filterB!.id);

        // Verify the filter still exists
        const { data: stillThere } = await supabaseAdmin
          .from('saved_trace_filters')
          .select('id')
          .eq('id', filterB!.id);

        expect(stillThere).toHaveLength(1);

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', filterB!.id);
      },
    );

    timedIt(
      'should allow user to create a filter via authenticated client',
      async () => {
        requirePrerequisite(prerequisite);

        const { data, error } = await userA.client
          .from('saved_trace_filters')
          .insert({
            user_id: userA.id,
            tenant_id: userA.tenantId,
            app_id: TEST_APP_ID_A,
            name: 'RLS Insert Test',
            filter_config: filterConfig('rls-test'),
          })
          .select('id, name')
          .single();

        expect(error).toBeNull();
        expect(data!.name).toBe('RLS Insert Test');

        // Cleanup
        await supabaseAdmin.from('saved_trace_filters').delete().eq('id', data!.id);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Same-tenant SHARED filters — `tenant_shared_filters` has no user_id
  // predicate: `user_id` is provenance only, never an access-control column.
  // A fellow member of the SAME tenant can list/read/update/delete another
  // member's filter. Driven through the real header-scoped RLS wire
  // (`createTenantScopedClient`), two DIFFERENT members of ONE tenant — the
  // complement to "RLS Policy Enforcement" above, whose userA/userB sit in
  // separate tenants and so prove the tenant boundary, not this one.
  // --------------------------------------------------------------------------

  describe('Same-tenant SHARED filters', () => {
    let owner: SameTenantUser;
    let teammate: SameTenantUser;
    let sharedFilterId: string;
    const appId = randomUUID();

    beforeAll(async () => {
      owner = await createTenantWithOwner();
      teammate = await addUserToTenant(owner.tenantId, 'write');

      // The composite (tenant_id, app_id) FK on saved_trace_filters means the
      // filter below needs a real app row owned by the SAME tenant as owner.
      await seedApp(supabaseAdmin, appId, owner.tenantId, owner.id);

      const { data, error } = await supabaseAdmin
        .from('saved_trace_filters')
        .insert({
          user_id: owner.id,
          tenant_id: owner.tenantId,
          app_id: appId,
          name: 'Shared Filter',
          filter_config: filterConfig('shared'),
        })
        .select('id')
        .single();
      if (error) throw new Error(`seed shared filter: ${error.message}`);
      sharedFilterId = data!.id;
    }, 90000);

    afterAll(async () => {
      await supabaseAdmin.from('saved_trace_filters').delete().eq('tenant_id', owner.tenantId);
      await supabaseAdmin.from('app').delete().eq('id', appId);
      await supabaseAdmin.from('membership').delete().in('user_id', [owner.id, teammate.id]);
      for (const user of [owner, teammate]) {
        await supabaseAdmin.from('profile').delete().eq('id', user.id);
        try {
          await supabaseAdmin.auth.admin.deleteUser(user.id);
        } catch {
          // best-effort; a leaked auth user does not affect other suites
        }
      }
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', owner.tenantId);
    });

    timedIt("a fellow tenant member LISTS a filter they did not create", async () => {
      requirePrerequisite(prerequisite);
      const asTeammate = await createTenantScopedClient(teammate, owner.tenantId);
      const { data, error } = await asTeammate.from('saved_trace_filters').select('id, name');

      expect(error).toBeNull();
      expect((data ?? []).map((f) => f.id)).toContain(sharedFilterId);
    });

    timedIt("a fellow tenant member UPDATES a filter they did not create", async () => {
      requirePrerequisite(prerequisite);
      const asTeammate = await createTenantScopedClient(teammate, owner.tenantId);
      const { data, error } = await asTeammate
        .from('saved_trace_filters')
        .update({ name: 'Renamed by teammate' })
        .eq('id', sharedFilterId)
        .select('id, name')
        .single();

      expect(error).toBeNull();
      expect(data?.name).toBe('Renamed by teammate');
    });

    timedIt("a fellow tenant member DELETES a filter they did not create", async () => {
      requirePrerequisite(prerequisite);
      const asTeammate = await createTenantScopedClient(teammate, owner.tenantId);
      const { error } = await asTeammate.from('saved_trace_filters').delete().eq('id', sharedFilterId);
      expect(error).toBeNull();

      const { data: gone } = await supabaseAdmin
        .from('saved_trace_filters')
        .select('id')
        .eq('id', sharedFilterId);
      expect(gone).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Cascade Deletion
  // --------------------------------------------------------------------------

  describe('Cascade Deletion', () => {
    timedIt(
      'should delete all filters when the owning user is deleted',
      async () => {
        requirePrerequisite(prerequisite);

        // Create a disposable user
        const disposableUser = await createAuthenticatedUser('admin');

        // The disposable user is in a tenant of its own, so its filters need an
        // app in THAT tenant. Reusing TEST_APP_ID_A here would pair one tenant's
        // id with another tenant's app, which the composite key rejects.
        const { data: disposableApp, error: disposableAppError } = await supabaseAdmin
          .from('app')
          .insert({
            tenant_id: disposableUser.tenantId,
            name: `saved-filters-cascade-${Date.now()}`,
            created_by: disposableUser.id,
          })
          .select('id')
          .single();
        expect(disposableAppError).toBeNull();

        // Create filters for that user
        await supabaseAdmin.from('saved_trace_filters').insert([
          {
            user_id: disposableUser.id,
            tenant_id: disposableUser.tenantId,
            app_id: disposableApp!.id,
            name: 'Cascade Filter 1',
            filter_config: filterConfig('c1'),
          },
          {
            user_id: disposableUser.id,
            tenant_id: disposableUser.tenantId,
            app_id: disposableApp!.id,
            name: 'Cascade Filter 2',
            filter_config: filterConfig('c2'),
          },
        ]);

        // Verify filters exist
        const { data: before } = await supabaseAdmin
          .from('saved_trace_filters')
          .select('id')
          .eq('user_id', disposableUser.id);

        expect(before).toHaveLength(2);

        // Delete the auth user (CASCADE should remove filters)
        // Clean up in FK order: membership → auth user → profile → tenant
        await supabaseAdmin.from('membership').delete().eq('user_id', disposableUser.id);
        await supabaseAdmin.auth.admin.deleteUser(disposableUser.id);
        await supabaseAdmin.from('profile').delete().eq('id', disposableUser.id);

        // Verify filters are gone
        const { data: after } = await supabaseAdmin
          .from('saved_trace_filters')
          .select('id')
          .eq('user_id', disposableUser.id);

        expect(after).toHaveLength(0);

        // Clean up the app before the tenant: app.tenant_id is NO ACTION, so a
        // tenant delete with a live app under it does not go through.
        await supabaseAdmin.from('app').delete().eq('id', disposableApp!.id);
        await supabaseAdmin.from('tenant').delete().eq('tenant_id', disposableUser.tenantId);
      },
    );
  });
});
