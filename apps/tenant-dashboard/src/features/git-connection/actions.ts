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
 * bot comment for this app's connected repo. The feature is OPT-IN: the
 * column defaults to `false`, so every already-connected repo stays silent
 * until someone turns this on. Do not "fix" that to `true` — the comment is
 * world-readable on a public repo, and flipping the default would start
 * writing into every connected customer repo at once.
 *
 * Disabling only stops *future* writes — an already-posted comment is left
 * in place, since there is no delete permission and no bulk write into a
 * customer's repo on toggle.
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
      .eq("app_id", input.appId)
      // The settings toggle is already hidden for non-GitHub connections,
      // but that is presentation. This is the boundary: the flag only means
      // anything to the GitHub App writer, so a legacy `provider='gitlab'`
      // row must not be settable to a state it can never honour. Matches the
      // 409 `unsupported_git_provider` posture the git routes already take.
      .eq("provider", "github");
    if (error) {
      throw new Error(error.message);
    }
  },
});
