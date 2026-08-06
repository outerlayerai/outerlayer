/**
 * Integration tests for the custom-role permission-surface cleanup: picker
 * retirements/additions, role_permissions seed retirement, and the
 * custom_role_permission backfill that keeps existing custom roles whole
 * across it.
 *
 * The seed-drift checks run on the real wire: role_permissions /
 * custom_role_permission rows and the authorize() RPC, all under a real
 * Supabase session. The last suite drives CustomRoleService directly (the
 * same pattern as custom-role-service-integration.test.ts) to prove the
 * picker's DB-level expansion round-trips through a real create + reload.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createBillingRecord,
  cleanupBilling,
  SameTenantUser,
} from './helpers';
import { CustomRoleService } from '@ee/features/custom-roles/custom-role-service';
import { expandKeysToDbPermissions } from '@/utils/permissions';
import { APP_PERMISSIONS, INTENTIONALLY_UNSEEDED } from '@repo/db-types/permissions';
import { join } from 'path';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

// The retired permission surface. None of these carries an RLS policy or a
// code call site, and none is a member of public.app_permission any more —
// the guarantee is structural rather than row-level, so a re-added label is
// what this list catches, not a stray grant. Typed as plain strings on
// purpose: an AppPermission-typed list could not name a value the enum has
// dropped, which is exactly what has to be asserted absent.
const RETIRED_PERMISSIONS: readonly string[] = [
  'dataset_item_snapshot.read',
  'score_config.read',
  'billing.delete',
  'experiment.run',
  'annotations.read',
  'annotations.insert',
  'tenant.insert',
  'tenant.delete',
  'template.read',
  'template.insert',
  'template.update',
  'template.delete',
  'dataset.read',
  'dataset.insert',
  'dataset.update',
  'dataset.delete',
];

describe('Custom-role permission-surface cleanup', () => {
  const supabaseAdmin = createSupabaseAdminClient();

  // Static enum + role_permissions state — no per-test tenant needed for the
  // seed-level checks. These read the catalog through a raw connection because
  // the question is about the enum's own labels, which PostgREST does not
  // expose (and a query filtering an enum column by a retired name would error
  // on the cast rather than return zero rows).
  describe('the retired permission surface is gone from public.app_permission', () => {
    let pgClient: Client;

    beforeAll(async () => {
      pgClient = new Client({ connectionString: DATABASE_URL });
      await pgClient.connect();
    });

    afterAll(async () => {
      await pgClient.end();
    });

    async function enumLabels(): Promise<string[]> {
      const { rows } = await pgClient.query<{ label: string }>(
        `SELECT e.enumlabel AS label
           FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typnamespace = 'public'::regnamespace
            AND t.typname = 'app_permission'`,
      );
      return rows.map((r) => r.label);
    }

    it('carries no retired label — a re-added one would be grantable from the picker again', async () => {
      const labels = new Set(await enumLabels());
      expect(RETIRED_PERMISSIONS.filter((p) => labels.has(p))).toEqual([]);
    });

    it('is exactly the shared catalog, so nothing is offered that no role can hold', async () => {
      // The seed-completeness invariant leaves no unseeded remainder: every
      // live label is granted to owner, and APP_PERMISSIONS is that same set.
      // Equality both ways catches a label added to the DB without codegen and
      // a codegen entry with no DB label behind it.
      expect((await enumLabels()).sort()).toEqual([...APP_PERMISSIONS].sort());
      expect(INTENTIONALLY_UNSEEDED).toEqual([]);
    });
  });

  describe('the retirement DELETE is scoped exactly — untouched grants survive', () => {
    it('keeps worker_run.* seeded to owner/admin/write (+ read for worker_run.read)', async () => {
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role, permission')
        .in('permission', ['worker_run.read', 'worker_run.insert', 'worker_run.update', 'worker_run.delete']);

      expect(error).toBeNull();
      const pairs = new Set(data!.map((r) => `${r.role}:${r.permission}`));
      for (const role of ['owner', 'admin', 'write']) {
        for (const perm of ['worker_run.read', 'worker_run.insert', 'worker_run.update', 'worker_run.delete']) {
          expect(pairs.has(`${role}:${perm}`), `expected ${role}:${perm}`).toBe(true);
        }
      }
      expect(pairs.has('read:worker_run.read')).toBe(true);
      expect(pairs.has('read:worker_run.insert')).toBe(false);
    });

    it('keeps billing.read seeded to all four roles and billing.insert/update owner-only', async () => {
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role, permission')
        .in('permission', ['billing.read', 'billing.insert', 'billing.update']);

      expect(error).toBeNull();
      const pairs = new Set(data!.map((r) => `${r.role}:${r.permission}`));
      for (const role of ['owner', 'admin', 'write', 'read']) {
        expect(pairs.has(`${role}:billing.read`), `expected ${role}:billing.read`).toBe(true);
      }
      expect(pairs.has('owner:billing.insert')).toBe(true);
      expect(pairs.has('owner:billing.update')).toBe(true);
      expect(pairs.has('admin:billing.insert')).toBe(false);
      expect(pairs.has('admin:billing.update')).toBe(false);
    });

    it('keeps experiment.read seeded to all four roles', async () => {
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role, permission')
        .eq('permission', 'experiment.read');

      expect(error).toBeNull();
      expect(data!.map((r) => r.role).sort()).toEqual(['admin', 'owner', 'read', 'write']);
    });
  });

  describe('a write member holds no destructive org grant; tenant.update is untouched', () => {
    let writeUser: SameTenantUser;
    let ownerUser: SameTenantUser;
    let tenantId: string;

    beforeAll(async () => {
      ownerUser = await createTenantWithOwner();
      tenantId = ownerUser.tenantId;
      writeUser = await addUserToTenant(tenantId, 'write');
    });

    afterAll(async () => {
      await cleanupTenantAndUsers(tenantId, [ownerUser, writeUser]);
    });

    // app.delete is the destructive counterpart to tenant.update that the
    // built-in ladder stops short of at the write level: the seed grants it to
    // owner/admin only, so a write member reading true here means the ladder
    // has been widened.
    it('authorize("app.delete") is false for a write-role member', async () => {
      const { data, error } = await writeUser.client.rpc('authorize', {
        requested_permission: 'app.delete',
      });
      expect(error).toBeNull();
      expect(data).toBe(false);
    });

    it('authorize("tenant.update") is still true for a write-role member', async () => {
      const { data, error } = await writeUser.client.rpc('authorize', {
        requested_permission: 'tenant.update',
      });
      expect(error).toBeNull();
      expect(data).toBe(true);
    });
  });

  // Full round-trip on the wire — create a custom role via CustomRoleService
  // with a new-group expansion, verify the custom_role_permission rows
  // exactly, then reload and confirm the same permission set is recoverable.
  describe('CustomRoleService round-trip for a new picker group', () => {
    let ownerUser: SameTenantUser;
    let tenantId: string;
    let service: CustomRoleService;

    beforeAll(async () => {
      ownerUser = await createTenantWithOwner();
      tenantId = ownerUser.tenantId;
      await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
      service = new CustomRoleService({ db: supabaseAdmin, adminDb: supabaseAdmin, actorId: ownerUser.id });
    });

    afterAll(async () => {
      await cleanupCustomRoles(supabaseAdmin, tenantId);
      await cleanupBilling(supabaseAdmin, tenantId);
      await cleanupTenantAndUsers(tenantId, [ownerUser]);
    });

    it('creates custom_role_permission rows exactly matching the Context group expansion and reloads identically', async () => {
      // Derived from the picker's own expansion function rather than
      // hand-listed, so this stays a real regression test of the wiring
      // between the picker and the service: if the Context group's
      // dbPermissions ever change, this test's expectation moves with it
      // instead of silently passing against a stale hardcoded list.
      const permissions = expandKeysToDbPermissions(['context_view', 'context_manage']);

      const result = await service.create(tenantId, {
        name: `Context-Round-Trip-Role-${Date.now()}`,
        permissions,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { data: rows, error } = await supabaseAdmin
        .from('custom_role_permission')
        .select('permission')
        .eq('custom_role_id', result.data.id);
      expect(error).toBeNull();
      expect(rows!.map((r) => r.permission).sort()).toEqual([...permissions].sort());

      const reloaded = await service.getAll(tenantId);
      expect(reloaded.success).toBe(true);
      if (!reloaded.success) return;
      const reloadedRole = reloaded.data.find((r) => r.id === result.data.id);
      expect(reloadedRole?.permissions.sort()).toEqual([...permissions].sort());
    });
  });
});
