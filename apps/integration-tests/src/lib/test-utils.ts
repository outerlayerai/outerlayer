/**
 * Integration Test Utilities
 *
 * This module provides shared utilities for integration tests:
 *
 * - getSupabaseAdmin(): Get admin client for database operations
 * - createAuthenticatedUser(role): Create a test user with membership and sign in
 * - cleanupTestUsers(): Clean up all created test users and their data
 *
 * Usage Pattern:
 * ```typescript
 * import { getSupabaseAdmin, createAuthenticatedUser, cleanupTestUsers } from '../../lib/test-utils';
 *
 * describe('My Test', () => {
 *   afterAll(async () => { await cleanupTestUsers(); });
 *
 *   it('should work', async () => {
 *     const user = await createAuthenticatedUser('admin');
 *     // user.client is authenticated Supabase client
 *     // user.tenantId, user.id, user.email available
 *   });
 * });
 * ```
 */

import { createSupabaseAdminClient, SupabaseAdminClient } from './supabase-admin';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { retryingFetch } from './retrying-fetch';
import type { Database } from 'tenant-dashboard/src/types/db';

type MembershipRole = Database['public']['Tables']['membership']['Insert']['role'];
type TableName = keyof Database['public']['Tables'];
import { retryOnTransientError } from './retry';

type RpcName = keyof Database['public']['Functions'];

export interface TestUser {
  id: string;
  email: string;
  password: string;
  tenantId: string;
  client: SupabaseClient<Database>;
}

let supabaseAdmin: SupabaseAdminClient | null = null;
let testUsers: TestUser[] = [];

export function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    supabaseAdmin = createSupabaseAdminClient();
  }
  return supabaseAdmin;
}

export async function createAuthenticatedUser(role: MembershipRole): Promise<TestUser> {
  const admin = getSupabaseAdmin();
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  const email = `user-${timestamp}-${randomId}@test-tenant-${randomId}.com`;
  const password = 'TestPassword123!';
  const { randomUUID } = require('crypto');
  const tenantId = randomUUID();
  const userId = randomUUID(); // This is just for the tenant creation

  try {
    // Create tenant first - with retry for transient errors
    const { error: tenantError } = await retryOnTransientError(() =>
      admin.from('tenant').insert({
        tenant_id: tenantId,
        company_name: `test-company-${randomId}`,
        organization_name: `test-org-${timestamp}-${randomId}`,
        created_by: userId // We'll update this later with the actual auth user ID
      })
    );

    if (tenantError) {
      console.error('Failed to create tenant:', tenantError);
      throw new Error(`Failed to create tenant: ${tenantError.message}`);
    }

    // Create auth user FIRST (let Supabase generate the ID) - with retry for transient errors
    let authData: { user: { id: string; email?: string } | null } | null = null;
    let authError: { message: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await admin.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true
      });
      if (!result.error || !result.error.message.includes('upstream server')) {
        authData = result.data;
        authError = result.error;
        break;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }

    if (authError || !authData?.user) {
      console.error('Failed to create auth user:', authError);
      throw new Error(`Failed to create auth user: ${authError?.message || 'No user data returned'}`);
    }

    // Use the actual auth user ID that was created
    const actualUserId = authData.user.id;

    // Update the tenant with the correct created_by - with retry for transient errors
    await retryOnTransientError(() =>
      admin.from('tenant').update({
        created_by: actualUserId
      }).eq('tenant_id', tenantId)
    );

    // Create profile FIRST - with retry for transient errors (this insert was
    // the one unguarded setup write left; a PostgREST/Kong "invalid response
    // from the upstream server" blip here failed whole suites in CI)
    const { error: profileError } = await retryOnTransientError(() =>
      admin.from('profile').insert({
        id: actualUserId,
        name: `Test User ${randomId}`,
        email: email
      })
    );

    if (profileError) {
      console.error('Failed to create profile:', profileError);
      throw new Error(`Failed to create profile: ${profileError.message}`);
    }

    // Create membership to link user to tenant with role
    // Use retry for transient errors in CI environments
    const { error: membershipError } = await retryOnTransientError(() =>
      admin.from('membership').insert({
        user_id: actualUserId,
        tenant_id: tenantId,
        role: role,
        status: 'active'
      })
    );

    if (membershipError) {
      console.error('Failed to create membership:', membershipError);
      throw new Error(`Failed to create membership: ${membershipError.message}`);
    }

    // MANUALLY set tenant_id claim (mirror production flow) - with retry for transient errors
    const { error: tenantClaimError } = await retryOnTransientError(() =>
      admin.rpc("set_claim", {
        claim: "tenant_id",
        uid: actualUserId,
        value: tenantId,
      })
    );

    if (tenantClaimError) {
      console.error('Failed to set tenant_id claim:', tenantClaimError);
      throw new Error(`Failed to set tenant_id claim: ${tenantClaimError.message}`);
    }

    // MANUALLY set role claim (mirror production flow) - with retry for transient errors
    const { error: roleClaimError } = await retryOnTransientError(() =>
      admin.rpc("set_claim", {
        claim: "role",
        uid: actualUserId,
        value: role,
      })
    );

    if (roleClaimError) {
      console.error('Failed to set role claim:', roleClaimError);
      throw new Error(`Failed to set role claim: ${roleClaimError.message}`);
    }

    // Create authenticated client for this user
    const userClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
      // Absorb transient local-Supabase gateway 502s under parallel CI load.
      { global: { fetch: retryingFetch } }
    );

    // Sign in as the user (NOW the JWT should get the proper role claim)
    const { error: signInError } = await userClient.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (signInError) {
      console.error('Failed to sign in user:', signInError);
      throw new Error(`Failed to sign in user: ${signInError.message}`);
    }

    // Refresh the session to get updated JWT claims with user_role
    const { error: refreshError } = await userClient.auth.refreshSession();
    if (refreshError) {
      console.warn('Failed to refresh session:', refreshError);
    }

    const user: TestUser = {
      id: actualUserId, // Use the actual auth user ID
      email,
      password,
      tenantId,
      client: userClient
    };

    testUsers.push(user);
    return user;
  } catch (error) {
    console.error('Error in createAuthenticatedUser:', error);
    throw error;
  }
}

export async function cleanupTestUsers() {
  const admin = getSupabaseAdmin();
  for (const user of testUsers) {
    try {
      // Delete in proper order respecting foreign key constraints

      // 1. Delete api_keys (they reference app which references tenant)
      await admin.from('api_key').delete().eq('tenant_id', user.tenantId);

      // 2. Delete apps (they reference tenant)
      await admin.from('app').delete().eq('tenant_id', user.tenantId);

      // 3. Delete membership
      await admin.from('membership').delete().eq('user_id', user.id);

      // 4. Delete auth user
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch (authError) {
        console.warn(`Could not delete auth user ${user.id}:`, authError);
      }

      // 5. Delete profile
      await admin.from('profile').delete().eq('id', user.id);

      // 6. Delete tenant last
      await admin.from('tenant').delete().eq('tenant_id', user.tenantId);

    } catch (error) {
      console.warn(`Failed to cleanup user ${user.email}:`, error);
    }
  }

  testUsers = [];
}

/**
 * Prerequisite check result for integration tests.
 * When a prerequisite (like a table) doesn't exist, tests should skip rather than silently pass.
 */
export interface PrerequisiteCheck {
  available: boolean;
  skipReason?: string;
}

/**
 * Check if a database table exists and is accessible.
 * Returns a PrerequisiteCheck that can be used with requirePrerequisite().
 */
export async function checkTableExists(tableName: TableName): Promise<PrerequisiteCheck> {
  const admin = getSupabaseAdmin();
  // Cast past the generic overload: distributing `.from<T>()` over the full
  // TableName union (all public.Tables keys) blows past TS's instantiation
  // depth limit (TS2589) once the union gets large enough — this call only
  // inspects `error`, so the precise row type is unused and safe to erase.
  const { error } = await admin.from(tableName as any).select('*').limit(1);

  if (error) {
    return {
      available: false,
      skipReason: `Table '${tableName}' not available: ${error.message}. Run migrations first.`,
    };
  }

  return { available: true };
}

/**
 * Check if an RPC function exists and is callable.
 */
export async function checkRpcExists<T extends RpcName>(
  rpcName: T,
  testParams: Database['public']['Functions'][T]['Args']
): Promise<PrerequisiteCheck> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.rpc(rpcName, testParams);

  // PGRST202 means function not found; other errors might be valid (e.g., FK constraint)
  if (error?.code === 'PGRST202' || error?.message?.includes('Could not find the function')) {
    return {
      available: false,
      skipReason: `RPC '${rpcName}' not available. Run migrations first.`,
    };
  }

  return { available: true };
}

/**
 * Throws a descriptive error when a test prerequisite is not met.
 * This causes the test to fail explicitly rather than silently pass.
 *
 * Usage:
 * ```typescript
 * let prerequisiteCheck: PrerequisiteCheck;
 *
 * beforeAll(async () => {
 *   prerequisiteCheck = await checkTableExists('feature_flag');
 * });
 *
 * it('should do something', async () => {
 *   requirePrerequisite(prerequisiteCheck);
 *   // ... test code
 * });
 * ```
 */
export function requirePrerequisite(check: PrerequisiteCheck): void {
  if (!check.available) {
    // Use Jest's skip mechanism if available
    if (typeof (global as unknown as { it: { skip?: unknown } }).it?.skip === 'function') {
      throw new Error(`[SKIP] ${check.skipReason}`);
    }
    // Throw a clear error that shows up in test output
    throw new Error(`[PREREQUISITE NOT MET] ${check.skipReason}`);
  }
}

// ============================================================================
// Test Timing Enforcement
// ============================================================================

/**
 * Time limits by test type:
 * - Unit tests: < 100ms
 * - Integration tests: < 5s (5000ms)
 * - E2E tests: < 30s (30000ms)
 */
const TEST_TIME_LIMITS = {
  unit: 100,
  integration: 5000,
  e2e: 30000,
} as const;

export type TestType = keyof typeof TEST_TIME_LIMITS;

/**
 * Wraps a test function with timing enforcement.
 * Fails the test if it exceeds the time limit for its type.
 *
 * @example
 * ```typescript
 * it('should create app', withTimingEnforcement('integration', async () => {
 *   // test code - will fail if > 5 seconds
 * }));
 * ```
 */
function withTimingEnforcement(
  testType: TestType,
  testFn: () => Promise<void>
): () => Promise<void> {
  const timeLimit = TEST_TIME_LIMITS[testType];

  return async () => {
    const startTime = performance.now();
    let testError: unknown = null;

    try {
      await testFn();
    } catch (err) {
      testError = err;
    }

    const elapsed = performance.now() - startTime;
    const timingViolation = elapsed > timeLimit
      ? `[TIMING VIOLATION] ${testType} test took ${elapsed.toFixed(0)}ms, ` +
        `exceeding the ${timeLimit}ms limit. ` +
        `Consider optimizing or splitting this test.`
      : null;

    // Re-throw the original test error first so the developer sees the real failure
    if (testError) {
      if (timingViolation) {
        console.warn(timingViolation);
      }
      throw testError;
    }

    // Only throw timing violation when the test itself passed
    if (timingViolation) {
      throw new Error(timingViolation);
    }
  };
}

/**
 * Creates a test suite with automatic timing enforcement for all tests.
 * Use this wrapper for describe blocks to enforce timing on all tests within.
 *
 * @example
 * ```typescript
 * import { createTimedTestSuite } from '../../lib/test-utils';
 *
 * const { timedIt } = createTimedTestSuite('integration');
 *
 * describe('My Tests', () => {
 *   timedIt('should work fast', async () => {
 *     // automatically enforced < 5s
 *   });
 * });
 * ```
 */
export function createTimedTestSuite(testType: TestType) {
  return {
    timedIt: (name: string, testFn: () => Promise<void>) => {
      it(name, withTimingEnforcement(testType, testFn));
    },
    timeLimit: TEST_TIME_LIMITS[testType],
  };
}

// ============================================================================
// Test Quality Enforcement (assert outcomes, not the absence of an error)
// ============================================================================

/**
 * Assertion helper that enforces positive assertions.
 * Use this instead of expect(x).toBeUndefined() or expect(x).toBeNull().
 *
 * @example
 * ```typescript
 * // ❌ BAD: Asserts absence
 * expect(result.error).toBeUndefined();
 *
 * // ✅ GOOD: Assert the actual outcome
 * assertSuccess(result);
 * expect(result.data.name).toBe('Expected Name');
 * ```
 */
export function assertSuccess<T>(result: { data: T | null; error: unknown }): asserts result is { data: T; error: null } {
  if (result.error) {
    throw new Error(
      `Expected success but got error: ${JSON.stringify(result.error, null, 2)}`
    );
  }
  if (result.data === null) {
    throw new Error('Expected data but got null');
  }
}

// ============================================================================
// Flakiness Detection
// ============================================================================
