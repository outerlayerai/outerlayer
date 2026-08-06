/**
 * Acceptance: the env-vars feature's `EnvVarService`.
 *
 * RLS tenancy/authz basics for `env_var` (owner/viewer CRUD, cross-
 * tenant isolation, app cascade-delete, the unique constraints) are already
 * proven at the raw-table wire in
 * `managed-deployment/env-var.test.ts` and the
 * `environment-navigation/env-var-*.test.ts` suite — cited, not duplicated.
 *
 * What's covered here instead: the `features/integrations/env-var-service.ts`
 * `EnvVarService` — its metadata queries ride the caller's `ctx.db`
 * (RLS-scoped, not an admin client) and its Vault calls are delegated to
 * `lib/system/env-var-secrets.ts` (a service-role client the service body
 * never touches directly). This suite drives that service directly:
 * `authorizedAction` needs the Next.js request scope this harness doesn't
 * have, but the service underneath it is a plain class over `ServiceContext`.
 *
 * The precedence case below covers `collectEnvVars`
 * (`lib/system/collect-env-vars.ts`) — the deployment-build read path, which always runs at admin
 * authority rather than the caller's `ctx.db`.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  setupEnvNavFixture,
  seedEnvVar,
  seedKindEnvVar,
  createVaultSecret,
  type EnvNavFixture,
  type FixtureUser,
} from '../environment-navigation/helpers';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import {
  createTenantWithOwner,
  createCustomRole,
  assignCustomRole,
  setCustomRoleClaim,
  createTestApp,
  cleanupCustomRoles,
  cleanupTenantAndUsers,
  type SameTenantUser,
} from '../custom-roles/helpers';
import { EnvVarService } from 'tenant-dashboard/src/features/integrations/env-var-service';
import { collectEnvVars } from 'tenant-dashboard/src/lib/system/collect-env-vars';
import type { ServiceContext } from 'tenant-dashboard/src/lib/action-kit/service-context';
import { envVarEnvVaultName, envVarLegacyVaultName } from '@repo/env-kind';

const untyped = (client: { from: SupabaseClient['from'] }): SupabaseClient => client as unknown as SupabaseClient;

function ctxFor(user: FixtureUser | SameTenantUser, tenantId: string): ServiceContext {
  return {
    db: untyped(user.client as SupabaseClient),
    tenantId,
    actor: { userId: user.id, role: 'orgRole' in user ? user.orgRole : 'owner' },
  };
}

describe('env-vars feature behavior — EnvVarService wire (Vault delegated to lib/system)', () => {
  let fx: EnvNavFixture;
  const admin = createSupabaseAdminClientUntyped();

  beforeAll(async () => {
    fx = await setupEnvNavFixture();
  }, 90000);

  afterAll(async () => {
    await fx.cleanup();
  });

  describe('set (create + update) round-trips through Vault', () => {
    it('creates a row with a Vault secret readable back by the env-scoped name', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const key = `EV1_${randomUUID().slice(0, 6).toUpperCase()}`;

      const result = await new EnvVarService({ supabase: ctx.db as SupabaseClient }).set(
        fx.appId,
        { environmentId: fx.devEnv.id },
        fx.tenantId,
        key,
        'first-value',
      );

      expect(result.key).toBe(key);
      const { data: secret } = await admin.rpc('read_secret', {
        secret_name: envVarEnvVaultName(fx.appId, fx.devEnv.id, key),
      });
      expect(secret).toBe('first-value');
    });

    it('replaces the value in Vault on a second set for the same scope+key (no duplicate row)', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const service = new EnvVarService({ supabase: ctx.db as SupabaseClient });
      const key = `EV2_${randomUUID().slice(0, 6).toUpperCase()}`;

      const first = await service.set(fx.appId, { environmentId: fx.devEnv.id }, fx.tenantId, key, 'v1');
      const second = await service.set(fx.appId, { environmentId: fx.devEnv.id }, fx.tenantId, key, 'v2');

      expect(second.id).toBe(first.id); // same row, not a duplicate
      const { data: secret } = await admin.rpc('read_secret', {
        secret_name: envVarEnvVaultName(fx.appId, fx.devEnv.id, key),
      });
      expect(secret).toBe('v2');
    });
  });

  describe('list scoping (per-env vs app-wide)', () => {
    it('list() returns only the given environment’s specific rows (kind rows excluded)', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const devKey = `EV3DEV_${randomUUID().slice(0, 6).toUpperCase()}`;
      const prodKey = `EV3PROD_${randomUUID().slice(0, 6).toUpperCase()}`;
      const kindKey = `EV3KIND_${randomUUID().slice(0, 6).toUpperCase()}`;
      await seedEnvVar({ client: admin, tenantId: fx.tenantId, appId: fx.appId, environmentId: fx.devEnv.id, key: devKey, value: 'd' });
      await seedEnvVar({ client: admin, tenantId: fx.tenantId, appId: fx.appId, environmentId: fx.prodEnv.id, key: prodKey, value: 'p' });
      await seedKindEnvVar({ tenantId: fx.tenantId, appId: fx.appId, targetKind: 'all', key: kindKey, value: 'k' });

      const devList = await new EnvVarService({ supabase: ctx.db as SupabaseClient }).list(fx.appId, fx.devEnv.id);

      const keys = devList.map((r) => r.key);
      expect(keys).toContain(devKey);
      expect(keys).not.toContain(prodKey);
      expect(keys).not.toContain(kindKey);
      // No secret values in the list payload.
      for (const row of devList) expect(row).not.toHaveProperty('value');
    });

    it('listAll() returns both specific-env and kind rows for the app, no secret values', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const devKey = `EV3ALLDEV_${randomUUID().slice(0, 6).toUpperCase()}`;
      const kindKey = `EV3ALLKIND_${randomUUID().slice(0, 6).toUpperCase()}`;
      await seedEnvVar({ client: admin, tenantId: fx.tenantId, appId: fx.appId, environmentId: fx.devEnv.id, key: devKey, value: 'd' });
      await seedKindEnvVar({ tenantId: fx.tenantId, appId: fx.appId, targetKind: 'preview', key: kindKey, value: 'k' });

      const all = await new EnvVarService({ supabase: ctx.db as SupabaseClient }).listAll(fx.appId);
      const keys = all.map((r) => r.key);
      expect(keys).toContain(devKey);
      expect(keys).toContain(kindKey);
      for (const row of all) expect(row).not.toHaveProperty('value');
    });
  });

  describe('multi-target set (the setEnvVarForTargets action loops set() across scopes)', () => {
    it('writes one row per target scope', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const service = new EnvVarService({ supabase: ctx.db as SupabaseClient });
      const key = `EV4_${randomUUID().slice(0, 6).toUpperCase()}`;
      const scopes = [{ environmentId: fx.devEnv.id }, { environmentId: fx.prodEnv.id }];

      for (const scope of scopes) {
        await service.set(fx.appId, scope, fx.tenantId, key, 'multi-target-value');
      }

      const all = await service.listAll(fx.appId);
      const written = all.filter((r) => r.key === key).map((r) => r.environment_id);
      expect(written).toEqual(expect.arrayContaining([fx.devEnv.id, fx.prodEnv.id]));
      expect(written).toHaveLength(2);
    });

    it('on a partial failure, already-applied scopes persist and the error surfaces', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const service = new EnvVarService({ supabase: ctx.db as SupabaseClient });
      const key = `EV4FAIL_${randomUUID().slice(0, 6).toUpperCase()}`;
      // The first scope is valid; the second targets an environment id that
      // does not belong to this app, so its `set()` call rejects — the same
      // sequential-loop semantics `setEnvVarForTargets` runs in production.
      const scopes = [{ environmentId: fx.devEnv.id }, { environmentId: randomUUID() }];

      let thrown: unknown;
      try {
        for (const scope of scopes) {
          await service.set(fx.appId, scope, fx.tenantId, key, 'v');
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/does not belong to app/);

      const all = await service.listAll(fx.appId);
      const written = all.filter((r) => r.key === key);
      expect(written).toEqual([expect.objectContaining({ environment_id: fx.devEnv.id })]);
    });
  });

  describe('kind/specific precedence via collectEnvVars', () => {
    it('a specific-env row overrides a matching kind row for that environment', async () => {
      const key = `EV5_${randomUUID().slice(0, 6).toUpperCase()}`;
      await seedKindEnvVar({ tenantId: fx.tenantId, appId: fx.appId, targetKind: 'all', key, value: 'kind-value' });
      await seedEnvVar({ client: admin, tenantId: fx.tenantId, appId: fx.appId, environmentId: fx.devEnv.id, key, value: 'specific-value' });

      const collected = await collectEnvVars(fx.appId, fx.devEnv.id);

      expect(collected[key]).toBe('specific-value');
    });

    it('a fresh env with zero specific rows inherits the matching kind row', async () => {
      const key = `EV5B_${randomUUID().slice(0, 6).toUpperCase()}`;
      await seedKindEnvVar({ tenantId: fx.tenantId, appId: fx.appId, targetKind: 'all', key, value: 'inherited' });

      const collected = await collectEnvVars(fx.appId, fx.prodEnv.id);

      expect(collected[key]).toBe('inherited');
    });
  });

  describe('delete removes the row AND the Vault secret', () => {
    it('a subsequent read_secret misses after delete', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const key = `EV6_${randomUUID().slice(0, 6).toUpperCase()}`;
      const seeded = await seedEnvVar({ client: admin, tenantId: fx.tenantId, appId: fx.appId, environmentId: fx.devEnv.id, key, value: 'to-delete' });

      await new EnvVarService({ supabase: ctx.db as SupabaseClient }).delete(fx.appId, seeded.id);

      const { data: row } = await admin.from('env_var').select('id').eq('id', seeded.id).maybeSingle();
      expect(row).toBeNull();
      const { data: secret } = await admin.rpc('read_secret', { secret_name: seeded.vaultSecretName });
      expect(secret).toBeNull();
    });
  });

  describe('reveal returns the stored value by row id', () => {
    it('getValue resolves the value for a known row', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const key = `EV7_${randomUUID().slice(0, 6).toUpperCase()}`;
      const seeded = await seedEnvVar({ client: admin, tenantId: fx.tenantId, appId: fx.appId, environmentId: fx.devEnv.id, key, value: 'reveal-me' });

      const value = await new EnvVarService({ supabase: ctx.db as SupabaseClient }).getValue(fx.appId, seeded.id);

      expect(value).toBe('reveal-me');
    });

    it('an unknown row id resolves to null (cross-tenant isolation is pinned at the raw-wire suite cited above)', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const value = await new EnvVarService({ supabase: ctx.db as SupabaseClient }).getValue(fx.appId, randomUUID());
      expect(value).toBeNull();
    });
  });

  describe('legacy Vault-name fallback (via lib/system/env-var-secrets.ts)', () => {
    it('resolves a row whose secret exists only under the pre-055 legacy name, and a re-save writes the env-scoped name', async () => {
      const key = `EV8_${randomUUID().slice(0, 6).toUpperCase()}`;
      const legacyName = envVarLegacyVaultName(fx.appId, key);
      const legacySecretId = await createVaultSecret(legacyName, 'legacy-value');

      // A row that already exists (as if migrated) but whose vault secret is
      // still under the legacy name — the fallback path `getValue` exercises.
      const { data: row, error } = await admin
        .from('env_var')
        .insert({
          tenant_id: fx.tenantId,
          app_id: fx.appId,
          environment_id: fx.devEnv.id,
          key,
          vault_secret_id: legacySecretId,
        })
        .select('id')
        .single();
      if (error || !row) throw new Error(`seed migrated row failed: ${error?.message}`);

      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const service = new EnvVarService({ supabase: ctx.db as SupabaseClient });

      const legacyResolved = await service.getValue(fx.appId, row.id as string);
      expect(legacyResolved).toBe('legacy-value');

      // Re-save writes the env-scoped name — the winning name going forward.
      await service.set(fx.appId, { environmentId: fx.devEnv.id }, fx.tenantId, key, 'resaved-value');
      const { data: envScoped } = await admin.rpc('read_secret', {
        secret_name: envVarEnvVaultName(fx.appId, fx.devEnv.id, key),
      });
      expect(envScoped).toBe('resaved-value');
    });
  });

  describe('failed-replacement durability', () => {
    it('a Vault write failure during re-save leaves the previous value readable and vault_secret_id unchanged', async () => {
      const ctx = ctxFor(fx.ownerUser, fx.tenantId);
      const service = new EnvVarService({ supabase: ctx.db as SupabaseClient });
      const key = `EV10_${randomUUID().slice(0, 6).toUpperCase()}`;

      const created = await service.set(fx.appId, { environmentId: fx.devEnv.id }, fx.tenantId, key, 'durable-value');
      const { data: before } = await admin.from('env_var').select('vault_secret_id').eq('id', created.id).single();

      // A NUL byte is a genuine Vault/Postgres rejection ("unsupported Unicode
      // escape sequence"), not a mock — the real RPC boundary refuses to store
      // it, exercising the actual failure path rather than a simulated one.
      await expect(
        service.set(fx.appId, { environmentId: fx.devEnv.id }, fx.tenantId, key, `bad${String.fromCharCode(0)}value`),
      ).rejects.toThrow();

      const value = await service.getValue(fx.appId, created.id);
      expect(value).toBe('durable-value');
      const { data: after } = await admin.from('env_var').select('vault_secret_id').eq('id', created.id).single();
      expect(after?.vault_secret_id).toBe(before?.vault_secret_id);
    });
  });

  describe('boundary rejections', () => {
    // The per-env unique constraint (`env_var_app_key_env_unique`)
    // and the partial kind-unique index are already pinned directly at the
    // constraint in `managed-deployment/env-var.test.ts` ("should
    // enforce unique constraint on (app_id, key, environment_id)") — cited,
    // not duplicated. `EnvVarService.set` never reaches that constraint on a
    // repeat call for the same scope+key: it checks-then-updates (the set case above
    // proves the update path), so a service-level "duplicate key" case would
    // only assert the check-then-update behavior a second time.

    it('the action schema rejects an empty key before any DB/Vault call', async () => {
      const { setEnvVarInput } = await import('tenant-dashboard/src/features/integrations/schemas');
      const parsed = setEnvVarInput.safeParse({
        appId: fx.appId,
        scope: { environmentId: fx.devEnv.id },
        key: '',
        value: 'v',
      });
      expect(parsed.success).toBe(false);
    });
  });
});

describe('mirrored permission gap: env_var.read alone cannot update', () => {
  let owner: SameTenantUser;
  let reader: SameTenantUser;
  let appId: string;
  let envId: string;
  const admin = createSupabaseAdminClientUntyped();

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    reader = await createTenantWithOwner(); // separate account, joined below as a custom-role member
    const { error: membershipError } = await admin.from('membership').insert({
      user_id: reader.id,
      tenant_id: owner.tenantId,
      role: 'read',
      status: 'active',
    });
    if (membershipError) throw new Error(`reader membership: ${membershipError.message}`);

    const app = await createTestApp(admin, owner.tenantId);
    appId = app.id;
    const { data: env, error: envError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', appId)
      .eq('is_default', true)
      .single();
    if (envError) throw new Error(`default env lookup: ${envError.message}`);
    envId = env!.id as string;

    const role = await createCustomRole(admin, owner.tenantId, 'env-var-reader', ['env_var.read']);
    await assignCustomRole(admin, reader.membershipId, role.id);
    await setCustomRoleClaim(admin, reader.id, role.id, reader.client);
  }, 90000);

  afterAll(async () => {
    await admin.from('env_var').delete().eq('app_id', appId);
    await admin.from('environment').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await admin.from('membership').delete().eq('user_id', reader.id).eq('tenant_id', owner.tenantId);
    await cleanupCustomRoles(admin, owner.tenantId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(reader.tenantId, [reader]);
  });

  it('a custom role holding only env_var.read is refused at the DB on an insert (WITH CHECK)', async () => {
    const asReader = await createTenantScopedClient(reader, owner.tenantId);
    const { error } = await asReader.from('env_var').insert({
      tenant_id: owner.tenantId,
      app_id: appId,
      environment_id: envId,
      key: 'SHOULD_BE_DENIED',
      vault_secret_id: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it('the same role reads the metadata row fine (the .read grant it does hold)', async () => {
    await admin.from('env_var').insert({
      tenant_id: owner.tenantId,
      app_id: appId,
      environment_id: envId,
      key: 'READABLE_KEY',
      vault_secret_id: (await createVaultSecret(`g1-2-${randomUUID()}`, 'x')),
    });
    const asReader = await createTenantScopedClient(reader, owner.tenantId);
    const { data, error } = await asReader
      .from('env_var')
      .select('key')
      .eq('app_id', appId)
      .eq('key', 'READABLE_KEY');
    expect(error).toBeNull();
    expect(data).toEqual([{ key: 'READABLE_KEY' }]);
  });
});

describe('env-vars picker permissions do not include environment.read', () => {
  let owner: SameTenantUser;
  let picker: SameTenantUser;
  let pickerMembershipId: string;
  let appId: string;
  let envId: string;
  const admin = createSupabaseAdminClientUntyped();

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    picker = await createTenantWithOwner(); // separate account, joined below as a custom-role member
    // A distinct row from `picker.membershipId` (picker's OWNER membership in
    // their own tenant, from `createTenantWithOwner`) — the custom role below
    // must attach to THIS membership, the one scoped to `owner.tenantId`.
    const { data: membershipRow, error: membershipError } = await admin
      .from('membership')
      .insert({
        user_id: picker.id,
        tenant_id: owner.tenantId,
        role: 'read',
        status: 'active',
      })
      .select('id')
      .single();
    if (membershipError || !membershipRow) throw new Error(`picker membership: ${membershipError?.message}`);
    pickerMembershipId = membershipRow.id as string;

    const app = await createTestApp(admin, owner.tenantId);
    appId = app.id;
    const { data: env, error: envError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', appId)
      .eq('is_default', true)
      .single();
    if (envError) throw new Error(`default env lookup: ${envError.message}`);
    envId = env!.id as string;

    // Exactly the env_vars_view + env_vars_manage picker groups' db permissions
    // — no environment.read, matching what a real custom role gets from those
    // groups (`src/utils/permissions.ts`).
    const role = await createCustomRole(admin, owner.tenantId, 'env-var-picker', [
      'env_var.read',
      'env_var.insert',
      'env_var.update',
      'env_var.delete',
    ]);
    await assignCustomRole(admin, pickerMembershipId, role.id);
    await setCustomRoleClaim(admin, picker.id, role.id, picker.client);
  }, 90000);

  afterAll(async () => {
    await admin.from('env_var').delete().eq('app_id', appId);
    await admin.from('environment').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await admin.from('membership').delete().eq('user_id', picker.id).eq('tenant_id', owner.tenantId);
    await cleanupCustomRoles(admin, owner.tenantId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(picker.tenantId, [picker]);
  });

  it('a role without environment.read can still list env vars for the app', async () => {
    await admin.from('env_var').insert({
      tenant_id: owner.tenantId,
      app_id: appId,
      environment_id: envId,
      key: 'PICKER_LIST_KEY',
      vault_secret_id: await createVaultSecret(`g1-4-list-${randomUUID()}`, 'x'),
    });

    const scopedClient = await createTenantScopedClient(picker, owner.tenantId);
    const rows = await new EnvVarService({ supabase: scopedClient }).list(appId, envId);

    expect(rows.map((r) => r.key)).toContain('PICKER_LIST_KEY');
  });

  it('a role without environment.read can still set (create) an env var — the env-ownership pairing check resolves on the admin client', async () => {
    const scopedClient = await createTenantScopedClient(picker, owner.tenantId);
    const key = `G14_${randomUUID().slice(0, 6).toUpperCase()}`;

    const result = await new EnvVarService({ supabase: scopedClient }).set(
      appId,
      { environmentId: envId },
      owner.tenantId,
      key,
      'picker-value',
    );

    expect(result.key).toBe(key);
  });
});
