import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

/**
 * Advance the two trace-stamping commit pointers to `commitSha`:
 *
 *   1. `app.commit_sha` — the app's recorded HEAD.
 *   2. the DEFAULT env's `environment.current_commit_sha` — the live-HEAD
 *      signal the gateway's env-resolver reads to stamp server-controlled
 *      commit SHAs on traces/scores.
 *
 * Called from the three git trigger sites — link, push, and manual resync — so
 * traces stamp against the true code state regardless of which path advanced
 * it. Deliberately scoped to the default env (`is_default = true`): a non-
 * default env carries its own pointers and must not be clobbered here.
 *
 * Best-effort, like the sync it accompanies: a pointer write is issued under
 * the service-role admin client (RLS-bypassing), and the caller decides
 * whether a failure is fatal (link/push treat it as non-fatal — the sync event
 * and the mirror are the source of truth).
 */
export async function advanceCommitPointers(
  supabase: SupabaseClient<Database>,
  params: { appId: string; commitSha: string },
): Promise<void> {
  const { appId, commitSha } = params;

  await supabase.from("app").update({ commit_sha: commitSha }).eq("id", appId);

  await supabase
    .from("environment")
    .update({ current_commit_sha: commitSha })
    .eq("app_id", appId)
    .eq("is_default", true);
}
