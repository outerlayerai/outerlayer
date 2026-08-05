/**
 * Shared helpers for the environment-navigation integration suite.
 *
 * The schema has three RLS-relevant deltas: `env_var.environment_id`
 * is NOT NULL and every env var belongs to exactly one environment.
 *
 * This file provides a tenant fixture with:
 *   - one tenant,
 *   - an owner user and a read-only user in that tenant (RLS tests),
 *   - one app,
 *   - the default `dev` environment + an extra `prod` environment,
 *   - env-var seeders (vault secret + `env_var` row) and cascading
 *     cleanup.
 *
 * Runs against a real local Supabase; each test cleans up the rows it seeds.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  envVarEnvVaultName,
  envVarKindVaultName,
  type EnvVarTargetKind,
} from '@repo/env-kind';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { retryOnTransientError } from '../../lib/retry';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FixtureUser {
  id: string;
  email: string;
  tenantId: string;
  membershipId: string;
  orgRole: 'owner' | 'read';
  client: SupabaseClient;
}

interface FixtureEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * A complete env-navigation fixture: one tenant, an owner + read user, one app
 * with a default `dev` environment and an extra `prod` environment.
 */
export interface EnvNavFixture {
  tenantId: string;
  appId: string;
  appName: string;
  ownerUser: FixtureUser;
  readUser: FixtureUser;
  /** Default `dev` environment — auto-created with the app. */
  devEnv: FixtureEnvironment;
  /** Extra `prod` environment seeded by the fixture. */
  prodEnv: FixtureEnvironment;
  cleanup: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// User creation
// ─────────────────────────────────────────────────────────────────────────────

async function createFixtureUser(params: {
  tenantId: string;
  role: 'owner' | 'read';
  rid: string;
}): Promise<FixtureUser> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const { tenantId, role, rid } = params;
  const localId = Math.random().toString(36).substring(2, 8);
  const email = `${role}-${Date.now()}-${rid}-${localId}@test-envnav.com`;
  const password = 'TestPassword123!';

  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (authError || !authData?.user) {
    throw new Error(`Auth user create: ${authError?.message}`);
  }
  const userId = authData.user.id;

  const { error: profileError } = await retryOnTransientError(() =>
    admin
      .from('profile')
      .insert({ id: userId, name: `${role} ${rid}`, email })
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  const { data: membershipData, error: membershipError } = await retryOnTransientError(() =>
    admin
      .from('membership')
      .insert({ user_id: userId, tenant_id: tenantId, role, status: 'active' })
      .select('id')
      .single()
  );
  if (membershipError) {
    throw new Error(`Membership create: ${membershipError.message}`);
  }

  await admin.rpc('set_claim', {
    claim: 'tenant_id',
    uid: userId,
    value: tenantId,
  });
  await admin.rpc('set_claim', { claim: 'role', uid: userId, value: role });

  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();

  return {
    id: userId,
    email,
    tenantId,
    membershipId: membershipData.id as string,
    orgRole: role,
    client,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a tenant + owner + read user + app with two environments
 * (`dev` default and `prod`). Returns the fixture and a cleanup function.
 *
 * There is no DB trigger that auto-creates the default environment; this
 * fixture inserts it directly (the production app-creation server action does
 * the same thing via `EnvironmentService.createDefaultEnvironment`).
 */
export async function setupEnvNavFixture(): Promise<EnvNavFixture> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const tenantId = randomUUID();
  const rid = Math.random().toString(36).substring(2, 8);

  const { error: tenantError } = await retryOnTransientError(() =>
    admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `envnav-${rid}`,
      organization_name: `envnav-org-${rid}`,
      created_by: randomUUID(),
    })
  );
  if (tenantError) throw new Error(`Tenant create: ${tenantError.message}`);

  const ownerUser = await createFixtureUser({ tenantId, role: 'owner', rid });
  await admin
    .from('tenant')
    .update({ created_by: ownerUser.id })
    .eq('tenant_id', tenantId);
  const readUser = await createFixtureUser({ tenantId, role: 'read', rid });

  // Wrapped in retryOnTransientError like the tenant insert above — under CI
  // load Kong/PostgREST can return a transient 502 on this insert too.
  const appName = `envnav-app-${rid}`;
  const { data: appData, error: appError } = await retryOnTransientError(() =>
    admin
      .from('app')
      .insert({ tenant_id: tenantId, name: appName, created_by: ownerUser.id })
      .select('id, name')
      .single()
  );
  if (appError || !appData) {
    throw new Error(`App create: ${appError?.message}`);
  }
  const appId = appData.id as string;

  const devEnv = await seedEnvironment({
    admin,
    tenantId,
    appId,
    name: 'dev',
    isDefault: true,
    createdBy: ownerUser.id,
  });
  const prodEnv = await seedEnvironment({
    admin,
    tenantId,
    appId,
    name: 'prod',
    isDefault: false,
    createdBy: ownerUser.id,
  });

  return {
    tenantId,
    appId,
    appName: appData.name as string,
    ownerUser,
    readUser,
    devEnv,
    prodEnv,
    cleanup: () => cleanupEnvNavFixture(tenantId, [ownerUser, readUser]),
  };
}

async function seedEnvironment(params: {
  admin: SupabaseClient;
  tenantId: string;
  appId: string;
  name: string;
  isDefault: boolean;
  createdBy: string;
}): Promise<FixtureEnvironment> {
  const { admin, tenantId, appId, name, isDefault, createdBy } = params;
  const { data, error } = await admin
    .from('environment')
    .insert({
      tenant_id: tenantId,
      app_id: appId,
      name,
      is_default: isDefault,
      created_by: createdBy,
    })
    .select('id, name, is_default')
    .single();
  if (!error && data) {
    return {
      id: data.id as string,
      name: data.name as string,
      isDefault: data.is_default as boolean,
    };
  }
  // 23505: a row already exists for this (app_id, name). The default `dev`
  // env is auto-seeded by the `on_create_seed_default_env` trigger when the
  // app row is inserted (above), so seeding `dev` here now collides — fetch
  // and return the existing row so the fixture is idempotent against the
  // trigger. Non-default envs (e.g. `prod`) don't collide and take the insert
  // path above.
  if (error?.code === '23505') {
    const existing = await admin
      .from('environment')
      .select('id, name, is_default')
      .eq('app_id', appId)
      .eq('name', name)
      .single();
    if (!existing.error && existing.data) {
      return {
        id: existing.data.id as string,
        name: existing.data.name as string,
        isDefault: existing.data.is_default as boolean,
      };
    }
  }
  throw new Error(`seedEnvironment(${name}) failed: ${error?.message}`);
}

async function cleanupEnvNavFixture(
  tenantId: string,
  users: FixtureUser[],
): Promise<void> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  try {
    // Child rows first. env_var cascades from environment / app,
    // but delete explicitly so vault-secret cleanup (below) has the rows.
    await admin.from('env_var').delete().eq('tenant_id', tenantId);
    await admin.from('api_key').delete().eq('tenant_id', tenantId);
    await admin.from('environment').delete().eq('tenant_id', tenantId);
    await admin.from('app').delete().eq('tenant_id', tenantId);
  } catch (err) {

    console.warn(`cleanup: child-row delete swallowed: ${(err as Error).message}`);
  }

  for (const u of users) {
    try {
      await admin.from('membership').delete().eq('id', u.membershipId);
      await admin.from('profile').delete().eq('id', u.id);
      await admin.auth.admin.deleteUser(u.id);
    } catch (err) {

      console.warn(`Cleanup user ${u.email} failed: ${(err as Error).message}`);
    }
  }

  try {
    await admin.from('tenant').delete().eq('tenant_id', tenantId);
  } catch (err) {

    console.warn(`Cleanup tenant ${tenantId} failed: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-var seeders
// ─────────────────────────────────────────────────────────────────────────────

export interface SeededEnvVar {
  id: string;
  key: string;
  appId: string;
  environmentId: string;
  vaultSecretId: string;
  vaultSecretName: string;
}

/**
 * Inserts a vault secret and an env-scoped `env_var` row.
 *
 * @param client - Supabase client to perform the `env_var` INSERT
 *   with (use an authenticated user's client to exercise RLS, or admin to
 *   bypass it).
 * @returns The created env-var record + vault secret metadata.
 */
export async function seedEnvVar(params: {
  client: SupabaseClient;
  tenantId: string;
  appId: string;
  environmentId: string;
  key: string;
  value: string;
}): Promise<SeededEnvVar> {
  const { client, tenantId, appId, environmentId, key, value } = params;
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  const secretName = envVarEnvVaultName(appId, environmentId, key);
  const { data: secretId, error: secretError } = await admin.rpc(
    'insert_secret',
    { name: secretName, secret: value },
  );
  if (secretError) {
    throw new Error(`insert_secret failed: ${secretError.message}`);
  }

  const { data, error } = await client
    .from('env_var')
    .insert({
      tenant_id: tenantId,
      app_id: appId,
      environment_id: environmentId,
      key,
      vault_secret_id: secretId,
    })
    .select('id, key')
    .single();
  if (error || !data) {
    throw new Error(`seedEnvVar(${key}) failed: ${error?.message}`);
  }

  return {
    id: data.id as string,
    key: data.key as string,
    appId,
    environmentId,
    vaultSecretId: secretId as string,
    vaultSecretName: secretName,
  };
}

/**
 * Inserts a vault secret and a KIND-targeted `env_var` row
 * (`target_kind` set, `environment_id` NULL). The secret is named with the
 * shared `envVarKindVaultName` scheme — the same one the dashboard write path
 * and the gateway build path read — so a collection test exercises the real
 * Vault naming end-to-end.
 */
export async function seedKindEnvVar(params: {
  tenantId: string;
  appId: string;
  targetKind: EnvVarTargetKind;
  key: string;
  value: string;
}): Promise<{ id: string; vaultSecretName: string }> {
  const { tenantId, appId, targetKind, key, value } = params;
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  const secretName = envVarKindVaultName(appId, targetKind, key);
  const { data: secretId, error: secretError } = await admin.rpc(
    'insert_secret',
    { name: secretName, secret: value },
  );
  if (secretError) {
    throw new Error(`insert_secret (kind) failed: ${secretError.message}`);
  }

  const { data, error } = await admin
    .from('env_var')
    .insert({
      tenant_id: tenantId,
      app_id: appId,
      environment_id: null,
      target_kind: targetKind,
      key,
      vault_secret_id: secretId,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`seedKindEnvVar(${targetKind}/${key}) failed: ${error?.message}`);
  }
  return { id: data.id as string, vaultSecretName: secretName };
}

/**
 * Inserts a vault secret only, returning its id. Use when a test needs a
 * `vault_secret_id` for a `env_var` INSERT it performs itself
 * (e.g. an INSERT it expects to be rejected).
 */
export async function createVaultSecret(
  name: string,
  value: string,
): Promise<string> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const { data, error } = await admin.rpc('insert_secret', {
    name,
    secret: value,
  });
  if (error) throw new Error(`createVaultSecret failed: ${error.message}`);
  return data as string;
}
