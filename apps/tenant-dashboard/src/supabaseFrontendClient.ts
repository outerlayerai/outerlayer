import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_API } from "./config-global";
import { Database } from "./types/db";

// ----------------------------------------------------------------------
export function createSupabaseFontendClient() {
  return createBrowserClient<Database>(
    `${SUPABASE_API.url}`,
    `${SUPABASE_API.key}`
  );
}