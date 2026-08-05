"use server";

/**
 * Reads one context file at the connected branch's LIVE remote head via the git
 * provider (not the mirror). Backs the editor's edit-start staleness re-check
 * and the conflict dialog's "reload remote version" action. Gated on
 * `context.read` — it only surfaces content the caller can already read.
 *
 * The connection row reads run under the request-tenant RLS client (`ctx.db`).
 * Provider-secret resolution is the only step that runs with service-role
 * authority, and it stays confined to its named `lib/system` function.
 *
 * A provider call here is deliberate and permitted: the zero-git-call browsing
 * rule exempts save, staleness, resync, and oversize fetches.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import { resolveAppGitProvider } from "@/lib/system/resolve-app-git-provider";
import { isGitProviderError } from "@/lib/adapters/context-git-provider";
import type { ServerActionResponse } from "@/types/server-action";
import type { Database } from "@/types/db";
import { readRemoteContextFileSchema } from "../schemas";

export interface RemoteContextFile {
  /** File content at the live remote head, or `null` when the file no longer exists there (deleted). */
  content: string | null;
  /** Content blob sha at remote head, or `null` when the file is absent. */
  blobSha: string | null;
  /** Commit sha of the connected branch's current remote head, or `null` when unresolved. */
  commitSha: string | null;
}

export const runReadRemoteContextFile = authorizedAction({
  input: readRemoteContextFileSchema,
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<ServerActionResponse<RemoteContextFile>> => {
    const supabase = ctx.db as SupabaseClient<Database>;

    const { data: connection, error: connectionError } = await supabase
      .from("git_connection")
      .select("repository")
      .eq("app_id", input.appId)
      .single();
    if (connectionError || !connection?.repository) {
      return { error: "repo_not_connected" };
    }

    // The connected branch: prefer the branch context is already tracking, fall
    // back to the app's tracked deployment branch.
    const { data: head } = await supabase
      .from("context_head")
      .select("branch")
      .eq("app_id", input.appId)
      .limit(1)
      .maybeSingle();
    let branch = head?.branch;
    if (!branch) {
      const { data: gitBranch } = await supabase
        .from("git_branch")
        .select("branch_name")
        .eq("app_id", input.appId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      branch = gitBranch?.branch_name ?? undefined;
    }
    if (!branch) {
      return { error: "no_tracked_branch" };
    }

    const provider = await resolveAppGitProvider(input.appId);
    if (!provider) {
      return { error: "git_provider_unavailable" };
    }

    const commitSha = await provider.getLatestCommitSha(connection.repository, branch);

    try {
      const file = await provider.getFileContent(connection.repository, input.path, branch);
      return { data: { content: file.content, blobSha: file.sha, commitSha } };
    } catch (err) {
      // Deleted at remote head → the conflict path's `deleted` reason; surface a
      // null blob so the caller can offer "restore as new file".
      if (isGitProviderError(err) && err.code === "FILE_NOT_FOUND") {
        return { data: { content: null, blobSha: null, commitSha } };
      }
      // Any other provider/internal failure: keep the full error in the server
      // log, but hand the client a stable, generic message rather than raw
      // internal or provider error text.
      console.error("[context] remote file read failed:", err);
      throw new Error("remote file read failed");
    }
  },
});
