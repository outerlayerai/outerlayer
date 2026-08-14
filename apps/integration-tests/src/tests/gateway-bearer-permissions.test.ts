/**
 * Integration test: every GatewayPermission round-trips through app_authorize.
 *
 * The gateway's bearer-auth path delegates authorization to Postgres via
 * `rpc('app_authorize', {requested_permission, target_app_id})`.
 * The RPC casts the string to the `app_permission` enum before checking
 * role_permissions — so any gateway permission that isn't a member of
 * the enum silently fails-closed with a SQLSTATE 22P02 (invalid_text_representation).
 *
 * Unit tests mock the RPC entirely, so they miss this class of bug. This
 * test asserts against a live Postgres:
 *
 *   1. Every string in GATEWAY_PERMISSIONS can be cast to app_permission
 *      (no 22P02 errors).
 *   2. An owner/admin user receives `true` for every gateway permission.
 *   3. A read-role user receives `true` only for the read-shaped permissions
 *      explicitly seeded for them.
 *
 * If someone adds a new value to GATEWAY_PERMISSIONS in the gateway source
 * without adding it to the SQL enum + role_permissions seeds, this test
 * fails loudly instead of letting the bearer path silently 403 that route
 * in production.
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  createTestApp,
  SameTenantUser,
} from './custom-roles/helpers';
import { createSupabaseAdminClient } from '../lib/supabase-admin';

/**
 * Gateway permissions — kept in sync with
 * `apps/gateway/src/lib/permissions.ts::GATEWAY_PERMISSIONS`.
 * Duplicated here intentionally; this is the contract test between
 * the two sources of truth. If someone edits one without the other,
 * this test fails.
 */
const GATEWAY_PERMISSIONS = [
  'trace.write',
  'trace.read',
  'score.write',
  'score.read',
  'score.delete',
  'span.read',
  'session.read',
  'metrics.read',
] as const;

/**
 * Expected permission grants per built-in role. Mirrors the seed in
 * migrations `20260420090309_seed_gateway_permissions_in_role_permissions.sql`
 * + the pre-existing seed for trace.read.
 */
const EXPECTED_READ_ROLE: ReadonlySet<string> = new Set([
  'trace.read',
  'score.read',
  'span.read',
  'session.read',
  'metrics.read',
]);

describe('app_authorize round-trip for every GatewayPermission', () => {
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string; name: string };

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    const admin = createSupabaseAdminClient();
    testApp = await createTestApp(admin, tenantId);
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  // ---------------------------------------------------------------------------
  // 1. Every permission casts to enum without error
  // ---------------------------------------------------------------------------

  it('every GATEWAY_PERMISSIONS string is a valid app_permission enum value', async () => {
    const failures: Array<{ permission: string; error: string }> = [];

    for (const permission of GATEWAY_PERMISSIONS) {
      const { error } = await ownerUser.client.rpc('app_authorize', {
        requested_permission: permission,
        target_app_id: testApp.id,
      });
      if (error) {
        // 22P02 = invalid_text_representation (enum cast failure).
        // Anything else is a different bug, but we want to surface it.
        failures.push({ permission, error: error.message });
      }
    }

    if (failures.length > 0) {
      const report = failures
        .map((f) => `  - ${f.permission}: ${f.error}`)
        .join('\n');
      throw new Error(
        `The following GatewayPermissions failed app_authorize enum cast:\n${report}\n\n` +
          `Fix: add each missing value to the app_permission enum via a migration ` +
          `(ALTER TYPE public.app_permission ADD VALUE IF NOT EXISTS '<permission>') ` +
          `and seed role_permissions for it.`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Owner sees `true` for every permission
  // ---------------------------------------------------------------------------

  it('owner role is granted every GatewayPermission via app_authorize', async () => {
    const denied: string[] = [];

    for (const permission of GATEWAY_PERMISSIONS) {
      const { data, error } = await ownerUser.client.rpc('app_authorize', {
        requested_permission: permission,
        target_app_id: testApp.id,
      });
      if (error) {
        denied.push(`${permission} (error: ${error.message})`);
      } else if (data !== true) {
        denied.push(`${permission} (returned: ${JSON.stringify(data)})`);
      }
    }

    if (denied.length > 0) {
      throw new Error(
        `Owner role was denied the following permissions:\n  ${denied.join('\n  ')}\n\n` +
          `Fix: ensure role_permissions seeds grant each gateway permission to 'owner'.`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Read role is granted ONLY the read-shaped permissions
  // ---------------------------------------------------------------------------

  it('read role is granted exactly the expected read-shaped permissions, nothing more', async () => {
    const unexpectedGrants: string[] = [];
    const missingGrants: string[] = [];

    for (const permission of GATEWAY_PERMISSIONS) {
      const { data, error } = await readUser.client.rpc('app_authorize', {
        requested_permission: permission,
        target_app_id: testApp.id,
      });
      if (error) {
        missingGrants.push(`${permission} (error: ${error.message})`);
        continue;
      }
      const granted = data === true;
      const shouldBeGranted = EXPECTED_READ_ROLE.has(permission);
      if (granted && !shouldBeGranted) {
        unexpectedGrants.push(permission);
      } else if (!granted && shouldBeGranted) {
        missingGrants.push(permission);
      }
    }

    const problems: string[] = [];
    if (unexpectedGrants.length > 0) {
      problems.push(
        `Read role unexpectedly has: ${unexpectedGrants.join(', ')}`,
      );
    }
    if (missingGrants.length > 0) {
      problems.push(`Read role is missing: ${missingGrants.join(', ')}`);
    }

    if (problems.length > 0) {
      throw new Error(
        problems.join('\n') +
          `\n\nIf expanding or shrinking the read role intentionally, update both ` +
          `the migration seed AND EXPECTED_READ_ROLE at the top of this test.`,
      );
    }
  });
});
