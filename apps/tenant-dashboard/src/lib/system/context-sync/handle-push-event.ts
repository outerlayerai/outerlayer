import "server-only";

/**
 * Provider-agnostic push core. The GitHub webhook route is a thin
 * verify+normalize adapter that hands a {@link NormalizedPushEvent}, a
 * git {@link GitProvider}, and a {@link CheckRunner} to this function.
 * Everything past signature verification is here, and it is best-effort by
 * contract: it NEVER throws, so the route always returns 200 (verification
 * failures — 401/404 — stay in the adapter).
 *
 * Sequence per watching app: `advanceCommitPointers` (BEFORE the sync, and even
 * when the sync fails — traces/scores must stamp against the true code state)
 * → `contextSync.syncOnPush` (self-records a `context_sync_event`). The commit
 * check is repurposed: it reports the AGGREGATE mirror-sync outcome across the
 * watching apps, not a deploy pipeline. No deployment rows, no builds, no queue.
 *
 * Owns the service-role Supabase client — the RLS-bypassing client is
 * constructed inside `src/lib/system/**` only (the data-access boundary).
 */
import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { advanceCommitPointers } from "@/lib/system/git/commit-pointers";
import type { GitProvider } from "../git/git-provider.interface";
import type { NormalizedPushEvent } from "../git/types";
import type { CheckRunner, CheckRunRef } from "../git/check-runner";
import { buildContextSync, type SyncOutcome } from "@repo/context-sync";
import { createSupabaseContextMirrorPort } from "./mirror-port";
import { resolveWatchingApps } from "./resolve-watching-apps";

interface AppSyncResult {
  appName: string;
  outcome: SyncOutcome;
}

export async function handlePushEvent(input: {
  push: NormalizedPushEvent;
  provider: GitProvider;
  /** Null when the push can't post a check (branch deletion / missing repo
   *  coordinates) — the adapter owns that decision. */
  checkRunner: CheckRunner | null;
  /** Log label for the calling webhook, e.g. "GitHub Webhook". */
  source: string;
}): Promise<void> {
  const { push, provider, checkRunner, source } = input;

  // Open the check before any work so the commit shows "in progress" even if
  // the sync takes a while. Best-effort — a status-API outage must never abort
  // the sync (the check is observability, not the gate).
  let checkRef: CheckRunRef | null = null;
  if (checkRunner) {
    try {
      checkRef = await checkRunner.start(push.commitSha);
    } catch (err) {
      await serverLogger.info(
        `[${source}] check start failed; continuing without check`,
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  // No watching apps → neutral (nothing to sync); otherwise success unless any
  // app's sync failed.
  let conclusion: "success" | "failure" | "neutral" = "neutral";
  let summary: string | undefined;

  try {
    const admin = getAdminDataClient();
    const watching = await resolveWatchingApps(admin, {
      repository: push.repository,
      branch: push.branch,
    });

    if (watching.length > 0) {
      const contextSync = buildContextSync({
        db: createSupabaseContextMirrorPort(admin),
        git: provider,
      });

      const results: AppSyncResult[] = [];
      for (const app of watching) {
        // Advance pointers FIRST — before the sync, and even if it later fails.
        // A failed mirror is surfaced by the failed event + Context › History;
        // the trace-stamping pointers must still reflect the true HEAD.
        try {
          await advanceCommitPointers(admin, {
            appId: app.appId,
            commitSha: push.commitSha,
          });
        } catch (err) {
          await serverLogger
            .withAppId(app.appId)
            .error(
              err instanceof Error
                ? err
                : new Error(`[${source}] advanceCommitPointers: ${String(err)}`),
            );
        }

        const outcome = await contextSync.syncOnPush({
          appId: app.appId,
          tenantId: app.tenantId,
          repo: push.repository,
          branch: app.branch,
          beforeSha: push.beforeSha ?? null,
          afterSha: push.commitSha,
          commitMessage: push.commitMessage,
        });
        if (outcome.kind === "failed") {
          await serverLogger
            .withAppId(app.appId)
            .error(new Error(`[${source}] ${outcome.error}`));
        }
        results.push({ appName: app.appName, outcome });
      }

      conclusion = results.every((r) => r.outcome.kind !== "failed")
        ? "success"
        : "failure";
      summary = buildCheckSummary(results, push.commitSha);
    }
  } catch (err) {
    // Unexpected fault (routing / admin client) — complete the check truthfully
    // as a failure. The push response is still 200 (self-heals next push).
    conclusion = "failure";
    summary = err instanceof Error ? err.message : String(err);
    await serverLogger.info(`[${source}] push handling failed`, {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (checkRunner && checkRef) {
    try {
      await checkRunner.complete({ ref: checkRef, conclusion, summary });
    } catch (err) {
      await serverLogger.info(
        `[${source}] check complete failed; check left open`,
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}

/** One line per watching app, aggregated into the check-run summary body. */
function buildCheckSummary(
  results: ReadonlyArray<AppSyncResult>,
  pushSha: string,
): string {
  return results
    .map((r) => {
      if (r.outcome.kind === "failed") {
        return `✕ ${r.appName}: ${r.outcome.error ?? "sync failed"}`;
      }
      const sha = (r.outcome.commitSha ?? pushSha).slice(0, 7);
      return `✓ ${r.appName}: synced ${sha}`;
    })
    .join("\n");
}
