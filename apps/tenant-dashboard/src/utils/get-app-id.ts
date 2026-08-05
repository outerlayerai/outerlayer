import { cache } from "react";

import { createSupabaseServerClient } from "../supabaseServerClient";

/**
 * Resolves an app's id from its URL `appName` segment, RLS-scoped to apps the
 * current user can read. Returns null when no readable app matches — callers
 * treat that as "no app context" and let their guards handle forbidden /
 * not-found.
 *
 * Wrapped in `React.cache` so a layout and a page rendering in the same
 * request (e.g. the settings layout + a settings page) share one lookup
 * instead of each querying the `app` table. The cache is per server request;
 * it never spans navigations.
 */
export const getAppIdByName = cache(
  async (appName: string | null | undefined): Promise<string | null> => {
    if (!appName) return null;

    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from("app")
      .select("id")
      .eq("name", appName)
      .single();

    return data?.id ?? null;
  }
);
