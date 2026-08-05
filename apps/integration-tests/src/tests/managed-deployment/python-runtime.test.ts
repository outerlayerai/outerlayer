/**
 * Integration Tests — Python Runtime Constraint on app.runtime column
 *
 * Verifies that the CHECK constraint `chk_runtime` (added in migration
 * 20260331100000_add_python_runtime.sql) correctly allows 'nodejs' and 'python'
 * while rejecting any other value.
 *
 * Uses real local Supabase via getSupabaseAdmin() — no mocking of DB queries.
 *
 * Test naming: should [specific outcome] when [specific condition]
 * Each test seeds its own rows and deletes them in the same block.
 */

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  assertSuccess,
  checkTableExists,
  requirePrerequisite,
  type TestUser,
  type PrerequisiteCheck,
} from '../../lib/test-utils';
import { createTestApp, cleanupTestApps } from '../../lib/app-test-utils';

describe('Python Runtime Constraint Integration Tests', () => {
  let ownerUser: TestUser;
  let prerequisite: PrerequisiteCheck;
  const admin = getSupabaseAdmin();

  beforeAll(async () => {
    prerequisite = await checkTableExists('app');
    if (!prerequisite.available) return;
    ownerUser = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    if (ownerUser) {
      await cleanupTestApps(ownerUser.tenantId);
    }
    await cleanupTestUsers();
  });

  afterEach(async () => {
    if (ownerUser) {
      await cleanupTestApps(ownerUser.tenantId);
    }
  });

  // --------------------------------------------------------------------------
  // Allowed runtimes
  // --------------------------------------------------------------------------

  it('should allow setting runtime to nodejs on app table', async () => {
    // Arrange
    requirePrerequisite(prerequisite);
    const app = await createTestApp(ownerUser.tenantId);

    // Act
    const result = await admin
      .from('app')
      .update({ runtime: 'nodejs' })
      .eq('id', app.id)
      .select('runtime')
      .single();

    // Assert
    assertSuccess(result);
    expect(result.data.runtime).toBe('nodejs');
  });

  it('should allow setting runtime to python on app table', async () => {
    // Arrange
    requirePrerequisite(prerequisite);
    const app = await createTestApp(ownerUser.tenantId);

    // Act
    const result = await admin
      .from('app')
      .update({ runtime: 'python' })
      .eq('id', app.id)
      .select('runtime')
      .single();

    // Assert
    assertSuccess(result);
    expect(result.data.runtime).toBe('python');
  });

  // --------------------------------------------------------------------------
  // Rejected runtimes
  // --------------------------------------------------------------------------

  it('should reject setting runtime to ruby on app table with CHECK constraint violation', async () => {
    // Arrange
    requirePrerequisite(prerequisite);
    const app = await createTestApp(ownerUser.tenantId);

    // Act
    const result = await admin
      .from('app')
      .update({ runtime: 'ruby' })
      .eq('id', app.id)
      .select()
      .single();

    // Assert — the chk_runtime CHECK constraint must reject 'ruby'
    expect(result.data).toBeNull();
    expect(result.error!.code).toBe('23514'); // check_violation
    expect(result.error!.message).toContain('chk_runtime');
  });

  it('should default runtime to nodejs for newly created apps', async () => {
    // Arrange
    requirePrerequisite(prerequisite);

    // Act
    const result = await ownerUser.client
      .from('app')
      .insert({
        tenant_id: ownerUser.tenantId,
        name: `runtime-default-test-${Date.now()}`,
      })
      .select('runtime')
      .single();

    // Assert
    assertSuccess(result);
    expect(result.data.runtime).toBe('nodejs');
  });
});
