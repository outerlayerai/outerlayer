import "server-only";

/**
 * Production (Supabase-backed) implementations of the save-service ports.
 * Kept separate from `save-service.ts` so the service itself stays pure/
 * injectable — these are the only files in this lane that touch Supabase or
 * the git-connection loader.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/db";
import { resolveAppGitProvider } from "@/lib/system/resolve-app-git-provider";
import type { GitConnectionPort, MirrorReadPort, PolicyPort } from "./save-service";

export function createGitConnectionPort(
  supabase: SupabaseClient<Database>
): GitConnectionPort {
  return {
    async loadForApp(appId) {
      // `repository` and `branch_name` are read on the INJECTED client, so a
      // caller holding an RLS-scoped client still gets tenant-scoped reads — a
      // non-member resolves nothing and this returns null before any credential
      // is touched. That read is the tenancy gate for this port.
      const { data: connection, error: connError } = await supabase
        .from("git_connection")
        .select("repository")
        .match({ app_id: appId })
        .single();
      if (connError || !connection?.repository) return null;

      const { data: branch, error: branchError } = await supabase
        .from("git_branch")
        .select("branch_name")
        .match({ app_id: appId })
        .single();
      if (branchError || !branch?.branch_name) return null;

      // The provider reads the connection row, which is system-layer state, so
      // it is built through the named helper rather than the injected client.
      // Ordering is deliberate: tenancy is decided by the reads above, and only
      // then is the connection resolved.
      const provider = await resolveAppGitProvider(appId);
      if (!provider) return null;

      return { provider, repository: connection.repository, branch: branch.branch_name };
    },
  };
}

export function createPolicyPort(supabase: SupabaseClient<Database>): PolicyPort {
  return {
    async loadForApp(appId) {
      const { data } = await supabase
        .from("app")
        .select("require_pull_request")
        .eq("id", appId)
        .single();
      return { requirePullRequest: data?.require_pull_request ?? false };
    },
  };
}

/** Read-only mirror access (`context_head` + `context_tree_entry`) — see scope guard in `save-service.ts`. */
export function createMirrorReadPort(supabase: SupabaseClient<Database>): MirrorReadPort {
  async function currentSnapshotId(appId: string, branch: string): Promise<string | null> {
    const { data } = await supabase
      .from("context_head")
      .select("snapshot_id")
      .match({ app_id: appId, branch })
      .single();
    return data?.snapshot_id ?? null;
  }

  return {
    async headBlobSha(appId, branch, path) {
      const snapshotId = await currentSnapshotId(appId, branch);
      if (!snapshotId) return null;
      const { data } = await supabase
        .from("context_tree_entry")
        .select("blob_sha")
        .match({ snapshot_id: snapshotId, path })
        .maybeSingle();
      return data?.blob_sha ?? null;
    },

    async snapshotPaths(appId, branch, dirPrefix) {
      const snapshotId = await currentSnapshotId(appId, branch);
      if (!snapshotId) return [];
      const prefix = dirPrefix.endsWith("/") ? dirPrefix : `${dirPrefix}/`;
      const { data } = await supabase
        .from("context_tree_entry")
        .select("path")
        .eq("snapshot_id", snapshotId)
        .like("path", `${prefix}%`);
      return (data ?? []).map((row) => row.path);
    },
  };
}
