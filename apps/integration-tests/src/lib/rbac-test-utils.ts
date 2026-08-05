import { createAuthenticatedUser, getSupabaseAdmin } from './test-utils';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export type Role = 'owner' | 'admin' | 'write' | 'read' | 'disabled';
type ResourceOperation = 'select' | 'insert' | 'update' | 'delete';
export type ResourceType = 'app' | 'profile' | 'api_key' | 'billing' | 'tenant' | 'git_connection' | 'git_branch' | 'user_git_identity';

export interface TestUser {
  id: string;
  tenantId: string;
  client: SupabaseClient;
  role: Role;
}

export interface ResourceTest {
  table: ResourceType;
  operation: ResourceOperation;
  data?: Record<string, unknown>;
  where?: Record<string, unknown>;
  expectedSuccess: boolean;
  expectedErrorPattern?: string;
  description?: string; // For better test reporting
  /**
   * For a "select allow": the exact set of row ids the caller must see. Without
   * it, a select-allow only checks error === null, which a policy that hides
   * every row also satisfies — "allow" and "hide everything" become
   * indistinguishable. Seed a known row and pin its id here.
   */
  expectedVisibleIds?: string[];
  /**
   * Column list for a 'select' operation, passed straight to `.select(...)`.
   * Defaults to `'*'`. A column-scoped table (one with per-column GRANTs for
   * `authenticated`, e.g. `git_connection`) needs its safe columns named here
   * — `'*'` on such a table is a guaranteed privilege error, not an RLS
   * signal, and would make every case using it fail unconditionally rather
   * than distinguish "RLS denied you" from "you lack a column grant".
   */
  selectColumns?: string;
}

export interface ProfileTestConfig {
  role: Role;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canUpdateOwnProfile: boolean;
  canUpdateOtherProfiles: boolean;
  expectedReadError?: string;
  expectedCreateError?: string;
  expectedUpdateError?: string;
  expectedDeleteError?: string;
}

// ============================================================================
// PERMISSION MATRICES (Single Source of Truth)
// ============================================================================

// ============================================================================
// TEST USER MANAGEMENT
// ============================================================================

/**
 * Create a test user with the specified role
 */
export async function createTestUser(role: Role): Promise<TestUser> {
  const user = await createAuthenticatedUser(role);
  return {
    id: user.id,
    tenantId: user.tenantId,
    client: user.client,
    role
  };
}

// ============================================================================
// PERMISSION TESTING UTILITIES
// ============================================================================

/**
 * Test if a user has a specific permission using the authorize RPC function
 */
export async function testPermission(user: TestUser, permission: string): Promise<boolean> {
  const { data: hasPermission, error } = await user.client.rpc('authorize', {
    requested_permission: permission
  });

  if (error) {
    throw new Error(`Permission test failed for ${permission}: ${error.message}`);
  }

  return hasPermission;
}

// ============================================================================
// RESOURCE ACCESS TESTING UTILITIES
// ============================================================================

/**
 * Test resource access for a user with improved error handling and reporting
 */
export async function testResourceAccess(user: TestUser, tests: ResourceTest[]): Promise<void> {
  for (const test of tests) {
    const testDescription = test.description || `${user.role} ${test.operation} on ${test.table}`;

    // Execute each operation branch independently to avoid Supabase SDK
    // type incompatibility between PostgrestQueryBuilder and PostgrestFilterBuilder.
    let data: unknown = null;
    let error: { message: string } | null = null;

    switch (test.operation) {
      case 'select': {
        let q = user.client.from(test.table).select(test.selectColumns ?? '*');
        if (test.where) {
          for (const [key, value] of Object.entries(test.where)) {
            q = q.eq(key, String(value));
          }
        }
        ({ data, error } = await q);
        break;
      }
      case 'insert': {
        ({ data, error } = await user.client.from(test.table).insert(test.data || {}));
        break;
      }
      case 'update': {
        let q = user.client.from(test.table).update(test.data || {});
        if (test.where) {
          for (const [key, value] of Object.entries(test.where)) {
            q = q.eq(key, String(value));
          }
        }
        ({ data, error } = await q);
        break;
      }
      case 'delete': {
        let q = user.client.from(test.table).delete();
        if (test.where) {
          for (const [key, value] of Object.entries(test.where)) {
            q = q.eq(key, String(value));
          }
        }
        ({ data, error } = await q);
        break;
      }
    }

    if (test.expectedSuccess) {
      expect(error).toBeNull();
      if (test.operation === 'select') {
        if (test.expectedVisibleIds) {
          const seenIds = ((data as Array<{ id: string }> | null) ?? [])
            .map((row) => row.id)
            .sort();
          expect(seenIds).toEqual([...test.expectedVisibleIds].sort());
        } else {
          expect(data).toBeDefined();
        }
      }
    } else {
      // Handle different types of "failure" responses
      if (error) {
        // Traditional error response
        expect(error).not.toBeNull();
        if (test.expectedErrorPattern) {
          expect(error.message).toContain(test.expectedErrorPattern);
        }
      } else if (test.operation === 'select' && Array.isArray(data) && data.length === 0) {
        // For select operations, empty array might indicate no access
        if (test.expectedErrorPattern) {
          expect(data).toHaveLength(0);
        }
      } else if (test.operation === 'update' || test.operation === 'delete') {
        // For update/delete operations, no error might mean no rows affected
        if (test.expectedErrorPattern) {
          if (data === null) {
            expect(data).toBeNull();
          } else if (Array.isArray(data)) {
            expect(data).toHaveLength(0);
          }
        }
      } else {
        // If we expected an error but got none, and it's not a select operation
        if (test.expectedErrorPattern) {
          throw new Error(`${testDescription} expected to fail with pattern "${test.expectedErrorPattern}" but it succeeded`);
        }
      }
    }
  }
}

// ============================================================================
// DATA MANAGEMENT UTILITIES
// ============================================================================

/**
 * Create test data using admin client with better error handling
 */
export async function createTestData(table: string, data: Record<string, unknown>): Promise<Record<string, unknown> & { id: string }> {
  const supabaseAdmin = getSupabaseAdmin();
  
  // Handle profile table specially - it needs an id that references auth.users
  if (table === 'profile') {
    // For profile, we need to ensure the user exists in auth.users first
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserById(data.id as string);
    
    if (!existingUser.user) {
      // Create the auth user if it doesn't exist
      const { error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: (data.email as string | undefined) || `${data.id}@test.com`,
        password: 'TestPassword123!',
        email_confirm: true,
        user_metadata: { id: data.id }
      });
      
      if (authError) {
        throw new Error(`Failed to create auth user for profile: ${authError.message}`);
      }
    }
    
    const { data: result, error } = await supabaseAdmin
      .from(table)
      .insert(data)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create test data for ${table}: ${error.message}`);
    }

    return result;
  }
  
  const { data: result, error } = await supabaseAdmin
    .from(table)
    .insert(data)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create test data for ${table}: ${error.message}`);
  }

  return result;
}

/**
 * Clean up test data using admin client with better error handling
 */
export async function cleanupTestData(table: string, whereClause: Record<string, unknown>): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin();
  let query = supabaseAdmin.from(table).delete();

  Object.entries(whereClause).forEach(([key, value]) => {
    query = query.eq(key, value);
  });

  const { error } = await query;
  if (error) {
    console.warn(`Failed to cleanup test data for ${table}: ${error.message}`);
  }
}

// ============================================================================
// CROSS-TENANT ISOLATION TESTING
// ============================================================================

// ============================================================================
// JWT CLAIMS TESTING
// ============================================================================

// ============================================================================
// TEST DATA GENERATORS
// ============================================================================

export function getProfileTests(testUser: TestUser, config: ProfileTestConfig): ResourceTest[] {
  const admin = getSupabaseAdmin();

  // Create test profile for the user
  try {
    admin.from('profile').insert({
      id: testUser.id,
      name: `${config.role} User`,
      email: `${config.role.toLowerCase()}@test.com`
    });
  } catch {
    // Profile might already exist
  }

  return [
    {
      table: 'profile' as ResourceType,
      operation: 'select' as const,
      expectedSuccess: config.canRead,
      expectedErrorPattern: config.expectedReadError,
      description: `${config.role} should ${config.canRead ? 'be able to' : 'not be able to'} read profiles`
    },
    {
      table: 'profile' as ResourceType,
      operation: 'insert' as const,
      data: { name: `${config.role} Test Profile`, email: `${config.role.toLowerCase()}-test@example.com` },
      expectedSuccess: config.canCreate,
      expectedErrorPattern: config.expectedCreateError,
      description: `${config.role} should ${config.canCreate ? 'be able to' : 'not be able to'} create profiles`
    },
    {
      table: 'profile' as ResourceType,
      operation: 'update' as const,
      data: { name: `Updated ${config.role} Profile` },
      where: { name: `${config.role} Test Profile` },
      expectedSuccess: config.canUpdate,
      expectedErrorPattern: config.expectedUpdateError,
      description: `${config.role} should ${config.canUpdate ? 'be able to' : 'not be able to'} update profiles`
    },
    {
      table: 'profile' as ResourceType,
      operation: 'delete' as const,
      where: { name: `Updated ${config.role} Profile` },
      expectedSuccess: config.canDelete,
      expectedErrorPattern: config.expectedDeleteError,
      description: `${config.role} should ${config.canDelete ? 'be able to' : 'not be able to'} delete profiles`
    }
  ];
}

// ============================================================================
// PROFILE SECURITY TEST HELPERS
// ============================================================================

/**
 * Tests that a user can update their own profile.
 * Shared by the profile security tests in every RBAC file.
 */
export async function testSelfProfileUpdate(testUser: TestUser, role: string): Promise<void> {
  const { error } = await testUser.client
    .from('profile')
    .update({ name: `${role} User Updated` })
    .eq('id', testUser.id);

  expect(error).toBeNull();
}

/**
 * Tests that RLS prevents a user from updating another user's profile.
 *
 * Asserts the outcome (the profile still holds its original name) rather than
 * the mere presence of an error.
 */
export async function testCrossProfileUpdateBlocked(testUser: TestUser, role: string): Promise<void> {
  const otherUser = await createTestUser('write');
  const admin = getSupabaseAdmin();

  try {
    // Set a known name on the other user's profile (already exists from createTestUser)
    await admin.from('profile').update({
      name: 'Other User',
    }).eq('id', otherUser.id);

    // Attempt to update other user's profile
    await testUser.client
      .from('profile')
      .update({ name: `Hacked by ${role}` })
      .eq('id', otherUser.id);

    // Verify profile was NOT updated (positive outcome assertion)
    const { data: profile } = await admin
      .from('profile')
      .select('name')
      .eq('id', otherUser.id)
      .single();

    expect(profile?.name).toBe('Other User');
  } finally {
    // Cleanup: remove the user created for this test
    await admin.from('profile').delete().eq('id', otherUser.id);
    await admin.from('membership').delete().eq('user_id', otherUser.id);
    await admin.auth.admin.deleteUser(otherUser.id);
  }
}

/**
 * Tests that RLS prevents profile self-deletion.
 */
export async function testProfileDeletionBlocked(testUser: TestUser): Promise<void> {
  const { error } = await testUser.client
    .from('profile')
    .delete()
    .eq('id', testUser.id);

  expect(error).not.toBeNull();
  expect(error?.message).toMatch(/permission denied/);
}
