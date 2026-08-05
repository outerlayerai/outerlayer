import "server-only";

import {
  envTargetOf,
  resolveEnvVarRows,
  type EnvTargetKind,
  type EnvVarTargetKind,
} from "@repo/env-kind";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  readEnvVarKindSecret,
  readEnvVarSecret,
} from "@/lib/system/env-var-secrets";

/** A candidate `env_var` row for precedence resolution. `target_kind`
 *  is narrowed from the DB's `string | null` — the CHECK constraint guarantees
 *  it is a valid {@link EnvVarTargetKind} when non-null. */
type EnvVarScopedRow = {
  key: string;
  target_kind: EnvVarTargetKind | null;
  environment_id: string | null;
};

/**
 * Resolve a concrete environment to its target bucket
 * ('development' | 'preview' | 'promoted') for kind-targeted matching. Null
 * when the env row can't be read — kind rows then don't apply, but
 * specific-env rows still resolve.
 */
async function resolveEnvTarget(
  supabase: ReturnType<typeof getAdminDataClient>,
  appId: string,
  environmentId: string,
): Promise<EnvTargetKind | null> {
  const { data } = await supabase
    .from("environment")
    .select("current_version, is_ephemeral")
    .eq("id", environmentId)
    .eq("app_id", appId)
    .maybeSingle();
  return data ? envTargetOf(data) : null;
}

/**
 * Read a winning row's value using the name pattern for its scope. Mirrors
 * `EnvVarService`'s private helper of the same name (also needed by
 * `getValue`, which stays on the feature) — small enough that a shared
 * export isn't worth a new crossing for one six-line dispatch.
 */
async function readWinnerSecret(
  appId: string,
  environmentId: string,
  row: EnvVarScopedRow,
): Promise<{ value: string | null; error: { message: string } | null }> {
  return row.environment_id != null
    ? readEnvVarSecret(appId, environmentId, row.key)
    : readEnvVarKindSecret(appId, row.target_kind!, row.key);
}

/**
 * Collects the resolved env-var key→value map for an app/environment, used
 * when building a deployment. Merges the environment's specific-env rows
 * with the kind-targeted rows that apply to it (most-specific-wins
 * precedence via `@repo/env-kind`'s `resolveEnvVarRows`), so a fresh preview
 * env inherits the `preview` / `all` vars it was never individually
 * configured with — without which its deployed agent would have no model
 * credentials and could not run.
 *
 * A standalone lift of `EnvVarService.collectAll`'s read path: the merge
 * this performs is infrastructure two non-feature callers (eval-secret
 * resolution, deployment env injection) need at admin authority, not
 * feature-private state, so it lives here rather than being reached through
 * the feature boundary. The feature's CRUD surface (`list`, `set`, `delete`,
 * `getValue`, …) is unchanged and stays in
 * `features/integrations/env-var-service.ts`.
 */
export async function collectEnvVars(
  appId: string,
  environmentId: string,
): Promise<Record<string, string>> {
  const supabase = getAdminDataClient();
  const envTarget = await resolveEnvTarget(supabase, appId, environmentId);

  // Candidates: this env's specific rows + every kind row (filtered to the
  // ones that apply, then deduped by precedence, in resolveEnvVarRows).
  const { data: rows, error } = await supabase
    .from("env_var")
    .select("key, target_kind, environment_id")
    .eq("app_id", appId)
    .or(`environment_id.eq.${environmentId},target_kind.not.is.null`);

  if (error) {
    throw new Error(`Failed to fetch env var list for app ${appId}: ${error.message}`);
  }
  if (!rows?.length) return {};

  const winners = resolveEnvVarRows(rows as EnvVarScopedRow[], environmentId, envTarget);

  const envVars: Record<string, string> = {};
  for (const winner of winners) {
    const { value, error: secretError } = await readWinnerSecret(appId, environmentId, winner);

    if (secretError) {
      // Propagate vault errors — silently omitting a user-configured env var
      // is worse than failing: the deployed machine would silently lack secrets.
      throw new Error(`Vault read failed for env var "${winner.key}": ${secretError.message}`);
    }

    if (value != null) envVars[winner.key] = value;
  }

  return envVars;
}
