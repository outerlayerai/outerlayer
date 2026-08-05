import "server-only";

/**
 * Env-scope resolution for per-env storage writes.
 *
 * The dashboard's settings surfaces (env vars, API keys) carry
 * `environment_id` foreign keys, so every env —
 * including the default `dev` env — must resolve to a concrete row id. This
 * module is the single, server-side source of truth for that resolution:
 * callers pass at most an env *name* or *id* (an identifier, not an
 * authorization claim) and the row is re-resolved against the `environment`
 * table on every request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Identifier a caller may supply to scope a request to an env. At most one
 *  is needed; `envId` wins when both are present. Omitting both resolves to
 *  the default env (no-pin) — today's behavior. */
interface EnvScopeRef {
  envId?: string | null;
  envName?: string | null;
}

/**
 * Resolves the breadcrumb-selected env to a concrete `environment.id` for
 * **storage callers** — env vars and the like. These tables carry
 * `environment_id NOT NULL` foreign keys, so every env (including the default
 * `dev` env) must yield a row id.
 *
 * Resolution order:
 *   1. If `ref.envId` is present, look up that row by id (within `appId`).
 *   2. Otherwise, if `ref.envName` is present, look up by name.
 *   3. Otherwise (no `?env=` at all), return the default env's id
 *      (`is_default=true`).
 *
 * Returns `null` only when the env could not be resolved (stale `?env=`,
 * cross-tenant filtered out by RLS, transient DB error). Callers should
 * surface a user-facing "could not resolve environment" state.
 */
export async function resolveEnvIdForStorage(
  supabase: SupabaseClient,
  appId: string,
  ref: EnvScopeRef,
): Promise<{ envId: string; envName: string } | null> {
  const trimmedName = ref.envName?.trim();

  // (1) / (2) — explicit identifier supplied via `?env=` (id or name).
  if (ref.envId || trimmedName) {
    let query = supabase
      .from("environment")
      .select("id, name")
      .eq("app_id", appId);

    query = ref.envId
      ? query.eq("id", ref.envId)
      : query.eq("name", trimmedName as string);

    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;

    const row = data as { id: string; name: string };
    return { envId: row.id, envName: row.name };
  }

  // (3) — no identifier supplied; fall back to the app's default env row.
  // Unlike `resolveEnvScopeForContent`, we MUST return a real row id here:
  // storage callers need a concrete `environment_id` foreign key.
  const { data, error } = await supabase
    .from("environment")
    .select("id, name")
    .eq("app_id", appId)
    .eq("is_default", true)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { id: string; name: string };
  return { envId: row.id, envName: row.name };
}

