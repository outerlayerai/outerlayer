import "server-only";

import { SUPABASE_API } from "./config-global";
import { SUPABASE_SECRET_KEY } from "./config-global.server";
import { Database } from "./types/db";
import { createClient } from "@supabase/supabase-js";

export const createSupabaseAdminClient = () => {
  return createClient<Database>(
    `${SUPABASE_API.url}`,
    `${SUPABASE_SECRET_KEY}`,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
};