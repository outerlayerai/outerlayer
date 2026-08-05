import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

/**
 * One app watching the pushed branch: the sync target plus the display name the
 * check-run summary renders per app.
 */
interface WatchingApp {
  appId: string;
  appName: string;
  tenantId: string;
  branch: string;
}

/**
 * PURE ROUTING for a push (no writes). Returns every app that (a) is connected
 * to the pushed repository AND (b) tracks the pushed branch — repo-connection
 * and tracked-branch matching only, with no side effects. A repo can be shared
 * by more than one app, so this fans out.
 *
 * A push to an untracked branch, or to an unconnected repo, resolves to zero
 * apps — the caller then posts a neutral check and does no sync.
 *
 * A query ERROR is NOT the empty case: it THROWS. An infra fault must not read
 * as "no apps watching" (which would silently skip the sync and complete the
 * check neutral) — `handlePushEvent`'s catch turns the throw into a truthful
 * failed check instead.
 */
export async function resolveWatchingApps(
  admin: SupabaseClient<Database>,
  params: { repository: string; branch: string },
): Promise<WatchingApp[]> {
  const { repository, branch } = params;

  const { data: connections, error: connectionsError } = await admin
    .from("git_connection")
    .select("app_id")
    .eq("repository", repository);
  if (connectionsError) {
    throw new Error(`resolveWatchingApps: git_connection query failed: ${connectionsError.message}`);
  }
  const connectedAppIds = (connections ?? []).map((c) => c.app_id);
  if (connectedAppIds.length === 0) return [];

  const { data: branches, error: branchesError } = await admin
    .from("git_branch")
    .select("app_id, tenant_id, branch_name")
    .in("app_id", connectedAppIds)
    .eq("branch_name", branch);
  if (branchesError) {
    throw new Error(`resolveWatchingApps: git_branch query failed: ${branchesError.message}`);
  }
  if (!branches?.length) return [];

  const { data: apps, error: appsError } = await admin
    .from("app")
    .select("id, name")
    .in(
      "id",
      branches.map((b) => b.app_id),
    );
  if (appsError) {
    throw new Error(`resolveWatchingApps: app query failed: ${appsError.message}`);
  }
  const nameById = new Map((apps ?? []).map((a) => [a.id, a.name]));

  return branches.map((b) => ({
    appId: b.app_id,
    appName: nameById.get(b.app_id) ?? b.app_id,
    tenantId: b.tenant_id,
    branch,
  }));
}
