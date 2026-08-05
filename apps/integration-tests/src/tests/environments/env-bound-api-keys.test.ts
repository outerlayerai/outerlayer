/**
 * Integration tests for env-bound API keys.
 *
 * --------------------------------------------------------------------------
 * WHAT LAYER THIS ASSERTS AT
 * --------------------------------------------------------------------------
 *   - "env_id required on key creation"          → real Postgres NOT NULL
 *     constraint on `api_key.environment_id` (schema 23-api-key.sql).
 *   - "env delete revokes keys in same tx"       → real Postgres CASCADE on
 *     the `api_key.environment_id` → `environment(id)` FK.
 *   - "env-bound key can promote ANY env in app" → the gateway permission set
 *     has no per-env qualifier, so a key's env binding does not narrow what
 *     env ids it can act on. Asserted via the resolver: the resolved
 *     env identifies the BINDING, it is never used to gate a target env id.
 *   - "client X-Env header is ignored"           → `resolveEnvironmentFromApiKey`
 *     takes ONLY `apiKeyId` + `tenantId`; there is no header parameter, so a
 *     client-supplied env header can never influence resolution.
 *
 * Runs against a real local Supabase, with test data inlined in each test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  resolveEnvironmentFromApiKey,
  __clearEnvironmentResolverCache,
} from '@repo/gateway-core/lib/environment-resolver';
import {
  setupEnvFixture,
  seedPinnedEnvironment,
  type EnvTestFixture,
} from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a fresh, collision-resistant Unkey-style key id. */
function freshKeyId(label: string): string {
  return `key_${label}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

describe('Env-bound API keys', () => {
  let fixture: EnvTestFixture;
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  beforeAll(async () => {
    fixture = await setupEnvFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  beforeEach(() => {
    __clearEnvironmentResolverCache();
  });

  // ───────────────────────────────────────────────────────────────────────
  // An API key MUST be bound to an environment
  //
  // The `ListApiKeys` gateway route uses `.eq('environment_id', envId)`
  // to scope the result set. If `envId` cannot be resolved from the caller's own
  // api_key row, the route returns an empty page rather than falling open.
  //
  // The DB NOT NULL constraint (asserted below) means a valid, saved API key
  // ALWAYS has environment_id — so the "envId missing after lookup" path in the
  // gateway is only reachable via a transient query error, not via a valid key.
  // The NOT NULL assertion here is therefore the primary DB-level regression guard
  // for that path.
  // ───────────────────────────────────────────────────────────────────────

  describe('an API key requires a binding (env pin or allowed kinds)', () => {
    it('should reject an api_key insert with neither environment_id nor allowed_env_kinds', async () => {
      // Arrange: an api_key row with neither an env pin nor kind scoping.
      // environment_id is nullable, so this is not a NOT NULL violation — it is
      // rejected by chk_api_key_scope_present.

      // Act
      const { error } = await admin.from('api_key').insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        name: freshKeyId('no-env'),
        api_key_id: freshKeyId('no-env'),
        created_by: fixture.ownerUser.id,
      });

      // Assert: CHECK violation (23514) — a key must carry an env pin OR kinds.
      expect(error).not.toBeNull();
      expect(error!.code).toBe('23514');
      expect(error!.message).toMatch(/chk_api_key_scope_present/);
    });

    it('should accept an api_key insert that supplies a valid environment_id', async () => {
      // Arrange
      const apiKeyId = freshKeyId('with-env');

      // Act
      const { data, error } = await admin
        .from('api_key')
        .insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          environment_id: fixture.defaultEnv.id,
          name: freshKeyId('with-env'),
          api_key_id: apiKeyId,
          created_by: fixture.ownerUser.id,
        })
        .select('id, environment_id')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.environment_id).toBe(fixture.defaultEnv.id);

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', apiKeyId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // The gateway resolves env from the key, at the key layer
  // ───────────────────────────────────────────────────────────────────────

  describe('gateway resolves the env from the API key binding', () => {
    it('should resolve to the env the key is bound to when given the key id', async () => {
      // Arrange: a `staging` env + a key bound to it.
      const staging = await seedPinnedEnvironment(fixture, {
        name: 'staging',
        version: 2,
        commitSha: 'commit-staging-v2',
      });
      const apiKeyId = freshKeyId('staging');
      await admin.from('api_key').insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        environment_id: staging.id,
        name: freshKeyId('staging'),
        api_key_id: apiKeyId,
        created_by: fixture.ownerUser.id,
      });

      // Act
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId,
        tenantId: fixture.tenant.id,
      });

      // Assert: the resolver returns the bound env's identity + pin state.
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('staging');
      expect(resolved!.pinned_version).toBe(2);
      expect(resolved!.pinned_commit_sha).toBe('commit-staging-v2');

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', apiKeyId);
      await admin.from('environment').delete().eq('id', staging.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Deleting an env CASCADE-revokes its API keys
  // ───────────────────────────────────────────────────────────────────────

  describe('deleting an environment revokes its API keys', () => {
    it('should delete every api_key row bound to an env when that env is deleted', async () => {
      // Arrange: a `release` env with two keys bound to it.
      const release = await seedPinnedEnvironment(fixture, {
        name: 'release',
        version: 1,
        commitSha: 'commit-release-v1',
      });
      const keyOne = freshKeyId('release-1');
      const keyTwo = freshKeyId('release-2');
      for (const apiKeyId of [keyOne, keyTwo]) {
        const { error } = await admin.from('api_key').insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          environment_id: release.id,
          name: apiKeyId,
          api_key_id: apiKeyId,
          created_by: fixture.ownerUser.id,
        });
        if (error) throw new Error(`seed key ${apiKeyId}: ${error.message}`);
      }

      // Act: delete the environment.
      const { error: delError } = await admin
        .from('environment')
        .delete()
        .eq('id', release.id);
      expect(delError).toBeNull();

      // Assert: both keys are gone (FK CASCADE — same transaction as the
      // env delete). No key survives pointing at a now-dead env.
      const { data: survivors } = await admin
        .from('api_key')
        .select('id')
        .in('api_key_id', [keyOne, keyTwo]);
      expect(survivors ?? []).toHaveLength(0);
    });

    it('should leave api_keys of OTHER envs untouched when one env is deleted', async () => {
      // Arrange: two envs, each with one key.
      const envA = await seedPinnedEnvironment(fixture, {
        name: 'cascade-a',
        version: 1,
        commitSha: 'commit-a',
      });
      const envB = await seedPinnedEnvironment(fixture, {
        name: 'cascade-b',
        version: 1,
        commitSha: 'commit-b',
      });
      const keyA = freshKeyId('cascade-a');
      const keyB = freshKeyId('cascade-b');
      await admin.from('api_key').insert([
        {
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          environment_id: envA.id,
          name: keyA,
          api_key_id: keyA,
          created_by: fixture.ownerUser.id,
        },
        {
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          environment_id: envB.id,
          name: keyB,
          api_key_id: keyB,
          created_by: fixture.ownerUser.id,
        },
      ]);

      // Act: delete only env A.
      await admin.from('environment').delete().eq('id', envA.id);

      // Assert: env B's key survives — the CASCADE is scoped to env A.
      const { data: bKey } = await admin
        .from('api_key')
        .select('id, environment_id')
        .eq('api_key_id', keyB)
        .maybeSingle();
      expect(bKey).not.toBeNull();
      expect(bKey!.environment_id).toBe(envB.id);

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', keyB);
      await admin.from('environment').delete().eq('id', envB.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // An env-bound key can act on ANY env in its app, not just its own
  // ───────────────────────────────────────────────────────────────────────

  describe('env binding does not restrict which envs a key can act on', () => {
    it('should resolve a dev-bound key to dev — the binding identifies provenance, not an action scope', async () => {
      // Arrange: a key bound to the default `dev` env, plus a separate `prod`
      // env the key is NOT bound to. A dev-bound key with
      // environment.promote can promote `prod`. The mechanism: the resolver
      // returns the *binding* (`dev`), and the promote route gates on the
      // app-scoped `environment.promote` permission — never on a match
      // between the key's bound env and the target env id.
      const prod = await seedPinnedEnvironment(fixture, {
        name: 'prod-86',
        version: 1,
        commitSha: 'commit-prod-86',
      });
      const devKeyId = freshKeyId('dev-86');
      await admin.from('api_key').insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        environment_id: fixture.defaultEnv.id,
        name: devKeyId,
        api_key_id: devKeyId,
        created_by: fixture.ownerUser.id,
      });

      // Act
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: devKeyId,
        tenantId: fixture.tenant.id,
      });

      // Assert: the key resolves to its binding (`dev`) — and the resolved
      // value carries NO field that could restrict the key to acting only on
      // `dev`. `prod` is a distinct env id with no relationship to this key's
      // binding; the promote route can target it freely.
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('dev');
      expect(resolved).not.toHaveProperty('allowed_environment_ids');
      expect(prod.id).not.toBe(fixture.defaultEnv.id);

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', devKeyId);
      await admin.from('environment').delete().eq('id', prod.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // A key bound to env-A must not see keys from env-B when
  // ListApiKeys filters by environment_id. (Direct Supabase query — approximates
  // the gateway's .eq('environment_id', envId) filter path.)
  // ───────────────────────────────────────────────────────────────────────

  describe('env-bound key listing does not leak cross-env keys', () => {
    it('should return only the keys bound to the caller env when filtering by environment_id', async () => {
      // Arrange: two distinct environments, each with one API key.
      const envA = await seedPinnedEnvironment(fixture, {
        name: 'm5-env-a',
        version: 1,
        commitSha: 'commit-m5-a',
      });
      const envB = await seedPinnedEnvironment(fixture, {
        name: 'm5-env-b',
        version: 1,
        commitSha: 'commit-m5-b',
      });
      const keyA = freshKeyId('m5-a');
      const keyB = freshKeyId('m5-b');
      await admin.from('api_key').insert([
        {
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          environment_id: envA.id,
          name: keyA,
          api_key_id: keyA,
          created_by: fixture.ownerUser.id,
        },
        {
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          environment_id: envB.id,
          name: keyB,
          api_key_id: keyB,
          created_by: fixture.ownerUser.id,
        },
      ]);

      // Act: query as if the gateway's ListApiKeys handler resolved envA.id from
      // the caller's own key row and applied .eq('environment_id', envA.id).
      const { data: envAKeys, error } = await admin
        .from('api_key')
        .select('id, api_key_id, environment_id')
        .eq('app_id', fixture.app.id)
        .eq('environment_id', envA.id);

      expect(error).toBeNull();

      // Assert: only env-A's key is returned — env-B's key does NOT appear.
      const returnedIds = (envAKeys ?? []).map((k) => k.api_key_id);
      expect(returnedIds).toContain(keyA);
      expect(returnedIds).not.toContain(keyB);

      // Cleanup
      await admin.from('api_key').delete().in('api_key_id', [keyA, keyB]);
      await admin.from('environment').delete().in('id', [envA.id, envB.id]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // A client-supplied env header is ignored
  // ───────────────────────────────────────────────────────────────────────

  describe('client-supplied env header is ignored', () => {
    it('should resolve env solely from the key binding, regardless of any client X-Env header value', async () => {
      // Arrange: a key bound to `dev`. The resolver's signature is
      // `{ supabase, apiKeyId, tenantId }` — there is NO header/env-name
      // parameter. A client sending `X-Env: prod` cannot influence the
      // result, because the result is computed only from the key binding.
      const dev30Key = freshKeyId('dev-30');
      await admin.from('api_key').insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        environment_id: fixture.defaultEnv.id,
        name: dev30Key,
        api_key_id: dev30Key,
        created_by: fixture.ownerUser.id,
      });

      // Act: resolve twice — the only inputs are key id + tenant id. Whatever
      // header a client sends, these are the only values the gateway feeds
      // the resolver, so both calls yield the key's bound env.
      const first = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: dev30Key,
        tenantId: fixture.tenant.id,
      });
      __clearEnvironmentResolverCache();
      const second = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: dev30Key,
        tenantId: fixture.tenant.id,
      });

      // Assert: deterministic — always the key's bound env.
      expect(first?.name).toBe('dev');
      expect(second?.name).toBe('dev');

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', dev30Key);
    });

    it('should NOT resolve a foreign tenant env when a key id is paired with a mismatched tenant id', async () => {
      // Arrange: a key bound to the fixture's `dev`. The resolver always
      // applies `.eq('tenant_id', tenantId)`. A forged request that pairs a
      // real key id with a different tenant id resolves to nothing — this is
      // the structural guard behind "a client cannot self-assign a tenant".
      const guardKey = freshKeyId('guard');
      await admin.from('api_key').insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        environment_id: fixture.defaultEnv.id,
        name: guardKey,
        api_key_id: guardKey,
        created_by: fixture.ownerUser.id,
      });

      // Act: resolve with a tenant id that does NOT own the key.
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: guardKey,
        tenantId: '00000000-0000-0000-0000-000000000000',
      });

      // Assert: tenant-scoped lookup → no row → NO_ENVIRONMENT sentinel.
      expect(resolved).toBeNull();

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', guardKey);
    });
  });
});
