import "server-only";

/**
 * React Server Component (RSC) reads behind the env-vars settings page. Most run
 * under the request tenant's RLS-scoped client (`loadRequestServiceContext`),
 * so a caller without the row's read permission — or outside the tenant —
 * sees an empty/null result rather than an admin-bypassed one.
 * `loadEnvironmentNames` is the documented exception (see
 * `lib/system/resolve-env-scope`). The pages call these server-side and seed
 * their client components; none of the fetches happen on mount.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadRequestServiceContext } from "@/lib/adapters";
import { listEnvironmentNamesAdmin } from "@/lib/system/resolve-env-scope";
import type { Database } from "@/types/db";

import { EnvVarService } from "./env-var-service";
import type { EnvVarRecord } from "./types";

/**
 * Resolve an app's id from its route-param name, on the RLS-scoped request
 * client — the same client every other loader in this file uses, so a
 * caller outside the tenant (or without read access to the app) resolves
 * `null` rather than an admin-bypassed row.
 */
export async function resolveAppIdByName(appName: string): Promise<string | null> {
  const ctx = await loadRequestServiceContext();
  const db = ctx.db as SupabaseClient<Database>;
  const { data: app } = await db.from("app").select("id").eq("name", appName).single();
  return app?.id ?? null;
}

/**
 * Every env-var row for an app — specific-env AND kind-targeted — for the
 * app-level management UI. Scoped by the `env_var.read` RLS
 * policy.
 */
export async function loadEnvVarsForApp(appId: string): Promise<EnvVarRecord[]> {
  const ctx = await loadRequestServiceContext();
  const service = new EnvVarService({ supabase: ctx.db as SupabaseClient<Database> });
  return service.listAll(appId);
}

/**
 * environment_id → name, for labelling specific-env env-var rows. Runs on
 * the service-role client (see `lib/system/resolve-env-scope`) because the
 * env-vars picker permission group does not include `environment.read`;
 * `appId` is already authorized by the caller's `env_var.read`
 * gate.
 */
export async function loadEnvironmentNames(appId: string): Promise<Record<string, string>> {
  return listEnvironmentNamesAdmin(appId);
}
