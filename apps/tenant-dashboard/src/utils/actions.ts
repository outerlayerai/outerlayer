"use server";

import { revalidatePath } from "next/cache";

import { createSupabaseServerClient } from "@/supabaseServerClient";

/**
 * Purge the Next cache for `path`.
 *
 * Every export of a `"use server"` module is a public POST endpoint, so this was
 * an unauthenticated cache-purge primitive: looping it on `'/'` forces a full
 * server re-render on every request. Cost amplification only — it exposes no
 * data — but it is free to close, and the `/auth/**` middleware exemption meant
 * even a signed-out caller could reach it.
 *
 * A session check is the whole fix: all three call sites
 * (`auth-provider`, `user-list`) run in authenticated UI and pass either a fixed
 * path or the current `pathname`. Silently no-ops rather than throwing, because
 * a revalidate is a cache hint and no caller branches on its outcome.
 */
export async function revalidateServerPath(path: string) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  revalidatePath(path);
}
