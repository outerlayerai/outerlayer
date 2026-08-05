import "server-only";

/**
 * The resync operation `resync-context-action.ts` calls. Resync means ALL
 * git-derived data, not just the context mirror: it also heals the
 * PR-lifecycle history (missing rows) and its enrichment (diff size,
 * first-pass CI verdicts) — both best-effort, so a metrics hiccup never
 * fails the mirror recovery the caller exists to provide.
 *
 * Runs entirely under the service-role client: the connection/branch reads
 * and the mirror/pointer/PR-backfill writes all touch rows the resync
 * algorithm and pointer advance own outright, not rows scoped to the
 * caller's own reads. `getAdminDataClient` is confined to `src/lib/system/**`,
 * which is why this lives here rather than in the feature action that calls
 * it — that action can only take the outcome, never construct the client.
 */
import { getAdminDataClient } from "@/lib/system/admin-client";
import { createGitProviderForApp } from "@/lib/system/git";
import { advanceCommitPointers } from "@/lib/system/git/commit-pointers";
import type { ServerActionResponse } from "@/types/server-action";
import { buildContextSync, createSupabaseContextMirrorPort } from "@/lib/system/context-sync";
import type { SyncOutcome } from "@repo/context-sync";
import { serverLogger } from "@/lib/observability/server-logger";
import { backfillPullRequests } from "@/lib/system/pr-tracking/backfill";
import {
  ENRICHMENT_LINK_LIMIT,
  enrichPullRequestsForConnection,
} from "@/lib/system/pr-tracking/enrichment-backfill";

export async function resyncContext(appId: string): Promise<ServerActionResponse<SyncOutcome>> {
  const admin = getAdminDataClient();

  const { data: connection, error: connectionError } = await admin
    .from("git_connection")
    .select("repository, tenant_id")
    .eq("app_id", appId)
    .single();

  if (connectionError || !connection?.repository) {
    return { error: "repo_not_connected" };
  }

  // Prefer the branch context is already tracking (the connected branch,
  // established by the last successful sync); fall back to the app's
  // tracked deployment branch when context has never synced yet.
  const { data: head } = await admin
    .from("context_head")
    .select("branch")
    .eq("app_id", appId)
    .limit(1)
    .maybeSingle();

  let branch = head?.branch;
  if (!branch) {
    const { data: gitBranch } = await admin
      .from("git_branch")
      .select("branch_name")
      .eq("app_id", appId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    branch = gitBranch?.branch_name ?? undefined;
  }

  if (!branch) {
    return { error: "no_tracked_branch" };
  }

  const provider = await createGitProviderForApp(admin, appId);
  if (!provider) {
    return { error: "git_provider_unavailable" };
  }

  const contextSync = buildContextSync({
    db: createSupabaseContextMirrorPort(admin),
    git: provider,
  });

  const outcome = await contextSync.resync({
    appId,
    tenantId: connection.tenant_id,
    repo: connection.repository,
    branch,
  });

  if (outcome.kind === "failed") {
    return { error: outcome.error ?? "resync_failed" };
  }

  // Advance the trace-stamping pointers to the resynced HEAD. Resync exists
  // to recover after a webhook outage, when the mirror AND the pointers have
  // drifted; refreshing only the mirror would leave traces/scores stamping a
  // stale SHA.
  if (outcome.commitSha) {
    await advanceCommitPointers(admin, { appId, commitSha: outcome.commitSha });
  }

  // The same webhook outage that drifted the mirror also dropped PR events,
  // so resync heals the PR plane too: lifecycle rows first, then the
  // API-read enrichment (diff size + first-pass CI). Same non-fatal
  // contract as the link flow — the mirror recovery above already succeeded.
  try {
    const backfill = await backfillPullRequests({
      supabase: admin,
      provider,
      appId,
      tenantId: connection.tenant_id,
      repository: connection.repository,
    });
    if ("error" in backfill) {
      await serverLogger
        .withAppId(appId)
        .error(new Error(`[PR Backfill] ${backfill.error}`));
    }
    const enrichment = await enrichPullRequestsForConnection({
      supabase: admin,
      provider,
      appId,
      repository: connection.repository,
      limit: ENRICHMENT_LINK_LIMIT,
    });
    for (const enrichmentError of enrichment.errors) {
      await serverLogger
        .withAppId(appId)
        .error(new Error(`[PR Enrichment] ${enrichmentError}`));
    }
  } catch (err) {
    await serverLogger
      .withAppId(appId)
      .error(err instanceof Error ? err : new Error(`[PR Enrichment] ${String(err)}`));
  }

  return { data: outcome };
}
