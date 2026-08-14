import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPrCommentRepo } from "@repo/gateway-core/lib/pr-comment-repo-key";

import { BRANCH_LINK_LOOKBACK_DAYS } from "./reconciler";

/**
 * Artifact-side reconciliation: resolves `pending` artifacts to pull
 * requests, then ages out the ones nothing ever matched. Runs beside the
 * session sweep on the same cadence; writers are the reconciler only
 * (service_role), matching `pull_request_session`'s posture.
 *
 * Resolution tiers, strongest first — mirroring how the artifact was
 * anchored at ingest:
 *   1. a claimed PR number — confirmed once the webhook-fed `pull_request`
 *      row exists (the gateway confirms immediately when it already did);
 *   2. the emitting session's confirmed PR links (`pull_request_session`);
 *   3. branch + activity window, the same guarded match sessions use.
 *
 * `unmatched` is terminal here; the blob bytes behind an unmatched artifact
 * are deleted by the gateway retention job (`blob_deleted` records that),
 * because object storage is reachable only from the gateway.
 */

/** A `pending` artifact past this age with no PR match is `unmatched` —
 * the same grace the session reconciler gives a claimed PR number. */
const ARTIFACT_PENDING_GRACE_DAYS = 14;

/** Bounded scan — reconciliation is incremental, never a full-table walk. */
const MAX_PENDING_ARTIFACTS = 5_000;

export interface ArtifactReconcileCounts {
  pending: number;
  confirmed: number;
  unmatched: number;
}

interface ChangedArtifactPr {
  appId: string;
  prNumber: number;
}

interface PendingArtifactRow {
  id: string;
  tenant_id: string;
  app_id: string;
  trace_id: string;
  pr_number: number | null;
  repository: string;
  git_repo: string;
  git_branch: string;
  emitted_at: string;
}

interface PullRequestWindowRow {
  pr_number: number;
  head_branch: string;
  opened_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
}

/** The PR whose activity window contains the artifact's emit time, with the
 * same branch-tier lookback padding sessions get (branch names and long
 * sessions both start before the PR opens). Latest PR wins ties — on a
 * recycled branch the newest PR is the one being worked. */
function pickPrByWindow(
  candidates: PullRequestWindowRow[],
  emittedAtMs: number,
  nowMs: number,
): number | null {
  const lookbackMs = BRANCH_LINK_LOOKBACK_DAYS * 86_400_000;
  let best: number | null = null;
  for (const pr of candidates) {
    const openedMs = pr.opened_at ? new Date(pr.opened_at).getTime() : Number.NaN;
    if (!Number.isFinite(openedMs)) continue;
    const decided = pr.merged_at ?? pr.closed_at;
    const endMs = decided ? new Date(decided).getTime() : nowMs;
    if (emittedAtMs < openedMs - lookbackMs || emittedAtMs > endMs) continue;
    if (best === null || pr.pr_number > best) best = pr.pr_number;
  }
  return best;
}

export async function reconcileArtifacts(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<{ counts: ArtifactReconcileCounts; changed: ChangedArtifactPr[] }> {
  const nowIso = now.toISOString();
  const { data: pendingRows, error } = await supabase
    .from("artifact")
    .select(
      "id, tenant_id, app_id, trace_id, pr_number, repository, git_repo, git_branch, emitted_at",
    )
    .eq("verification", "pending")
    .limit(MAX_PENDING_ARTIFACTS);
  if (error) throw new Error(`artifact read failed: ${error.message}`);
  const pending = (pendingRows ?? []) as PendingArtifactRow[];
  const counts: ArtifactReconcileCounts = { pending: pending.length, confirmed: 0, unmatched: 0 };
  const changed = new Map<string, ChangedArtifactPr>();
  if (pending.length === 0) return { counts, changed: [] };

  const byApp = new Map<string, PendingArtifactRow[]>();
  for (const row of pending) {
    const list = byApp.get(row.app_id) ?? [];
    list.push(row);
    byApp.set(row.app_id, list);
  }

  // One canonical repository string per app, from its GitHub connection —
  // stamped onto confirmed rows so the comment read is a single equality.
  const { data: connections } = await supabase
    .from("git_connection")
    .select("app_id, repository")
    .in("app_id", [...byApp.keys()])
    .eq("provider", "github");
  const repoByApp = new Map<string, string>();
  for (const c of connections ?? []) {
    const canonical = canonicalPrCommentRepo(c.repository ?? "");
    if (canonical) repoByApp.set(c.app_id, canonical);
  }

  const graceMs = ARTIFACT_PENDING_GRACE_DAYS * 86_400_000;

  for (const [appId, artifacts] of byApp) {
    const canonicalRepo = repoByApp.get(appId) ?? "";

    // Session tier needs the confirmed PR links of every referenced trace.
    const traceIds = [...new Set(artifacts.map((a) => a.trace_id).filter((t) => t !== ""))];
    const linksByTrace = new Map<string, number[]>();
    if (traceIds.length > 0) {
      const { data: links } = await supabase
        .from("pull_request_session")
        .select("trace_id, pr_number")
        .eq("app_id", appId)
        .in("trace_id", traceIds)
        .eq("verification", "confirmed");
      for (const l of links ?? []) {
        const list = linksByTrace.get(l.trace_id) ?? [];
        list.push(Number(l.pr_number));
        linksByTrace.set(l.trace_id, list);
      }
    }

    // Window rows for every PR number any tier might bind to: claimed
    // numbers confirm on existence, session/branch tiers pick by window.
    const claimedPrs = artifacts.map((a) => a.pr_number).filter((n): n is number => n !== null);
    const sessionPrs = [...linksByTrace.values()].flat();
    const needsBranchTier = artifacts.some(
      (a) => a.pr_number === null && a.trace_id === "" && a.git_branch !== "",
    );
    let prRows: PullRequestWindowRow[] = [];
    const prNumbers = [...new Set([...claimedPrs, ...sessionPrs])];
    if (prNumbers.length > 0 || needsBranchTier) {
      let query = supabase
        .from("pull_request")
        .select("pr_number, head_branch, opened_at, closed_at, merged_at")
        .eq("app_id", appId);
      // The branch tier can't pre-narrow by number; scoping to the branch
      // names in play keeps the read bounded without a second query shape.
      if (!needsBranchTier) query = query.in("pr_number", prNumbers);
      const { data: prs } = await query.limit(2_000);
      prRows = (prs ?? []).map((p) => ({
        pr_number: Number(p.pr_number),
        head_branch: String(p.head_branch ?? ""),
        opened_at: p.opened_at,
        closed_at: p.closed_at,
        merged_at: p.merged_at,
      }));
    }
    const knownPrs = new Set(prRows.map((p) => p.pr_number));

    for (const artifact of artifacts) {
      const emittedAtMs = new Date(artifact.emitted_at).getTime();
      let resolvedPr: number | null = null;

      if (artifact.pr_number !== null) {
        // Claimed number: existence is the whole check — the caller already
        // said which PR, the provider record just has to agree.
        resolvedPr = knownPrs.has(artifact.pr_number) ? artifact.pr_number : null;
      } else if (artifact.trace_id !== "") {
        const candidates = linksByTrace.get(artifact.trace_id) ?? [];
        const windows = prRows.filter((p) => candidates.includes(p.pr_number));
        resolvedPr = pickPrByWindow(windows, emittedAtMs, now.getTime());
        // A session linked to exactly one PR binds even when the window
        // data is missing (a pull_request row with no opened_at) — the
        // session's own link already carries the evidence.
        if (resolvedPr === null && candidates.length === 1 && knownPrs.has(candidates[0]!)) {
          resolvedPr = candidates[0]!;
        }
      } else if (artifact.git_branch !== "") {
        // Branch tier: only within the app whose connection matches the
        // checkout the artifact came from — an artifact emitted in some
        // other repo must not bind to this app's PRs.
        const gitRepoCanonical = canonicalPrCommentRepo(artifact.git_repo);
        const repoAgrees =
          artifact.git_repo === "" ||
          canonicalRepo === "" ||
          gitRepoCanonical === null ||
          gitRepoCanonical === canonicalRepo;
        if (repoAgrees) {
          const windows = prRows.filter((p) => p.head_branch === artifact.git_branch);
          resolvedPr = pickPrByWindow(windows, emittedAtMs, now.getTime());
        }
      }

      if (resolvedPr !== null) {
        const { error: updateError } = await supabase
          .from("artifact")
          .update({
            verification: "confirmed",
            pr_number: resolvedPr,
            repository: artifact.repository !== "" ? artifact.repository : canonicalRepo,
            last_reconciled_at: nowIso,
          })
          .eq("id", artifact.id);
        if (updateError) throw new Error(`artifact update failed: ${updateError.message}`);
        counts.confirmed += 1;
        changed.set(`${appId}:${resolvedPr}`, { appId, prNumber: resolvedPr });
      } else if (now.getTime() - emittedAtMs > graceMs) {
        const { error: updateError } = await supabase
          .from("artifact")
          .update({ verification: "unmatched", last_reconciled_at: nowIso })
          .eq("id", artifact.id);
        if (updateError) throw new Error(`artifact update failed: ${updateError.message}`);
        counts.unmatched += 1;
      }
    }
  }

  return { counts, changed: [...changed.values()] };
}
