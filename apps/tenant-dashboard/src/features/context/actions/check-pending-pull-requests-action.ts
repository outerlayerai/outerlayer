"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizedAction } from "../../../lib/action-kit";
import { Permissions } from "../../../utils/permissions";
import type { Database } from "../../../types/db";
import { checkPendingPullRequestsSchema } from "../schemas";

export interface PendingPullRequestsCheck {
  /** PR numbers, from the input, that have since merged or closed — no longer "pending". */
  decided: number[];
}

/**
 * Which of `prNumbers` (an app's currently-pending publish PRs) have since
 * been decided — merged or closed — so the caller can drop their tree's
 * "pending PR" tag. Reads the `pull_request` table, kept live by the
 * GitHub webhooks and healed by `backfillPullRequests` on every
 * resync — NOT the mirror's head advancing, which is not a safe signal on its
 * own (an unrelated commit can advance head while this PR is still open).
 */
export const runCheckPendingPullRequests = authorizedAction({
  input: checkPendingPullRequestsSchema,
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<PendingPullRequestsCheck> => {
    if (input.prNumbers.length === 0) return { decided: [] };
    const supabase = ctx.db as SupabaseClient<Database>;
    const { data, error } = await supabase
      .from("pull_request")
      .select("pr_number, state")
      .eq("app_id", input.appId)
      .in("pr_number", input.prNumbers)
      .neq("state", "open");
    if (error) throw new Error(error.message);
    return { decided: (data ?? []).map((row) => row.pr_number) };
  },
});
