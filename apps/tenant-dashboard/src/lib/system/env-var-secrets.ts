import "server-only";

/**
 * Deployment env-var Vault access — the sole sanctioned caller of the
 * `read_secret`/`insert_secret`/`delete_secret` RPCs for `env_var`
 * rows. Those RPCs are `service_role`-only (`96-function-execution-grants.sql`),
 * so every call here runs on a raw service-role client constructed directly
 * in this module — no shared factory.
 *
 * The env-scoped legacy-name fallback is required for correctness. Some vault
 * secrets are still named `env_${appId}_${key}` (one app-wide value): when
 * env-vars became per-environment, each app-default row was replicated to every
 * environment while sharing the SAME `vault_secret_id`, so the underlying
 * secret could not be renamed — N replicated rows reference ONE secret. A
 * lookup by the env-scoped name therefore misses until the var is re-saved
 * (`set()` writes the env-scoped name and retires the legacy one for that key).
 * This fallback must resolve the legacy name byte-for-byte or such an env var
 * silently loses its value.
 */

import { createClient } from "@supabase/supabase-js";
import {
  envVarEnvVaultName,
  envVarKindVaultName,
  envVarLegacyVaultName,
  type EnvVarTargetKind,
} from "@repo/env-kind";

import type { Database } from "@/types/db";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY } from "@/config-global.server";

function systemClient() {
  return createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** A vault read/write/delete error, surfaced rather than swallowed. */
interface VaultOpError {
  message: string;
}

/**
 * Read a specific-env row's secret by the env-scoped name, falling back to
 * the legacy (pre-055) app-scoped name on a miss. Returns `null` only when
 * neither name resolves; a Vault RPC *error* (as opposed to a miss) is
 * surfaced so callers can fail loudly rather than silently omit a
 * user-configured value.
 */
export async function readEnvVarSecret(
  appId: string,
  environmentId: string,
  key: string,
): Promise<{ value: string | null; error: VaultOpError | null }> {
  const supabase = systemClient();
  const envScopedName = envVarEnvVaultName(appId, environmentId, key);
  const { data: primary, error: primaryError } = await supabase.rpc("read_secret", {
    secret_name: envScopedName,
  });
  if (primaryError) return { value: null, error: primaryError };
  if (primary != null) return { value: primary as string, error: null };

  const legacyName = envVarLegacyVaultName(appId, key);
  const { data: legacy, error: legacyError } = await supabase.rpc("read_secret", {
    secret_name: legacyName,
  });
  if (legacyError) return { value: null, error: legacyError };
  return { value: (legacy as string) ?? null, error: null };
}

/** Read a kind-targeted row's secret. Kind rows are post-feature, so there is
 *  no legacy app-scoped name to fall back to. */
export async function readEnvVarKindSecret(
  appId: string,
  kind: EnvVarTargetKind,
  key: string,
): Promise<{ value: string | null; error: VaultOpError | null }> {
  const supabase = systemClient();
  const { data, error } = await supabase.rpc("read_secret", {
    secret_name: envVarKindVaultName(appId, kind, key),
  });
  if (error) return { value: null, error };
  return { value: (data as string) ?? null, error: null };
}

/** Write a secret under the given scope-derived name. Fails if a secret
 *  already exists under that exact name — use {@link updateEnvVarSecret} to
 *  replace an existing value. Returns the new vault_secret_id. */
export async function writeEnvVarSecret(
  vaultName: string,
  value: string,
): Promise<{ secretId: string | null; error: VaultOpError | null }> {
  const supabase = systemClient();
  const { data, error } = await supabase.rpc("insert_secret", {
    name: vaultName,
    secret: value,
  });
  return { secretId: (data as string) ?? null, error };
}

/** Replace an existing secret's value in place, under its existing name. Unlike
 *  a delete-then-insert pair, this has no window where neither the old nor the
 *  new value is present under `vaultName` — the write either fully succeeds or
 *  leaves the previous value untouched. `found: false` (not an error) means no
 *  secret exists under `vaultName` yet — the migration-window case where a row
 *  is env-scoped but its live secret is still under the legacy name; callers
 *  fall back to {@link writeEnvVarSecret} to create it fresh. */
export async function updateEnvVarSecret(
  vaultName: string,
  value: string,
): Promise<{ found: boolean; error: VaultOpError | null }> {
  const supabase = systemClient();
  const { data, error } = await supabase.rpc("update_secret", {
    secret_name: vaultName,
    secret: value,
  });
  return { found: Boolean(data), error };
}

/** Delete a secret by its scope-derived name. A miss is not an error. */
export async function deleteEnvVarSecret(
  vaultName: string,
): Promise<{ error: VaultOpError | null }> {
  const supabase = systemClient();
  const { error } = await supabase.rpc("delete_secret", { secret_name: vaultName });
  return { error };
}
