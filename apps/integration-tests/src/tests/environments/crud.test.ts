/**
 * Integration tests for environment CRUD.
 *
 * Tests run against a real local Supabase instance.
 * Each test seeds its own rows and deletes them in the same block.
 *
 * Scope: `EnvironmentService` (createDefault, create, delete, list, get).
 * Gateway routes are out of scope — the route layer may not have landed yet;
 * we exercise service behavior directly with the admin client.
 */
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  setupEnvFixture,
  type EnvTestFixture,
} from './helpers';
import { EnvironmentService } from '@repo/environments-service';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Environment CRUD', () => {
  let fixture: EnvTestFixture;
  // The generated Database type hasn't been regenerated against this schema
  // yet (`yarn codegen:db` is a follow-up). Cast to a generic SupabaseClient
  // to bypass the typed table union — same pattern as EnvironmentService
  // itself (see private `client()` helper in
  // packages/environments-service/src/environment-service.ts).
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  beforeAll(async () => {
    fixture = await setupEnvFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Default env auto-created on app create
  // ────────────────────────────────────────────────────────────────────────

  describe('default env auto-creation', () => {
    it("should create default env named 'dev' with is_default=true when app is created", async () => {
      // Arrange: setupEnvFixture already created an app + called
      // EnvironmentService.createDefaultEnvironment. We just verify the row.

      // Act
      const { data, error } = await admin
        .from('environment')
        .select('*')
        .eq('app_id', fixture.app.id)
        .eq('is_default', true)
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.name).toBe('dev');
      expect(data!.is_default).toBe(true);
      expect(data!.current_version).toBe(0);
      expect(data!.fly_app_name).toBeNull();
    });

    it('should reject creating a second default env in the same app via UNIQUE partial index', async () => {
      // Arrange: fixture already has one default env. Attempt to insert another.

      // Act
      const { error } = await admin.from('environment').insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        name: 'second-default',
        is_default: true,
        fly_app_name: null,
        created_by: fixture.ownerUser.id,
      });

      // Assert: UNIQUE partial index `idx_environment_one_default_per_app`
      // blocks the second is_default=true row.
      expect(error).not.toBeNull();
      expect(error!.code).toBe('23505');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Non-default env create
  // ────────────────────────────────────────────────────────────────────────

  describe('createEnvironment', () => {
    it('should create non-default env in no-pin state when valid name is provided', async () => {
      // Arrange
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });

      // Act
      const result = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'staging',
        actorId: fixture.ownerUser.id,
      });

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.environment.name).toBe('staging');
      expect(result.environment.is_default).toBe(false);
      expect(result.environment.current_version).toBe(0);
      // An environment provisions nothing: no runtime is named, created, or
      // recorded. A non-null value here would mean the row is claiming
      // infrastructure that does not exist.
      expect(result.environment.fly_app_name).toBeNull();

      // Cleanup
      await admin.from('environment').delete().eq('id', result.environment.id);
    });

    // ──────────────────────────────────────────────────────────────────────
    // Env name pattern enforcement
    // ──────────────────────────────────────────────────────────────────────

    describe('rejects env names that do not match ^[a-z][a-z0-9-]{1,39}$', () => {
      const invalidNames: { name: string; reason: string }[] = [
        { name: '_bad', reason: 'leading underscore (must start with [a-z])' },
        { name: 'Bad', reason: 'uppercase letter' },
        { name: 'bad name', reason: 'whitespace' },
        { name: 'a', reason: 'too short (length < 2)' },
        { name: `a${'a'.repeat(40)}`, reason: 'too long (length > 40)' },
      ];

      for (const { name, reason } of invalidNames) {
        it(`should return env_name_invalid when name fails pattern (${reason})`, async () => {
          // Arrange
          const service = new EnvironmentService({
            supabase: admin as unknown as SupabaseClient,
          });

          // Act
          const result = await service.createEnvironment({
            tenantId: fixture.tenant.id,
            appId: fixture.app.id,
            name,
            actorId: fixture.ownerUser.id,
          });

          // Assert
          expect(result.ok).toBe(false);
          if (result.ok) throw new Error('unreachable');
          expect(result.code).toBe('env_name_invalid');
        });
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    // Unique (app_id, name)
    // ──────────────────────────────────────────────────────────────────────

    it('should return env_name_conflict when env name is duplicated within the same app', async () => {
      // Arrange: create the first env.
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });
      const first = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'qa',
        actorId: fixture.ownerUser.id,
      });
      expect(first.ok).toBe(true);

      // Act: try to create another env with the same name in the same app.
      const second = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'qa',
        actorId: fixture.ownerUser.id,
      });

      // Assert
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable');
      expect(second.code).toBe('env_name_conflict');

      // Cleanup
      if (first.ok) {
        await admin.from('environment').delete().eq('id', first.environment.id);
      }
    });

    it('should allow the same env name across two different apps in the same tenant', async () => {
      // Arrange: create a second app + its default env.
      const { data: secondApp, error: appError } = await admin
        .from('app')
        .insert({
          tenant_id: fixture.tenant.id,
          name: `second-app-${Date.now()}`,
          created_by: fixture.ownerUser.id,
        })
        .select('id, name')
        .single();
      if (appError || !secondApp) throw new Error(`second app: ${appError?.message}`);

      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });
      await service.createDefaultEnvironment({
        tenantId: fixture.tenant.id,
        appId: secondApp.id as string,
        actorId: fixture.ownerUser.id,
      });

      // Create `prod` in app 1.
      const inAppOne = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'prod',
        actorId: fixture.ownerUser.id,
      });
      expect(inAppOne.ok).toBe(true);

      // Act: create `prod` in app 2.
      const inAppTwo = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: secondApp.id as string,
        name: 'prod',
        actorId: fixture.ownerUser.id,
      });

      // Assert: both succeed.
      expect(inAppTwo.ok).toBe(true);

      // Cleanup
      if (inAppOne.ok) await admin.from('environment').delete().eq('id', inAppOne.environment.id);
      if (inAppTwo.ok) await admin.from('environment').delete().eq('id', inAppTwo.environment.id);
      await admin.from('environment').delete().eq('app_id', secondApp.id);
      await admin.from('app').delete().eq('id', secondApp.id);
    });

    // ──────────────────────────────────────────────────────────────────────
    // Api_key not auto-minted on env create
    // ──────────────────────────────────────────────────────────────────────

    it('should not auto-mint an api_key when a new env is created', async () => {
      // Arrange
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });
      const created = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'release',
        actorId: fixture.ownerUser.id,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('unreachable');

      // Act
      const { data: keys, error } = await admin
        .from('api_key')
        .select('id')
        .eq('environment_id', created.environment.id);

      // Assert: no api_key rows for the new env.
      expect(error).toBeNull();
      expect(keys ?? []).toHaveLength(0);

      // Cleanup
      await admin.from('environment').delete().eq('id', created.environment.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Env rename is forbidden
  // ────────────────────────────────────────────────────────────────────────

  describe('immutability', () => {
    it('should raise an exception when env name is updated', async () => {
      // Arrange: create a non-default env directly.
      const { data: env, error: insertError } = await admin
        .from('environment')
        .insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: 'rename-target',
          is_default: false,
          fly_app_name: 'rename-target-fly',
          created_by: fixture.ownerUser.id,
        })
        .select('id, name')
        .single();
      if (insertError || !env) throw new Error(`seed: ${insertError?.message}`);

      // Act: attempt to rename via service-role admin (the trigger is
      // unconditional — fires for service_role + authenticated alike).
      const { error: updateError } = await admin
        .from('environment')
        .update({ name: 'renamed' })
        .eq('id', env.id);

      // Assert: trigger raises an exception.
      expect(updateError).not.toBeNull();
      expect(updateError!.message).toMatch(/immutable/i);

      // Cleanup
      await admin.from('environment').delete().eq('id', env.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Delete behaviors
  // ────────────────────────────────────────────────────────────────────────

  describe('deleteEnvironment', () => {
    it('should return env_default_cannot_delete when attempting to delete the default env', async () => {
      // Arrange
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });

      // Act
      const result = await service.deleteEnvironment({
        tenantId: fixture.tenant.id,
        envId: fixture.defaultEnv.id,
        confirmationName: fixture.defaultEnv.name,
        actorId: fixture.ownerUser.id,
      });

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe('env_default_cannot_delete');

      // Verify the env row still exists.
      const { data: row } = await admin
        .from('environment')
        .select('id')
        .eq('id', fixture.defaultEnv.id)
        .single();
      expect(row).not.toBeNull();
    });

    it('should return env_confirmation_mismatch when confirmation name does not match', async () => {
      // Arrange: seed an env to delete.
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });
      const created = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'mismatch',
        actorId: fixture.ownerUser.id,
      });
      if (!created.ok) throw new Error('seed failed');

      // Act
      const result = await service.deleteEnvironment({
        tenantId: fixture.tenant.id,
        envId: created.environment.id,
        confirmationName: 'wrong-name',
        actorId: fixture.ownerUser.id,
      });

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe('env_confirmation_mismatch');

      // Verify the env still exists.
      const { data: row } = await admin
        .from('environment')
        .select('id')
        .eq('id', created.environment.id)
        .single();
      expect(row).not.toBeNull();

      // Cleanup
      await admin.from('environment').delete().eq('id', created.environment.id);
    });

    it('should delete a non-default env when confirmation name matches', async () => {
      // Arrange
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });
      const created = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'delete-me',
        actorId: fixture.ownerUser.id,
      });
      if (!created.ok) throw new Error('seed failed');

      // Act
      const result = await service.deleteEnvironment({
        tenantId: fixture.tenant.id,
        envId: created.environment.id,
        confirmationName: 'delete-me',
        actorId: fixture.ownerUser.id,
      });

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.cascade.fly_app_destroyed).toBe(false);

      // Verify the env row is gone.
      const { data: row } = await admin
        .from('environment')
        .select('id')
        .eq('id', created.environment.id)
        .maybeSingle();
      expect(row).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Entitlement limit (service layer does NOT enforce; documented gap)
  //
  // The current EnvironmentService does not call EntitlementService — the
  // entitlement check lives at the gateway route layer. When that
  // route ships, this test should target it. For now we verify the
  // entitlement service surface that the route is expected to consume.
  // ────────────────────────────────────────────────────────────────────────

  describe('entitlement limit (gateway-layer concern, surface verified here)', () => {
    it('should report not-allowed via EntitlementService.checkLimit when override of 1 is set and 1 env exists', async () => {
      // Arrange: seed a billing row + an override that caps max_environments_per_app to 1.
      const { error: billingError } = await admin
        .from('billing')
        .upsert(
          {
            tenant_id: fixture.tenant.id,
            stripe_customer_id: `cus_test_${fixture.tenant.id}`,
            tier_id: 'hobby',
            created_by: fixture.ownerUser.id,
          },
          { onConflict: 'tenant_id' },
        );
      if (billingError) throw new Error(`billing: ${billingError.message}`);

      const { error: overrideError } = await admin
        .from('tenant_entitlement_override')
        .upsert(
          {
            tenant_id: fixture.tenant.id,
            entitlement_key: 'max_environments_per_app',
            value: { v: 1 },
            override_reason: 'integration test cap',
            created_by: fixture.ownerUser.id,
          },
          { onConflict: 'tenant_id,entitlement_key' },
        );
      if (overrideError) throw new Error(`override: ${overrideError.message}`);

      // Dynamic import to avoid load-time circular deps in vitest.
      const { EntitlementService } = await import(
        'tenant-dashboard/src/lib/system/entitlement-service'
      );
      const ent = new EntitlementService({
        db: admin as unknown as SupabaseClient,
      });
      const limit = await ent.getLimit(
        fixture.tenant.id,
        'max_environments_per_app',
      );

      // Count existing envs in the fixture's app.
      const { count } = await admin
        .from('environment')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', fixture.app.id);

      // Act
      const check = await ent.checkLimit(
        fixture.tenant.id,
        'max_environments_per_app',
        count ?? 0,
      );

      // Assert: override is 1, default env already exists (count ≥ 1), so
      // creating one more is not allowed.
      expect(limit).toBe(1);
      expect(check.allowed).toBe(false);

      // Cleanup
      await admin
        .from('tenant_entitlement_override')
        .delete()
        .eq('tenant_id', fixture.tenant.id)
        .eq('entitlement_key', 'max_environments_per_app');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Epoch differs when a name is reused after delete
  // ────────────────────────────────────────────────────────────────────────

  describe('epoch on recreate', () => {
    it('should assign a different epoch when an env with a previously-used name is recreated', async () => {
      // Arrange: create + delete + recreate the same name.
      const service = new EnvironmentService({
        supabase: admin as unknown as SupabaseClient,
      });
      const first = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'reused-name',
        actorId: fixture.ownerUser.id,
      });
      if (!first.ok) throw new Error('first create failed');
      const firstEpoch = first.environment.epoch;

      const del = await service.deleteEnvironment({
        tenantId: fixture.tenant.id,
        envId: first.environment.id,
        confirmationName: 'reused-name',
        actorId: fixture.ownerUser.id,
      });
      expect(del.ok).toBe(true);

      // Wait a millisecond to guarantee the millisecond-resolution epoch
      // (extract(epoch) * 1000) advances at least by 1.
      await new Promise((r) => setTimeout(r, 5));

      // Act
      const second = await service.createEnvironment({
        tenantId: fixture.tenant.id,
        appId: fixture.app.id,
        name: 'reused-name',
        actorId: fixture.ownerUser.id,
      });

      // Assert
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('unreachable');
      expect(second.environment.epoch).not.toBe(firstEpoch);
      expect(Number(second.environment.epoch)).toBeGreaterThan(Number(firstEpoch));

      // Cleanup
      await admin.from('environment').delete().eq('id', second.environment.id);
    });
  });

});
