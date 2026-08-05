import "server-only";

import { cache } from "react";
import type { QueryData, SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "../supabaseServerClient";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import type { Database } from "../types/db";

// Each embed names its foreign key explicitly. Two keys now relate these tables
// to app — the original app_id one and the composite (tenant_id, app_id) that
// enforces tenant/app consistency — so an unhinted embed is ambiguous and
// PostgREST refuses to guess. Shared so the type-derivation query below and the
// real one cannot drift apart.
const APP_WITH_GIT_SELECT =
  "*, git_connection!git_connection_app_id_fkey(app_id, repository, provider), git_branch!github_branch_app_id_fkey(branch_name)" as const;

// Referenced only via `typeof` for the `AppWithGitConnection` type below — the
// function is never called, so no client is constructed to derive the shape.
function _buildAppByNameQuery(supabase: SupabaseClient<Database>) {
  return supabase
    .from("app")
    .select(APP_WITH_GIT_SELECT)
    .eq("name", "")
    .single();
}

export type AppWithGitConnection = QueryData<ReturnType<typeof _buildAppByNameQuery>>;

/**
 * Server-side companion to the (removed) browser app-context query: resolves
 * the current app's row — with its git connection/branch — under the request
 * tenant, so the `[appName]` layout can seed `AppContext` once instead of the
 * client opening its own Supabase query.
 *
 * Wrapped in `React.cache` so a layout and its pages share one read per
 * request; the cache never spans requests.
 */
export const getAppByName = cache(
  async (appName: string | null | undefined): Promise<AppWithGitConnection | null> => {
    if (!appName) return null;

    const supabase = await createSupabaseServerClient(await getRequestTenantId());
    const { data } = await supabase
      .from("app")
      .select(APP_WITH_GIT_SELECT)
      .eq("name", appName)
      .single();

    return (data as AppWithGitConnection | null) ?? null;
  }
);
