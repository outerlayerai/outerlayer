import "server-only";

/**
 * Admin-client env resolution — the documented exception where env lookups
 * run on the service-role client instead of the caller's RLS-scoped one.
 *
 * Several integrations sections (webhook, env vars) are gated on their own
 * table's `.read` permission alone; a custom role holding that permission but
 * not `environment.read` would have any `environment` lookup return
 * null/empty under RLS. Each lookup here is pure identifier resolution or
 * membership confirmation (not an authorization decision — the caller is
 * already permission-gated on its own table), and every query is scoped to
 * an `appId` the caller was already authorized against, so running on the
 * service-role client resolves within an already-authorized app rather than
 * widening tenancy.
 */

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY } from "@/config-global.server";
import { resolveEnvIdForStorage } from "@/lib/environments/env-scope";

function adminClient() {
  return createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** {@link resolveEnvIdForStorage}, run on the service-role client. */
export async function resolveEnvIdForStorageAdmin(
  appId: string,
  ref: { envId?: string | null; envName?: string | null },
): Promise<{ envId: string; envName: string } | null> {
  return resolveEnvIdForStorage(adminClient(), appId, ref);
}

/** environment_id → name for every environment on an app, run on the
 *  service-role client (see module doc for why). */
export async function listEnvironmentNamesAdmin(appId: string): Promise<Record<string, string>> {
  const { data } = await adminClient().from("environment").select("id, name").eq("app_id", appId);
  const names: Record<string, string> = {};
  for (const row of data ?? []) names[row.id] = row.name;
  return names;
}

/**
 * Whether `environmentId` belongs to `appId`, run on the service-role client
 * (see module doc for why). A direct query rather than a call through
 * {@link resolveEnvIdForStorageAdmin} — that helper collapses a DB error and
 * a genuine "no such row" into the same `null`, which is right for its own
 * callers (identifier resolution degrades to "not found" either way) but
 * wrong here: this function's `false` return is read as "refuse the write",
 * so a transient lookup error must not be reported the same way as an actual
 * ownership mismatch. Throws on a lookup error instead of returning `false`.
 */
export async function environmentBelongsToAppAdmin(
  appId: string,
  environmentId: string,
): Promise<boolean> {
  const { data, error } = await adminClient()
    .from("environment")
    .select("id")
    .eq("id", environmentId)
    .eq("app_id", appId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify environment ownership: ${error.message}`);
  }
  return data !== null;
}
