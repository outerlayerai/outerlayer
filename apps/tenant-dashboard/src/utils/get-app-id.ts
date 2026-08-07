import { cache } from "react";

import { createSupabaseServerClient } from "../supabaseServerClient";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";

/**
 * Resolves an app's id from its URL `appName` segment, RLS-scoped to apps the
 * current user can read. Returns null when no readable app matches — callers
 * treat that as "no app context" and let their guards handle forbidden /
 * not-found.
 *
 * The client must carry the URL-derived request tenant: without the header,
 * RLS falls back to the JWT's tenant claim, which can name a different org
 * than the one on screen (e.g. right after creating a new org) — making the
 * app invisible here even though the user can read it.
 *
 * Wrapped in `React.cache` so a layout and a page rendering in the same
 * request (e.g. the settings layout + a settings page) share one lookup
 * instead of each querying the `app` table. The cache is per server request;
 * it never spans navigations.
 */
export const getAppIdByName = cache(
  async (appName: string | null | undefined): Promise<string | null> => {
    if (!appName) return null;

    const supabase = await createSupabaseServerClient(await getRequestTenantId());
    const { data } = await supabase
      .from("app")
      .select("id")
      .eq("name", appName)
      .single();

    return data?.id ?? null;
  }
);
