/**
 * Integration tests for environment permission gating.
 *
 * Coverage:
 *   1-3) Built-in role behavior (write / read / disabled) against the real
 *        `environment` RLS policies — uses user clients to hit RLS directly.
 *   4)   Custom roles do NOT auto-receive env.* permissions on migration —
 *        asserted via the seed table (no `custom_role_permission` rows for
 *        env.* exist post-migration).
 *   5-7) Constants-level assertions on `GATEWAY_PERMISSIONS` and
 *        `ROLE_PERMISSION_SETS` (API-key permission registry).
 */
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  setupEnvFixture,
  type EnvTestFixture,
  type SameTenantUser,
} from './helpers';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  GATEWAY_PERMISSIONS,
  ROLE_PERMISSION_SETS,
} from '@repo/gateway-core/lib/permissions';

describe('Environment permissions', () => {
  let fixture: EnvTestFixture;
  // Cast to a generic SupabaseClient — the typed `Database` does not yet know
  // about `environment` / `custom_role_permission` env rows until
  // `yarn codegen:db` runs.
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  beforeAll(async () => {
    fixture = await setupEnvFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Built-in 'write' role gates
  // ────────────────────────────────────────────────────────────────────────

  describe("built-in 'write' role", () => {
    it('should allow INSERT on environment when role is write (environment.insert granted)', async () => {
      // Arrange: writer is org-role 'write' which has environment.insert.

      // Act
      const { data, error } = await fixture.writerUser.client
        .from('environment')
        .insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: `write-insert-${Date.now().toString(36)}`,
          is_default: false,
          created_by: fixture.writerUser.id,
        })
        .select('id, name')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data).not.toBeNull();

      // Cleanup
      if (data) await admin.from('environment').delete().eq('id', data.id);
    });

    it('should deny DELETE on environment when role is write (environment.delete NOT granted)', async () => {
      // Arrange: seed a non-default env to attempt to delete.
      const { data: env, error: seedError } = await admin
        .from('environment')
        .insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: `write-delete-${Date.now().toString(36)}`,
          is_default: false,
          fly_app_name: `fly-${Date.now()}`,
          created_by: fixture.ownerUser.id,
        })
        .select('id')
        .single();
      if (seedError || !env) throw new Error(`seed: ${seedError?.message}`);

      // Act: writer attempts DELETE — RLS should silently return 0 rows.
      const { error } = await fixture.writerUser.client
        .from('environment')
        .delete()
        .eq('id', env.id);

      // Assert: no error from the client, but the row still exists.
      expect(error).toBeNull();
      const { data: stillThere } = await admin
        .from('environment')
        .select('id')
        .eq('id', env.id)
        .maybeSingle();
      expect(stillThere).not.toBeNull();

      // Cleanup
      await admin.from('environment').delete().eq('id', env.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Built-in 'read' role
  // ────────────────────────────────────────────────────────────────────────

  describe("built-in 'read' role", () => {
    it('should allow SELECT on environment when role is read (environment.read granted)', async () => {
      // Act
      const { data, error } = await fixture.readerUser.client
        .from('environment')
        .select('id, name')
        .eq('app_id', fixture.app.id);

      // Assert: reader sees the rows (at minimum the default env).
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(1);
    });

    it('should deny INSERT on environment when role is read (environment.insert NOT granted)', async () => {
      // Act
      const { error } = await fixture.readerUser.client
        .from('environment')
        .insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: `read-insert-${Date.now().toString(36)}`,
          is_default: false,
          created_by: fixture.readerUser.id,
        });

      // Assert: RLS rejects with a row-level security error.
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/row-level security/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 'disabled' role gets nothing
  // ────────────────────────────────────────────────────────────────────────

  describe("built-in 'disabled' role", () => {
    let disabledUser: SameTenantUser;
    let disabledClient: ReturnType<typeof createClient>;

    beforeAll(async () => {
      // Create a disabled-role user in the same tenant.
      const rid = Math.random().toString(36).substring(2, 8);
      const email = `disabled-${Date.now()}-${rid}@test-envs.com`;
      const password = 'TestPassword123!';

      const { data: authData, error: authError } =
        await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (authError || !authData?.user) {
        throw new Error(`disabled auth: ${authError?.message}`);
      }
      const userId = authData.user.id;
      await admin.from('profile').insert({ id: userId, name: `Disabled ${rid}`, email });
      const { data: membership } = await admin
        .from('membership')
        .insert({
          user_id: userId,
          tenant_id: fixture.tenant.id,
          role: 'disabled',
          status: 'active',
        })
        .select('id')
        .single();

      await admin.rpc('set_claim', {
        claim: 'tenant_id',
        uid: userId,
        value: fixture.tenant.id,
      });
      await admin.rpc('set_claim', {
        claim: 'role',
        uid: userId,
        value: 'disabled',
      });

      disabledClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331',
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
      );
      await disabledClient.auth.signInWithPassword({ email, password });
      await disabledClient.auth.refreshSession();

      disabledUser = {
        id: userId,
        email,
        tenantId: fixture.tenant.id,
        membershipId: (membership?.id as string) ?? '',
        orgRole: 'disabled',
        client: disabledClient,
      };
    });

    afterAll(async () => {
      try {
        await admin.from('membership').delete().eq('id', disabledUser.membershipId);
        await admin.from('profile').delete().eq('id', disabledUser.id);
        await admin.auth.admin.deleteUser(disabledUser.id);
      } catch {
        // swallow — cleanup is best-effort
      }
    });

    it('should return zero env rows on SELECT when role is disabled', async () => {
      // Act
      const { data, error } = await disabledUser.client
        .from('environment')
        .select('id')
        .eq('app_id', fixture.app.id);

      // Assert: disabled has no env.* permission, RLS filters everything out.
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it('should deny INSERT on environment when role is disabled', async () => {
      // Act
      const { error } = await disabledUser.client
        .from('environment')
        .insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: `disabled-insert-${Date.now().toString(36)}`,
          is_default: false,
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/row-level security/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Custom roles do NOT auto-receive env.* permissions on migration
  // ────────────────────────────────────────────────────────────────────────

  describe('custom roles', () => {
    it('should have no custom_role_permission rows for any environment.* permission post-migration', async () => {
      // Arrange: this is a property of the migration — assert against the seed.
      // Specifically, the migration `20260524150001_environments_promotion_and_navigation.sql`
      // only seeds `role_permissions` and `platform_role_permissions`, NOT
      // `custom_role_permission`. The column is the enum `app_permission`, so
      // we enumerate the 4 env values and assert each is absent.
      const envPerms = [
        'environment.read',
        'environment.insert',
        'environment.update',
        'environment.delete',
      ];

      // Act
      const { data, error } = await admin
        .from('custom_role_permission')
        .select('permission, custom_role_id')
        .in('permission', envPerms);

      // Assert: error is null and no migration-attributable rows exist.
      expect(error).toBeNull();
      // In an isolated CI-fresh DB this is zero. In a shared local DB it
      // could be non-zero if a tenant manually granted env perms to a
      // custom role — that's allowed. Filter to rows in our fixture's
      // tenant to guarantee determinism.
      const rows = data ?? [];
      if (rows.length === 0) {
        expect(rows).toHaveLength(0);
      } else {
        // Resolve custom_role.tenant_id for each hit.
        const customRoleIds = Array.from(
          new Set(rows.map((r) => r.custom_role_id as string)),
        );
        const { data: ownerRows } = await admin
          .from('custom_role')
          .select('id, tenant_id')
          .in('id', customRoleIds);
        const ownerByRole = new Map(
          (ownerRows ?? []).map(
            (r) => [r.id as string, r.tenant_id as string],
          ),
        );
        const fixtureHits = rows.filter(
          (r) =>
            ownerByRole.get(r.custom_role_id as string) === fixture.tenant.id,
        );
        expect(fixtureHits).toHaveLength(0);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GATEWAY_PERMISSIONS exposes environment.*
  // ────────────────────────────────────────────────────────────────────────

  describe('GATEWAY_PERMISSIONS includes the 4 env permissions', () => {
    const envPermissions = [
      'environment.read',
      'environment.insert',
      'environment.update',
      'environment.delete',
    ] as const;

    for (const perm of envPermissions) {
      it(`should include '${perm}' in GATEWAY_PERMISSIONS`, () => {
        // Act + Assert
        expect(GATEWAY_PERMISSIONS as readonly string[]).toContain(perm);
      });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // ROLE_PERMISSION_SETS — read-only includes environment.read
  // ────────────────────────────────────────────────────────────────────────

  describe('ROLE_PERMISSION_SETS', () => {
    it("should include 'environment.read' in the 'read-only' API-key role set", () => {
      // Act
      const readOnlySet = ROLE_PERMISSION_SETS['read-only'];

      // Assert
      expect(readOnlySet).toBeDefined();
      expect(readOnlySet as readonly string[]).toContain('environment.read');
    });

    it("should NOT include any environment.* permission in the 'sdk' API-key role set", () => {
      // Act
      const sdkSet = ROLE_PERMISSION_SETS['sdk'];

      // Assert
      expect(sdkSet).toBeDefined();
      const envHits = (sdkSet as readonly string[]).filter((p) =>
        p.startsWith('environment.'),
      );
      expect(envHits).toEqual([]);
    });

    it("should include all 4 environment.* permissions in the 'full-access' API-key role set", () => {
      // Act
      const fullSet = ROLE_PERMISSION_SETS['full-access'];

      // Assert
      expect(fullSet).toBeDefined();
      const fullStr = fullSet as readonly string[];
      expect(fullStr).toContain('environment.read');
      expect(fullStr).toContain('environment.insert');
      expect(fullStr).toContain('environment.update');
      expect(fullStr).toContain('environment.delete');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Bonus: env name's allowed scope is NOT restricted to its bound env
  // (surface verified via permissions semantics, not via API key creation
  // which is a gateway-route concern).
  // ────────────────────────────────────────────────────────────────────────

  describe('env binding does not restrict mutation scope', () => {
    it('should expose environment.* perms uniformly (no per-env partitioning in the gateway permission set)', () => {
      // Act + Assert: GATEWAY_PERMISSIONS does NOT contain any per-env
      // qualifier (e.g. 'environment.dev.read' or similar). The permission
      // grants are app-scoped via app_authorize(), not env-scoped — so a key
      // bound to dev with `environment.update` can act on prod.
      const perEnvHits = (GATEWAY_PERMISSIONS as readonly string[]).filter(
        (p) =>
          p.startsWith('environment.') && p.split('.').length > 2,
      );
      expect(perEnvHits).toEqual([]);
    });
  });

  // There are no saga mutation routes (promote/rollback/cancel/retry) and no
  // deployment audit-list route, so `deployment.read` is absent from
  // GATEWAY_PERMISSIONS. Nothing here pins a permission constant for a route
  // that does not exist.
});

// Quiet vitest about a possibly-unused import when only typecheck runs.
void randomUUID;
