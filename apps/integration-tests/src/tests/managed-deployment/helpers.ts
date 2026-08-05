/**
 * Managed Deployment Test Helpers
 *
 * Provides factory and cleanup functions for managed deployment integration tests.
 * Follows the same patterns as app-test-utils.ts and entitlements/helpers.ts.
 *
 * Key tables:
 * - env_var: encrypted env vars per app (vault_secret_id references Supabase Vault)
 * - app: runtime and entry_point columns for managed deployments
 *
 * There is no `deployment` table, so this file provides no
 * `createTestDeployment` / `cleanupTestDeployments` helpers.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../../lib/test-utils';
import { resolveDefaultEnvironmentId } from '../../lib/environment-test-utils';

// Re-exported from the shared location so existing importers keep working.
export { resolveDefaultEnvironmentId };

// ============================================================================
// Tracking for Cleanup
// ============================================================================

const createdEnvVars: Map<string, Set<string>> = new Map(); // appId -> Set<envVarId>

// ============================================================================
// Env Var Helpers
// ============================================================================

/**
 * Creates a env_var record with a corresponding vault secret.
 *
 * `env_var.environment_id` is NOT NULL — every env
 * var belongs to exactly one environment. When `environmentId` is omitted this
 * helper resolves the app's default `dev` environment, so existing callers
 * that pre-date the env-scoping change keep working.
 *
 * @param supabase - Supabase client (admin or authenticated user)
 * @param appId - The app to attach the env var to
 * @param tenantId - The owning tenant
 * @param key - The env var key (e.g. 'DATABASE_URL')
 * @param value - The secret value to store in vault
 * @param environmentId - The environment to scope the var to; defaults to the
 *   app's default `dev` environment.
 * @returns The created env_var record
 */
export async function createTestEnvVar(
  supabase: SupabaseClient,
  appId: string,
  tenantId: string,
  key: string,
  value: string,
  environmentId?: string,
) {
  const admin = getSupabaseAdmin();

  // 1. Environment_id is NOT NULL — bind to the app's default
  //    env when the caller did not pick one.
  const envId = environmentId ?? (await resolveDefaultEnvironmentId(appId));

  // 2. Insert secret into vault via RPC (requires service_role). The vault
  //    secret name is env-scoped (`env_<appId>_<envId>_<key>`) so it matches
  //    what the env-scoped `EnvVarService` reads/writes.
  const { data: secretId, error: secretError } = await admin.rpc('insert_secret', {
    name: `env_${appId}_${envId}_${key}`,
    secret: value,
  });

  if (secretError) {
    throw new Error(`Failed to insert vault secret: ${secretError.message}`);
  }

  // 3. Insert env_var record (uses passed client to test RLS)
  const { data, error } = await supabase
    .from('env_var')
    .insert({
      app_id: appId,
      tenant_id: tenantId,
      key,
      vault_secret_id: secretId,
      environment_id: envId,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create env var: ${error.message}`);

  // Track for cleanup
  if (!createdEnvVars.has(appId)) {
    createdEnvVars.set(appId, new Set());
  }
  createdEnvVars.get(appId)!.add(data.id);

  return data;
}

/**
 * Cleans up all test env vars for a given app, including vault secrets.
 * Uses admin client to bypass RLS.
 */
export async function cleanupTestEnvVars(appId: string): Promise<void> {
  const admin = getSupabaseAdmin();

  // Fetch env vars to get secret names for vault cleanup
  const { data: vars } = await admin
    .from('env_var')
    .select('id, key, environment_id')
    .eq('app_id', appId);

  // Delete vault secrets (env-scoped name)
  for (const v of vars ?? []) {
    await admin.rpc('delete_secret', {
      secret_name: `env_${appId}_${v.environment_id}_${v.key}`,
    });
  }

  // Delete env var records
  await admin.from('env_var').delete().eq('app_id', appId);

  createdEnvVars.delete(appId);
}

