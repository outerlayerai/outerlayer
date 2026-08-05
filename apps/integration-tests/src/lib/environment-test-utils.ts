/**
 * Environment Test Utilities
 *
 * `api_key.environment_id` and `deployment.environment_id` are NOT NULL —
 * every app must have exactly one default `dev` environment.
 *
 * As of the `on_create_seed_default_env` trigger (migration 20260529221911),
 * that default env is auto-created in the same transaction as the `app` row,
 * for EVERY create path — including tests that insert an `app` row directly.
 * These helpers therefore mostly *resolve* the trigger-seeded env;
 * {@link ensureDefaultEnvironment} still creates one if absent (e.g. when run
 * against a pre-trigger database) and is idempotent against the trigger.
 *
 * This module is the single shared home for that logic. Other helpers
 * (`managed-deployment/helpers.ts`, `app-test-utils.ts`) re-use these
 * functions rather than duplicating them.
 */

import { getSupabaseAdmin } from './test-utils';
import { retryOnTransientError } from './retry';

/**
 * Resolves an app's default `dev` environment id.
 *
 * Every app is expected to have exactly one default environment (auto-seeded
 * by the `on_create_seed_default_env` trigger on app insert). Throws if none
 * exists — call {@link ensureDefaultEnvironment} for apps created against a
 * pre-trigger database.
 */
export async function resolveDefaultEnvironmentId(
  appId: string,
): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .single();
  if (error || !data) {
    throw new Error(
      `No default environment for app ${appId}: ${error?.message ?? 'not found'}`,
    );
  }
  return data.id;
}

/**
 * Ensures an app has a default `dev` environment, creating it if missing,
 * and returns the default environment id.
 *
 * As of the `on_create_seed_default_env` trigger (migration 20260529221911),
 * every app insert — including direct `from('app')` inserts in test setup —
 * auto-seeds the default `dev` env in the same transaction, so this helper is
 * now usually just a lookup. It is retained because callers need the returned
 * environment id, and it stays correct whether the env was trigger-seeded or
 * not (the `is_default` lookup below finds it either way).
 *
 * @param appId - The app to ensure a default environment for
 * @param tenantId - The owning tenant (required to create the environment row)
 */
export async function ensureDefaultEnvironment(
  appId: string,
  tenantId: string,
): Promise<string> {
  const admin = getSupabaseAdmin();

  const { data: existing } = await admin
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();

  if (existing) {
    return existing.id;
  }

  const { data: created, error } = await retryOnTransientError(() =>
    admin
      .from('environment')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        name: 'dev',
        is_default: true,
      })
      .select('id')
      .single()
  );

  if (error || !created) {
    throw new Error(
      `Failed to create default environment for app ${appId}: ${error?.message ?? 'unknown error'}`,
    );
  }

  return created.id;
}
