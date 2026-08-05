/**
 * Integration tests for the `environment` table's RLS posture.
 *
 * This file covers `environment` RLS and platform-admin cross-tenant
 * read/write-denial. It does not cover the `deployment` table's RLS
 * posture (saga-row append-only, terminal immutability, cross-tenant/
 * platform-admin saga reads, the self-FK ON-DELETE-SET-NULL columns) —
 * that table and its saga machinery do not exist.
 *
 * Every assertion here runs against a REAL local Supabase instance through a
 * REAL user-context client (anon key + signed-in JWT) — so the `environment`
 * RLS policies are exercised exactly as production enforces them. This is the
 * only way to catch a broken policy; a mocked client would pass regardless.
 *
 * RLS semantics this file relies on:
 *   - SELECT under a denying policy returns 0 rows + null error (silent filter).
 *   - INSERT under a denying policy returns a `row-level security` error.
 *   - UPDATE/DELETE under a denying policy returns 0 affected rows + null error
 *     (Postgres applies the USING clause as a filter, so the statement simply
 *     matches nothing). These tests therefore verify the row is UNCHANGED
 *     rather than expecting an error — the documented pattern in
 *     `custom-roles` and `app-level-roles` integration suites.
 *
 * Test data is inlined in each test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  setupEnvFixture,
  seedPinnedEnvironment,
  type EnvTestFixture,
} from './helpers';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

describe('Environment table RLS', () => {
  // Two independent fixtures (tenants A + B) — cross-tenant tests need a
  // second tenant whose rows tenant A's users must NOT be able to read.
  let fixtureA: EnvTestFixture;
  let fixtureB: EnvTestFixture;
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  beforeAll(async () => {
    fixtureA = await setupEnvFixture();
    fixtureB = await setupEnvFixture();
  });

  afterAll(async () => {
    await fixtureA.cleanup();
    await fixtureB.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Environment.read gates SELECT on `environment`
  // ───────────────────────────────────────────────────────────────────────

  describe('environment SELECT requires environment.read', () => {
    it('should return zero environment rows for a user whose role lacks environment.read', async () => {
      // Arrange: create a `disabled`-role user in tenant A. The `disabled`
      // role is granted nothing, so it has no environment.read.
      const rid = Math.random().toString(36).slice(2, 8);
      const email = `rls-disabled-${Date.now()}-${rid}@test-envs.com`;
      const password = 'TestPassword123!';
      const { data: authData, error: authErr } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
      if (authErr || !authData?.user) {
        throw new Error(`disabled user: ${authErr?.message}`);
      }
      const userId = authData.user.id;
      await admin.from('profile').insert({ id: userId, name: 'rls disabled', email });
      const { data: membership } = await admin
        .from('membership')
        .insert({
          user_id: userId,
          tenant_id: fixtureA.tenant.id,
          role: 'disabled',
          status: 'active',
        })
        .select('id')
        .single();
      await admin.rpc('set_claim', {
        claim: 'tenant_id',
        uid: userId,
        value: fixtureA.tenant.id,
      });
      await admin.rpc('set_claim', { claim: 'role', uid: userId, value: 'disabled' });
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      await client.auth.signInWithPassword({ email, password });
      await client.auth.refreshSession();

      // Act: the disabled user reads environments in tenant A's app.
      const { data, error } = await client
        .from('environment')
        .select('id')
        .eq('app_id', fixtureA.app.id);

      // Assert: RLS filters every row out — the user has no environment.read.
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);

      // Cleanup
      await admin.from('membership').delete().eq('id', membership!.id);
      await admin.from('profile').delete().eq('id', userId);
      await admin.auth.admin.deleteUser(userId);
    });

    it('should return zero environment rows when a user with environment.read queries a different tenant', async () => {
      // Arrange: tenant A's owner HAS environment.read — but only for tenant A.
      // Tenant scoping (`public.tenant_id() = tenant_id`) must block reads of
      // tenant B's env rows even though the permission is held.

      // Act: tenant A's owner reads environments in tenant B's app.
      const { data, error } = await fixtureA.ownerUser.client
        .from('environment')
        .select('id')
        .eq('app_id', fixtureB.app.id);

      // Assert: zero rows — the tenant_id filter in the policy denies it.
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    });
  });
  // ───────────────────────────────────────────────────────────────────────
  // Platform admin reads cross-tenant but cannot mutate
  // ───────────────────────────────────────────────────────────────────────

  describe('platform admin RLS', () => {
    let platformUserId: string;
    let platformClient: SupabaseClient;

    beforeAll(async () => {
      // A platform admin user. The `platform_user_role` row must exist BEFORE
      // sign-in — `custom_access_token_hook` reads it and writes the
      // `platform_role` JWT claim that `platform_authorize()` checks.
      const rid = Math.random().toString(36).slice(2, 8);
      const email = `rls-platform-${Date.now()}-${rid}@outerlayer.ai`;
      const password = 'TestPassword123!';
      const { data: authData, error: authErr } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
      if (authErr || !authData?.user) {
        throw new Error(`platform user: ${authErr?.message}`);
      }
      platformUserId = authData.user.id;
      await admin
        .from('profile')
        .insert({ id: platformUserId, name: 'rls platform', email });
      await admin.from('platform_user_role').insert({
        user_id: platformUserId,
        role: 'platform_admin',
        created_by: platformUserId,
      });

      platformClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      await platformClient.auth.signInWithPassword({ email, password });
      await platformClient.auth.refreshSession();
    });

    afterAll(async () => {
      await admin
        .from('platform_user_role')
        .delete()
        .eq('user_id', platformUserId);
      await admin.from('profile').delete().eq('id', platformUserId);
      await admin.auth.admin.deleteUser(platformUserId);
    });

    it('should let a platform admin SELECT environment rows across multiple tenants', async () => {
      // Arrange: fixtures A and B belong to two distinct tenants. The
      // platform admin belongs to neither — its cross-tenant read comes
      // solely from the `platform.environment.read` permission.

      // Act
      const { data: envsA, error: errA } = await platformClient
        .from('environment')
        .select('id, tenant_id')
        .eq('app_id', fixtureA.app.id);
      const { data: envsB, error: errB } = await platformClient
        .from('environment')
        .select('id, tenant_id')
        .eq('app_id', fixtureB.app.id);

      // Assert: the platform admin sees env rows in BOTH tenants.
      expect(errA).toBeNull();
      expect(errB).toBeNull();
      expect((envsA ?? []).length).toBeGreaterThanOrEqual(1);
      expect((envsB ?? []).length).toBeGreaterThanOrEqual(1);
    });

    it('should deny a platform admin a direct INSERT into environment (read-only access)', async () => {
      // Arrange: platform.environment.read grants SELECT only — there is no
      // platform INSERT policy on `environment`.

      // Act
      const { error } = await platformClient.from('environment').insert({
        tenant_id: fixtureA.tenant.id,
        app_id: fixtureA.app.id,
        name: 'plat-forged',
        is_default: false,
        created_by: platformUserId,
      });

      // Assert: RLS rejects the write — platform admins cannot mutate env CRUD.
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/row-level security/i);
    });

    it('should leave an environment row unchanged when a platform admin attempts a direct UPDATE', async () => {
      // Arrange: a pinned env in tenant A. `name` is immutable anyway, so
      // mutate a different column (`fly_app_name`) to isolate the RLS
      // denial from the immutability trigger.
      const env = await seedPinnedEnvironment(fixtureA, {
        name: 'plat-update',
        version: 1,
        commitSha: 'commit-plat-update',
      });
      // Capture the seeded fly_app_name so we can assert it is unchanged.
      const originalFlyAppName = (env as unknown as { fly_app_name: string | null }).fly_app_name;

      // Act: the platform admin attempts to repoint the fly_app_name. No platform
      // UPDATE policy → the statement matches zero rows.
      await platformClient
        .from('environment')
        .update({ fly_app_name: 'platform-tampered' })
        .eq('id', env.id);

      // Assert: the env is untouched — fly_app_name still holds the value
      // set by seedPinnedEnvironment, not the tampered value.
      const { data: after } = await admin
        .from('environment')
        .select('fly_app_name')
        .eq('id', env.id)
        .single();
      expect(after!.fly_app_name).toBe(originalFlyAppName);

      // Cleanup
      await admin.from('environment').delete().eq('id', env.id);
    });

    it('should leave an environment row in place when a platform admin attempts a direct DELETE', async () => {
      // Arrange
      const env = await seedPinnedEnvironment(fixtureA, {
        name: 'plat-delete',
        version: 1,
        commitSha: 'commit-plat-delete',
      });

      // Act: no platform DELETE policy → matches zero rows.
      await platformClient.from('environment').delete().eq('id', env.id);

      // Assert: the env survives.
      const { data: after } = await admin
        .from('environment')
        .select('id')
        .eq('id', env.id)
        .maybeSingle();
      expect(after).not.toBeNull();

      // Cleanup
      await admin.from('environment').delete().eq('id', env.id);
    });
  });
});
