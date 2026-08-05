import "server-only";

/**
 * AppsService — the apps-list read for the org's apps page.
 *
 * Runs through the caller's RLS-scoped `ctx.db`, so a tenant outside the
 * caller's membership resolves to an empty list, never an error — fail-closed
 * by construction, not by an app-side filter.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";
import type { GitProviderType } from "@/lib/adapters/git-provider-type";

import type { AppWithGitConnection } from "./types";

/**
 * Explicit projection — only the columns the list renders, never `select("*")`.
 * Each embed names its foreign key explicitly. Every child table has a
 * second `(tenant_id, app_id)` composite FK alongside the original
 * `app_id`-only FK, so an unhinted embed is ambiguous and PostgREST refuses
 * to guess between them. Dropping a `!<fk_name>` hint is a runtime failure
 * the type system won't catch.
 */
const APPS_LIST_SELECT =
  "id, name, display_name, created_at, updated_at, " +
  "git_connection!git_connection_app_id_fkey(app_id, installation_id, repository, provider), " +
  "git_branch!github_branch_app_id_fkey(app_id, branch_name), " +
  "environment!environment_app_id_fkey(name, is_default, current_version)";

interface AppListRow {
  id: string;
  name: string;
  display_name: string | null;
  created_at: string;
  updated_at: string | null;
  git_connection: Array<{
    app_id: string;
    installation_id: string | null;
    repository: string | null;
    provider: string | null;
  }>;
  git_branch: Array<{ app_id: string; branch_name: string }>;
  environment: Array<{ name: string; is_default: boolean; current_version: number }>;
}

/**
 * The returned object carries only the projected columns —
 * `AppWithGitConnection` is the list-consumer's full shape (`App & {...}`)
 * for compatibility with existing call sites, but a field the list doesn't
 * render (e.g. `tenant_id`, `runtime`) is deliberately absent at runtime,
 * hence the `unknown` cast rather than a direct `App` literal.
 */
function toAppWithGitConnection(row: AppListRow): AppWithGitConnection {
  const currentConnection = row.git_connection[0];
  const provider = (currentConnection?.provider as GitProviderType) || null;
  const connectedBranch = row.git_branch?.[0]?.branch_name;

  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    isGitConnected: Boolean(currentConnection?.installation_id),
    provider,
    repository: currentConnection?.repository || null,
    connectedBranch,
    environments: row.environment ?? [],
  } as unknown as AppWithGitConnection;
}

class AppsService {
  private table(ctx: ServiceContext) {
    return (ctx.db as SupabaseClient).from("app");
  }

  /** The apps list + each app's git connection / environments, newest-first. */
  async listAppsWithGitStatus(ctx: ServiceContext): Promise<AppWithGitConnection[]> {
    const { data, error } = await this.table(ctx)
      .select(APPS_LIST_SELECT)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`list app failed: ${error.message}`);
    return ((data ?? []) as unknown as AppListRow[]).map(toAppWithGitConnection);
  }
}

export const appsService = new AppsService();
