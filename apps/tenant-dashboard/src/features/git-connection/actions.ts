"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { authorizedAction } from "@/lib/action-kit";
import type { Database } from "@/types/db";

const setPrCommentsEnabledInput = z.object({
  appId: z.string(),
  value: z.boolean(),
});

/**
 * Toggle whether the PR-session-comment writer is allowed to post/update the
 * bot comment for this app's connected repo. Default is `true` (set by the
 * column default); disabling only stops *future* writes — an already-posted
 * comment is left in place (decision 13 in the pr-session-comment plan),
 * since there is no delete permission and no bulk write into a customer's
 * repo on toggle.
 *
 * Mirrors `setAppPolicyAction`: validate → resolve the URL-tenant context →
 * check the app-scoped `git_connection.update` permission → one
 * tenant-scoped UPDATE through the header-scoped RLS client. The row is only
 * reachable within the header tenant's scope (RLS policy on `git_connection`
 * keyed off `authorized_app_ids('git_connection.update')`), so a spoofed
 * tenant matches no row.
 */
export const setPrCommentsEnabledAction = authorizedAction({
  input: setPrCommentsEnabledInput,
  permission: "git_connection.update",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const db = ctx.db as SupabaseClient<Database>;
    const { error } = await db
      .from("git_connection")
      .update({ pr_comments_enabled: input.value })
      .eq("app_id", input.appId);
    if (error) {
      throw new Error(error.message);
    }
  },
});
