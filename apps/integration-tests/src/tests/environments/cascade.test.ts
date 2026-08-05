/**
 * Integration tests for environment-delete cascade behavior.
 *
 * Tests run against a real local Supabase instance —
 * the only mock is the Fly client (Fly API costs + latency). The point of
 * these tests is to verify the FK cascade rules are correctly wired in the
 * schema: an env delete must CASCADE child rows that have no meaning past the
 * env's lifetime, and SET NULL on audit rows that must survive the env.
 *
 * Each test covers one behavior, seeding its own rows and deleting them in the
 * same block.
 */
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  setupEnvFixture,
  seedPinnedEnvironment,
  type EnvTestFixture,
} from './helpers';
import { EnvironmentService } from '@repo/environments-service';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Environment delete cascade', () => {
  // The generated Database type hasn't been regenerated against this schema
  // yet — cast to a generic client, the same pattern as crud.test.ts.
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  // ──────────────────────────────────────────────────────────────────────────
  // Local seeder. INSERTs a child row for an env so the cascade can be
  // observed. It lives here (not helpers.ts) because no other test file in
  // the suite needs api-key seeding.
  // ──────────────────────────────────────────────────────────────────────────

  async function seedApiKey(
    fixture: EnvTestFixture,
    envId: string,
  ): Promise<string> {
    const apiKeyId = `ak_cascade_${randomUUID()}`;
    const { data, error } = await admin
      .from('api_key')
      .insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        environment_id: envId,
        name: 'cascade-test-key',
        api_key_id: apiKeyId,
        created_by: fixture.ownerUser.id,
      })
      .select('id')
      .single();
    if (error || !data) {
      throw new Error(`seedApiKey failed: ${error?.message}`);
    }
    return data.id as string;
  }

  function envService(): EnvironmentService {
    return new EnvironmentService({
      supabase: admin,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Env delete CASCADEs api_key rows in the same transaction
  // ──────────────────────────────────────────────────────────────────────────

  describe('CASCADE: api_key', () => {
    it('should delete api_key rows bound to the env when the env is deleted', async () => {
      const fixture = await setupEnvFixture();
      try {
        const env = await seedPinnedEnvironment(fixture, {
          name: 'casc-key',
          version: 1,
          commitSha: 'b'.repeat(40),
        });
        const keyId = await seedApiKey(fixture, env.id);

        await envService().deleteEnvironment({
          tenantId: fixture.tenant.id,
          envId: env.id,
          confirmationName: env.name,
          actorId: fixture.ownerUser.id,
        });

        const { data } = await admin
          .from('api_key')
          .select('id')
          .eq('id', keyId);
        expect(data).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });
  });


  // ──────────────────────────────────────────────────────────────────────────
  // A legacy fly_app_name is inert — it names no live resource.
  // ──────────────────────────────────────────────────────────────────────────

  describe('legacy fly_app_name', () => {
    it('deletes an env carrying a fly_app_name without reporting a runtime teardown', async () => {
      const fixture = await setupEnvFixture();
      try {
        // Rows predating the runtime removal still carry a name. Deleting one
        // must be an ordinary database delete: nothing external is contacted,
        // so nothing can fail there and nothing is reported as destroyed.
        const env = await seedPinnedEnvironment(fixture, {
          name: 'casc-fly',
          version: 1,
          commitSha: '4'.repeat(40),
          flyAppName: 'casc-fly-app',
        });

        const result = await envService().deleteEnvironment({
          tenantId: fixture.tenant.id,
          envId: env.id,
          confirmationName: env.name,
          actorId: fixture.ownerUser.id,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');
        expect(result.cascade.fly_app_destroyed).toBe(false);

        const { data: row } = await admin
          .from('environment')
          .select('id')
          .eq('id', env.id)
          .maybeSingle();
        expect(row).toBeNull();
      } finally {
        await fixture.cleanup();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Base CASCADE: app delete removes all of its envs.
  // ──────────────────────────────────────────────────────────────────────────

  describe('CASCADE: app delete removes all envs', () => {
    it('should delete every environment of an app when the app row is deleted', async () => {
      const fixture = await setupEnvFixture();
      try {
        // The fixture's default env + one extra env.
        await seedPinnedEnvironment(fixture, {
          name: 'casc-appdel',
          version: 1,
          commitSha: '5'.repeat(40),
        });
        const before = await admin
          .from('environment')
          .select('id', { count: 'exact', head: true })
          .eq('app_id', fixture.app.id);
        expect(before.count).toBe(2);

        // Act: delete the app row directly. The default-env delete trigger
        // only fires on `environment` deletes, not on cascades from a parent
        // table, so app delete cascades cleanly.
        await admin.from('app').delete().eq('id', fixture.app.id);

        // Assert
        const after = await admin
          .from('environment')
          .select('id', { count: 'exact', head: true })
          .eq('app_id', fixture.app.id);
        expect(after.count).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Base CASCADE: tenant delete removes all envs across all apps.
  // ──────────────────────────────────────────────────────────────────────────

  describe('CASCADE: tenant delete removes all envs', () => {
    it('should delete every environment across all apps when the tenant is deleted', async () => {
      const fixture = await setupEnvFixture();
      let tenantDeleted = false;
      try {
        await seedPinnedEnvironment(fixture, {
          name: 'casc-tendel',
          version: 1,
          commitSha: '6'.repeat(40),
        });

        // Act: delete child rows that block the tenant FK, then the tenant.
        // (membership/profile cleanup matches the fixture's own teardown.)
        await admin.from('api_key').delete().eq('tenant_id', fixture.tenant.id);
        await admin
          .from('membership')
          .delete()
          .eq('tenant_id', fixture.tenant.id);
        await admin.from('app').delete().eq('tenant_id', fixture.tenant.id);
        await admin.from('tenant').delete().eq('tenant_id', fixture.tenant.id);
        tenantDeleted = true;

        // Assert: no env rows remain for the tenant.
        const after = await admin
          .from('environment')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', fixture.tenant.id);
        expect(after.count).toBe(0);
      } finally {
        if (tenantDeleted) {
          // Tenant + apps already gone; only auth users remain.
          for (const u of [
            fixture.ownerUser,
            fixture.writerUser,
            fixture.readerUser,
          ]) {
            await admin.from('profile').delete().eq('id', u.id);
            await admin.auth.admin.deleteUser(u.id);
          }
        } else {
          await fixture.cleanup();
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Recreating an env with a previously-used name yields a distinct epoch —
  // so promotion_history rows from each lifetime are distinguishable even
  // after the SET NULL severs environment_id.
  // ──────────────────────────────────────────────────────────────────────────

  describe('recreate with previously-used name has distinct epoch', () => {
    it('should assign a different epoch to a recreated env with the same name as a deleted env', async () => {
      const fixture = await setupEnvFixture();
      try {
        const service = envService();

        // Create + delete the first incarnation.
        const first = await service.createEnvironment({
          tenantId: fixture.tenant.id,
          appId: fixture.app.id,
          name: 'reuse-epoch',
          actorId: fixture.ownerUser.id,
        });
        expect(first.ok).toBe(true);
        if (first.ok !== true) return;
        const firstEpoch = first.environment.epoch;

        await service.deleteEnvironment({
          tenantId: fixture.tenant.id,
          envId: first.environment.id,
          confirmationName: 'reuse-epoch',
          actorId: fixture.ownerUser.id,
        });

        // The epoch is millisecond-resolution; guarantee it advances.
        await new Promise((r) => setTimeout(r, 5));

        // Recreate with the same name.
        const second = await service.createEnvironment({
          tenantId: fixture.tenant.id,
          appId: fixture.app.id,
          name: 'reuse-epoch',
          actorId: fixture.ownerUser.id,
        });
        expect(second.ok).toBe(true);
        if (second.ok !== true) return;

        // Assert: distinct epochs distinguish the two incarnations.
        expect(second.environment.epoch).not.toBe(firstEpoch);
        expect(Number(second.environment.epoch)).toBeGreaterThan(
          Number(firstEpoch),
        );
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
