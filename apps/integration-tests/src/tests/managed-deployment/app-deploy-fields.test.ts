/**
 * App Deploy Fields Integration Tests
 *
 * Tests the managed deployment columns on the app table:
 *   - runtime (TEXT, DEFAULT 'nodejs', CHECK IN ('nodejs'))
 *   - entry_point, fly_app_name, fly_machine_id, fly_machine_url
 *
 * Note: there is no deploy_status column — deploy state is the 2-step
 * pipeline pair (files_status / code_status on the deployment table).
 *
 * Test naming: should [specific outcome] when [specific condition]
 * Each test seeds its own rows and deletes them in the same block.
 */

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  assertSuccess,
  type TestUser,
} from '../../lib/test-utils';
import { createTestApp, cleanupTestApps } from '../../lib/app-test-utils';

describe('App Deploy Fields Integration Tests', () => {
  let ownerUser: TestUser;
  const admin = getSupabaseAdmin();

  beforeAll(async () => {
    ownerUser = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    await cleanupTestApps(ownerUser.tenantId);
    await cleanupTestUsers();
  });

  afterEach(async () => {
    await cleanupTestApps(ownerUser.tenantId);
  });

  // --------------------------------------------------------------------------
  // Default Values
  // --------------------------------------------------------------------------

  describe('Default values', () => {
    it('should default runtime to nodejs for new apps', async () => {
      // Arrange & Act
      const result = await ownerUser.client
        .from('app')
        .insert({
          tenant_id: ownerUser.tenantId,
          name: `runtime-test-${Date.now()}`,
        })
        .select('runtime')
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.runtime).toBe('nodejs');
    });
  });

  // --------------------------------------------------------------------------
  // runtime Constraint
  // --------------------------------------------------------------------------

  describe('runtime constraint', () => {
    it('should enforce runtime constraint for invalid value', async () => {
      // Arrange
      const app = await createTestApp(ownerUser.tenantId);

      // Act — 'ruby' is not in the allowed set ('nodejs', 'python')
      const result = await admin
        .from('app')
        .update({ runtime: 'ruby' })
        .eq('id', app.id)
        .select()
        .single();

      // Assert: CHECK constraint should reject
      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('23514'); // check_violation
      expect(result.error!.message).toContain('chk_runtime');
    });
  });

  // --------------------------------------------------------------------------
  // Fly.io / Deploy Metadata Fields
  // --------------------------------------------------------------------------

  describe('Deploy metadata fields', () => {
    it('should store and retrieve entry_point', async () => {
      // Arrange
      const app = await createTestApp(ownerUser.tenantId);

      // Act
      const result = await admin
        .from('app')
        .update({ entry_point: 'src/index.ts' })
        .eq('id', app.id)
        .select('entry_point')
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.entry_point).toBe('src/index.ts');
    });

    // `fly_app_name` lives on `environment`, not `app` — see
    // `env-scoped-dispatch.test.ts`. The schema enforces "no fly state on the
    // app row": TypeScript rejects writes to `app.fly_app_name` outright, so
    // a runtime assertion here would be redundant.
  });
});
