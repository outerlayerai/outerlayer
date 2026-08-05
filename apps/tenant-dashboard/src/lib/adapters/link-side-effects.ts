import "server-only";

/**
 * Adapter bridge for the repo-link flow's post-link side effects, which the
 * legacy `services/context-sync`, `services/git/commit-pointers`, and
 * `services/pr-tracking` trees still own. Each export builds its own
 * service-role client, since the mirror write, the commit-pointer advance,
 * and the `pull_request` writes are all service_role-only under RLS. Grouped
 * here because all three fire from the same link action.
 */

import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import * as Sentry from "@/lib/observability/error-reporting/sentry";
import {
  buildContextSync,
  createSupabaseContextMirrorPort,
} from "@/lib/system/context-sync";
import { advanceCommitPointers } from "@/lib/system/git/commit-pointers";
import { backfillPullRequests } from "@/lib/system/pr-tracking/backfill";
import {
  ENRICHMENT_LINK_LIMIT,
  enrichPullRequestsForConnection,
} from "@/lib/system/pr-tracking/enrichment-backfill";
import { serverLogger } from "@/lib/observability/server-logger";
import type { GitProvider } from "@/lib/system/git";

interface RunContextMirrorInitialSyncParams {
  appId: string;
  tenantId: string;
  repo: string;
  branch: string;
  gitProvider: GitProvider;
}

/**
 * Never throws: a failed sync leaves the mirror in "not synced yet" state,
 * which self-heals on the next push or a manual resync — it must not fail
 * the repo-link flow that triggers it.
 */
export async function runContextMirrorInitialSync(
  params: RunContextMirrorInitialSyncParams,
): Promise<void> {
  Sentry.setTag("git.provider", params.gitProvider.type);

  const admin = createSupabaseAdminClient();
  try {
    const contextSync = buildContextSync({
      db: createSupabaseContextMirrorPort(admin),
      git: params.gitProvider,
    });
    const outcome = await contextSync.initialSync({
      appId: params.appId,
      tenantId: params.tenantId,
      repo: params.repo,
      branch: params.branch,
    });
    if (outcome.kind === "failed") {
      await serverLogger
        .withAppId(params.appId)
        .error(new Error(`[Context Sync] initial sync failed: ${outcome.error}`));
    } else if (outcome.commitSha) {
      // Advance the commit pointers to the SHA the mirror actually
      // materialized. On a failed sync we leave the gateway's seed in
      // place; the link flow still reports success and points the user
      // at the Context tab's sync state.
      await advanceCommitPointers(admin, { appId: params.appId, commitSha: outcome.commitSha });
    }
  } catch (err) {
    await serverLogger
      .withAppId(params.appId)
      .error(err instanceof Error ? err : new Error(`[Context Sync] ${String(err)}`));
  }
}

interface RunPullRequestBackfillParams {
  appId: string;
  tenantId: string;
  repository: string;
  provider: GitProvider;
}

/**
 * Non-fatal by design: the fleet PR metrics want lifecycle history at
 * connect time (webhooks only see events from then on), but a backfill
 * failure must never fail the repo-link flow that triggers it.
 */
export async function runPullRequestBackfill(params: RunPullRequestBackfillParams): Promise<void> {
  const backfill = await backfillPullRequests({
    supabase: createSupabaseAdminClient(),
    provider: params.provider,
    appId: params.appId,
    tenantId: params.tenantId,
    repository: params.repository,
  });
  if ("error" in backfill) {
    await serverLogger
      .withAppId(params.appId)
      .error(new Error(`[PR Backfill] ${backfill.error}`));
  }
}

interface RunPullRequestEnrichmentParams {
  appId: string;
  repository: string;
  provider: GitProvider;
}

/**
 * Non-fatal by design and meant to run past the response (the caller
 * schedules this via `after()`): the per-PR API reads are the slow part of
 * linking, and every write here is guarded + idempotent, so a run cut short
 * by the function window leaves no damage — the next link or the one-shot
 * backfill route picks up the remainder.
 */
export async function runPullRequestEnrichment(params: RunPullRequestEnrichmentParams): Promise<void> {
  try {
    const enrichment = await enrichPullRequestsForConnection({
      supabase: createSupabaseAdminClient(),
      provider: params.provider,
      appId: params.appId,
      repository: params.repository,
      limit: ENRICHMENT_LINK_LIMIT,
    });
    for (const enrichmentError of enrichment.errors) {
      await serverLogger
        .withAppId(params.appId)
        .error(new Error(`[PR Enrichment] ${enrichmentError}`));
    }
  } catch (error) {
    await serverLogger
      .withAppId(params.appId)
      .error(new Error(`[PR Enrichment] ${error instanceof Error ? error.message : String(error)}`));
  }
}
