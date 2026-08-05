import "server-only";

import { cache } from "react";
import { createSupabaseServerClient } from "../supabaseServerClient";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";

export interface OrgAppRow {
  id: string;
  name: string;
  display_name: string | null;
}

/**
 * Server-side companion to the (removed) browser breadcrumb app-list query:
 * lists the apps visible to the caller within the request tenant, so the
 * `[appName]` layout can seed `AppSelect` once instead of the client running
 * its own SWR-backed Supabase query.
 *
 * Wrapped in `React.cache` so a layout and its pages share one read per
 * request; the cache never spans requests.
 */
export const listOrgApps = cache(
  async (): Promise<OrgAppRow[]> => {
    const supabase = await createSupabaseServerClient(await getRequestTenantId());
    const { data } = await supabase
      .from("app")
      .select("id, name, display_name")
      .order("name", { ascending: true });

    return (data as OrgAppRow[] | null) ?? [];
  }
);
