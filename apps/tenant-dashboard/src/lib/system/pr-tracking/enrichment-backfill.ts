import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { createGitProviderForApp } from "@/lib/system/git";
import type { GitProvider } from "@/lib/system/git/git-provider.interface";
import { GitHubProvider } from "@/lib/system/git/github/client";
import type { Database } from "@/types/db";
import { PULL_REQUEST_TABLE } from "./constants";

/**
 * API-read enrichment of `pull_request` rows: diff size and the first-pass
 * CI verdict for PRs that predate their webhook capture. Both signals are
 * webhook-forward by default, so anything decided before the app was
 * connected (or before the columns shipped) carries NULLs; this fills them
 * from the provider APIs — the Checks/pipelines endpoints return history
 * regardless of webhook subscription.
 *
 * Fidelity note: the live path locks the verdict to the first OBSERVED head
 * sha; the API path can only ask about the STORED head sha (the final one).
 * For fast-merge PRs those are the same thing; for long-lived PRs this is
 * "first pass on the shipped sha" — the same sha the live path converges on
 * for PRs open at subscription time.
 *
 * Never overwrites: diff fields are written only where currently NULL, and
 * the CI verdict only lands where `first_ci_sha IS NULL` (compare-and-set,
 * so a live webhook racing the backfill wins). Per-PR failures are
 * collected, never thrown — both callers (repo-link flow, one-shot route)
 * treat enrichment as best-effort.
 */

/**
 * Link-flow budget. Each candidate costs up to 2 sequential API calls
 * (diff + checks), and the link flow runs enrichment after the response
 * (`after()`), so the bound is the function's background window — 200
 * candidates ≈ 400 calls comfortably inside a 300s `maxDuration`, and
 * far below the 5k/hr installation rate limit. A run truncated by the
 * window is harmless: writes are guarded, the remainder is picked up by
 * the next link or the one-shot backfill route.
 */
export const ENRICHMENT_LINK_LIMIT = 200;
const DEFAULT_SINCE_DAYS = 90;

interface EnrichmentCounts {
  examined: number;
  diffFilled: number;
  ciFilled: number;
  errors: string[];
}

interface EnrichConnectionInput {
  supabase: SupabaseClient<Database>;
  provider: GitProvider;
  appId: string;
  repository: string;
  limit: number;
  sinceDays?: number;
}

/**
 * Enrich one connection's recent decided PRs. Shared by the repo-link flow
 * (runs automatically after the lifecycle backfill, small budget) and the
 * one-shot backfill route (existing connections, bigger budget).
 */
export async function enrichPullRequestsForConnection(
  input: EnrichConnectionInput,
): Promise<EnrichmentCounts> {
  const counts: EnrichmentCounts = { examined: 0, diffFilled: 0, ciFilled: 0, errors: [] };
  const sinceDays = input.sinceDays ?? DEFAULT_SINCE_DAYS;
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await input.supabase
    .from(PULL_REQUEST_TABLE)
    .select("id, pr_number, head_sha, additions, first_ci_status")
    .eq("app_id", input.appId)
    .neq("state", "open")
    .gte("closed_at", cutoff)
    .or("additions.is.null,first_ci_status.is.null")
    .order("closed_at", { ascending: false })
    .limit(input.limit);
  if (error) {
    counts.errors.push(`candidate read failed: ${error.message}`);
    return counts;
  }

  for (const row of rows ?? []) {
    counts.examined += 1;
    try {
      if (row.additions == null) {
        const stats =
          input.provider instanceof GitHubProvider
            ? await input.provider.getPullRequestDiffStats(input.repository, row.pr_number)
            : null;
        const diffUpdate = {
          ...(typeof stats?.additions === "number" ? { additions: stats.additions } : {}),
          ...(typeof stats?.deletions === "number" ? { deletions: stats.deletions } : {}),
          ...(typeof stats?.changedFiles === "number" ? { changed_files: stats.changedFiles } : {}),
        };
        if (Object.keys(diffUpdate).length > 0) {
          const { error: diffError } = await input.supabase
            .from(PULL_REQUEST_TABLE)
            .update(diffUpdate)
            .eq("id", row.id)
            .is("additions", null);
          if (diffError) throw new Error(`diff write: ${diffError.message}`);
          counts.diffFilled += 1;
        }
      }

      if (row.first_ci_status == null && row.head_sha) {
        const verdict =
          input.provider instanceof GitHubProvider
            ? await input.provider.getCommitCiVerdict(input.repository, row.head_sha)
            : null;
        if (verdict?.conclusion) {
          const { error: ciError } = await input.supabase
            .from(PULL_REQUEST_TABLE)
            .update({
              first_ci_sha: row.head_sha,
              first_ci_status: verdict.conclusion,
              ...(verdict.completedAt ? { first_ci_at: verdict.completedAt } : {}),
            })
            .eq("id", row.id)
            .is("first_ci_sha", null);
          if (ciError) throw new Error(`ci write: ${ciError.message}`);
          counts.ciFilled += 1;
        }
      }
    } catch (err) {
      counts.errors.push(`pr ${row.pr_number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return counts;
}

interface EnrichmentBackfillResult {
  connections: number;
  examined: number;
  diffFilled: number;
  ciFilled: number;
  errors: string[];
}

/**
 * One-shot sweep over EXISTING connections (optionally one tenant's) — the
 * catch-up path for apps linked before enrichment existed; future links get
 * the same enrichment automatically in the repo-link flow. Per-connection
 * failures are collected so one bad token never aborts the sweep.
 */
export async function backfillPrEnrichment(params: {
  tenantId?: string;
  sinceDays?: number;
  perConnectionLimit?: number;
}): Promise<EnrichmentBackfillResult> {
  const supabase = getAdminDataClient();
  const result: EnrichmentBackfillResult = {
    connections: 0,
    examined: 0,
    diffFilled: 0,
    ciFilled: 0,
    errors: [],
  };

  let query = supabase.from("git_connection").select("app_id, repository");
  if (params.tenantId) query = query.eq("tenant_id", params.tenantId);
  const { data: connections, error } = await query;
  if (error) {
    result.errors.push(`git_connection read failed: ${error.message}`);
    return result;
  }

  for (const connection of connections ?? []) {
    if (!connection.repository) continue;
    result.connections += 1;
    try {
      const provider = await createGitProviderForApp(supabase, connection.app_id);
      if (!provider) {
        result.errors.push(`app ${connection.app_id}: no provider`);
        continue;
      }
      const counts = await enrichPullRequestsForConnection({
        supabase,
        provider,
        appId: connection.app_id,
        repository: connection.repository,
        limit: params.perConnectionLimit ?? 200,
        sinceDays: params.sinceDays,
      });
      result.examined += counts.examined;
      result.diffFilled += counts.diffFilled;
      result.ciFilled += counts.ciFilled;
      result.errors.push(...counts.errors.map((e) => `app ${connection.app_id}: ${e}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`app ${connection.app_id}: ${message}`);
      await serverLogger.withAppId(connection.app_id).error(
        err instanceof Error ? err : new Error(`[PR Enrichment] ${message}`),
      );
    }
  }

  return result;
}
