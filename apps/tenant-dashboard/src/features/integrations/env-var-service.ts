import "server-only";

/**
 * Environment Variable Service
 *
 * Manages encrypted environment variables for managed code deployments.
 * Secret values are stored in Supabase Vault; this service handles CRUD
 * operations on the `env_var` table through the injected client (RLS-scoped
 * for the settings UI) plus vault references (always through
 * `lib/system/env-var-secrets`, the sole sanctioned home for the Vault RPCs).
 * The deployment-build read path — resolving the full env-var map for an
 * app/environment with admin authority — lives in
 * `lib/system/collect-env-vars.ts`, a caller outside the integrations
 * settings UI that this service's CRUD surface has no reason to serve.
 *
 * Env vars are scoped per environment. The `env_var.environment_id`
 * column is `NOT NULL`, so `list`, `getValue`, `set`, and `delete` all require
 * the caller to pass the selected environment's id; there is no app-default
 * fallback. The vault secret name is keyed by `environment_id` so the same
 * `key` can hold a distinct value in each environment.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type EnvVarTargetKind,
  envVarVaultName,
} from "@repo/env-kind";
import type { Database } from "@/types/db";
import { isReservedEnvVar, RESERVED_ENV_VAR_MESSAGE } from "@/lib/environments/reserved-env-vars";
import {
  deleteEnvVarSecret,
  readEnvVarKindSecret,
  readEnvVarSecret,
  updateEnvVarSecret,
  writeEnvVarSecret,
} from "@/lib/system/env-var-secrets";
import { environmentBelongsToAppAdmin } from "@/lib/system/resolve-env-scope";
import type { EnvVarListItem, EnvVarRecord, EnvVarScope } from "./types";

/** A candidate `env_var` row for precedence resolution. `target_kind`
 *  is narrowed from the DB's `string | null` — the CHECK constraint guarantees
 *  it is a valid {@link EnvVarTargetKind} when non-null. */
type EnvVarScopedRow = {
  key: string;
  target_kind: EnvVarTargetKind | null;
  environment_id: string | null;
};

type SupabaseClientType = SupabaseClient<Database>;

interface EnvVarServiceDeps {
  supabase: SupabaseClientType;
}

/**
 * Service for managing deployment environment variables.
 *
 * Responsibilities:
 * - List env var keys (never exposes values by default)
 * - Create/update env vars with vault-backed secret storage
 * - Delete env vars and their vault secrets
 * - Read individual secret values (for "reveal" UI)
 */
export class EnvVarService {
  constructor(private deps: EnvVarServiceDeps) {}

  /**
   * List all env var keys for an environment (no values returned).
   */
  async list(appId: string, environmentId: string): Promise<EnvVarListItem[]> {
    const { data, error } = await this.deps.supabase
      .from("env_var")
      .select("id, key, created_at, updated_at")
      .eq("app_id", appId)
      .eq("environment_id", environmentId)
      .order("key");

    if (error) throw error;
    return (data ?? []) as EnvVarListItem[];
  }

  /**
   * List every env-var row for an app — specific-env AND kind-targeted — for
   * the app-level management UI. Values are never returned.
   */
  async listAll(appId: string): Promise<EnvVarRecord[]> {
    const { data, error } = await this.deps.supabase
      .from("env_var")
      .select("id, key, environment_id, target_kind, created_at, updated_at")
      .eq("app_id", appId)
      .order("key");

    if (error) throw error;
    return (data ?? []) as EnvVarRecord[];
  }

  /** The Vault secret name for a scope. */
  private scopeVaultName(appId: string, scope: EnvVarScope, key: string): string {
    return envVarVaultName(appId, scope, key);
  }

  /** Derive the {@link EnvVarScope} from a stored row's columns. */
  private rowScope(row: { environment_id: string | null; target_kind: string | null }): EnvVarScope {
    return row.environment_id != null
      ? { environmentId: row.environment_id }
      : { targetKind: row.target_kind as EnvVarTargetKind };
  }

  /**
   * Create or update an env var for a scope (a specific environment OR a kind).
   * The value is stored in Supabase Vault under a scope-derived name, so the
   * same `key` holds an independent value per environment and per kind.
   *
   * Key format: uppercase letters, digits, and underscores, starting with a letter.
   */
  async set(
    appId: string,
    scope: EnvVarScope,
    tenantId: string,
    key: string,
    value: string,
  ): Promise<{ id: string; key: string }> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        "Key must be uppercase letters, digits, and underscores, starting with a letter",
      );
    }

    if (isReservedEnvVar(key)) {
      throw new Error(RESERVED_ENV_VAR_MESSAGE);
    }

    // For the specific-env scope, the environment must be confirmed to belong
    // to appId before anything is written, so a persisted row can never carry a
    // mismatched (app_id, environment_id) pair. Runs on the service-role
    // client (`lib/system/resolve-env-scope`) because the env-vars picker
    // permission group does not include `environment.read`; appId is already
    // authorized by the caller's action gate, so this only confirms
    // membership within an already-authorized app.
    if (scope.environmentId != null) {
      const belongsToApp = await environmentBelongsToAppAdmin(appId, scope.environmentId);
      if (!belongsToApp) {
        throw new Error(
          `Environment ${scope.environmentId} does not belong to app ${appId}; refusing env-var write.`,
        );
      }
    }

    const vaultName = this.scopeVaultName(appId, scope, key);

    // Check if the key already exists for this exact scope.
    const existingQuery = this.deps.supabase
      .from("env_var")
      .select("id, vault_secret_id")
      .eq("app_id", appId)
      .eq("key", key);
    const { data: existing } = await (scope.environmentId != null
      ? existingQuery.eq("environment_id", scope.environmentId)
      : existingQuery.eq("target_kind", scope.targetKind)
    ).maybeSingle();

    if (existing) {
      // Update in place under the existing scope-derived name — never a
      // delete followed by a write. A delete-then-write pair against a
      // deterministic name has a window where the old value is already gone
      // and the new one is not yet there; a failure in that window is silent
      // data loss, not a no-op. `found: false` means the row exists but its
      // live secret is still under the legacy name — fall back to a plain
      // write, which creates it fresh under the scope-derived name.
      const { found, error: updateVaultError } = await updateEnvVarSecret(vaultName, value);
      if (updateVaultError) {
        throw new Error(
          `Failed to store secret in vault for key "${key}" (app ${appId}): ${updateVaultError.message}`,
        );
      }
      // The update-in-place leg keeps the row's existing vault_secret_id (the
      // secret was replaced under its existing id, not recreated). The
      // legacy-fallback leg creates a BRAND NEW secret under the scope-derived
      // name — its id must replace the stale one the row still carries from
      // the legacy secret, or the column would keep pointing at an id that no
      // longer corresponds to this row's live secret.
      let vaultSecretId = existing.vault_secret_id;
      if (!found) {
        const { secretId, error: writeError } = await writeEnvVarSecret(vaultName, value);
        if (writeError || !secretId) {
          const detail = writeError?.message ?? "no secret ID returned";
          throw new Error(`Failed to store secret in vault for key "${key}" (app ${appId}): ${detail}`);
        }
        vaultSecretId = secretId;
      }

      // `.select()` so an RLS-filtered UPDATE surfaces as an empty result
      // rather than the silent `error: null` / 0-row response Supabase
      // returns for a policy-refused write.
      const { data: updatedRows, error: updateError } = await this.deps.supabase
        .from("env_var")
        .update({ vault_secret_id: vaultSecretId })
        .eq("id", existing.id)
        .select("id");

      if (updateError) throw updateError;
      if (!updatedRows || updatedRows.length === 0) {
        throw new Error(
          `Env var update for key "${key}" (app ${appId}) was not applied — the row update matched no rows.`,
        );
      }

      return { id: existing.id, key };
    }

    // Insert new
    const { secretId, error: vaultInsertError } = await writeEnvVarSecret(vaultName, value);

    if (vaultInsertError || !secretId) {
      const detail = vaultInsertError?.message ?? "no secret ID returned";
      throw new Error(`Failed to store secret in vault for key "${key}" (app ${appId}): ${detail}`);
    }

    const { data, error } = await this.deps.supabase
      .from("env_var")
      .insert({
        app_id: appId,
        tenant_id: tenantId,
        key,
        vault_secret_id: secretId,
        // Exactly one of environment_id / target_kind, per the CHECK constraint.
        environment_id: scope.environmentId ?? null,
        target_kind: scope.targetKind ?? null,
      })
      .select("id, key")
      .single();

    if (error) {
      // The row insert can still be refused (RLS, unique constraint) after
      // the vault write above. Clean up the just-written secret so a refused
      // insert never orphans it under this scope's deterministic name — an
      // orphan would silently brick every later legitimate create for the
      // same key/scope ("Failed to store secret in vault").
      await deleteEnvVarSecret(vaultName);
      throw error;
    }
    return data!;
  }

  /**
   * Delete an env var and its vault secret by row id. The scope (specific env
   * or kind) is read from the row, so a sibling scope's same-key var is never
   * affected.
   */
  async delete(appId: string, envVarId: string): Promise<void> {
    const { data, error: lookupError } = await this.deps.supabase
      .from("env_var")
      .select("key, environment_id, target_kind")
      .eq("id", envVarId)
      .eq("app_id", appId)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!data) return;

    await deleteEnvVarSecret(this.scopeVaultName(appId, this.rowScope(data), data.key));

    const { error } = await this.deps.supabase
      .from("env_var")
      .delete()
      .eq("id", envVarId);

    if (error) throw error;
  }

  /**
   * Read a single env var value from vault (for the UI "reveal" feature). The
   * scope (specific env or kind) is read from the row.
   */
  async getValue(appId: string, envVarId: string): Promise<string | null> {
    const { data } = await this.deps.supabase
      .from("env_var")
      .select("key, environment_id, target_kind")
      .eq("id", envVarId)
      .eq("app_id", appId)
      .maybeSingle();

    if (!data) return null;

    // readWinnerSecret picks the env-scoped (+ legacy fallback) or kind name
    // based on the row's scope; environmentId is only used on the env path.
    const { value, error: secretError } = await this.readWinnerSecret(appId, data.environment_id ?? "", {
      key: data.key,
      environment_id: data.environment_id,
      target_kind: data.target_kind as EnvVarTargetKind | null,
    });

    if (secretError) {
      throw new Error(`Failed to read secret for env var "${data.key}" (app ${appId}): ${secretError.message}`);
    }

    return value;
  }

  /** Read a winning row's value using the name pattern for its scope. */
  private async readWinnerSecret(
    appId: string,
    environmentId: string,
    row: EnvVarScopedRow,
  ): Promise<{ value: string | null; error: { message: string } | null }> {
    return row.environment_id != null
      ? readEnvVarSecret(appId, environmentId, row.key)
      : readEnvVarKindSecret(appId, row.target_kind!, row.key);
  }
}
