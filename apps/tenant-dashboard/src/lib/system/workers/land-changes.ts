import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { createGitProviderForApp } from "@/lib/system/git";
import type { FileChange } from "@/lib/system/git/types";
import type { EnsurePullRequestContext, LandChangesContext, LandChangesResult } from "@repo/worker-core";
import { isLocalRepo, landChangesToLocalRepo } from "./local-git-lander";

/**
 * The git-delivery hook injected into applyWorkerCallback.
 *
 * The runner returns the agent's working-tree diff as WorkerFileChange[]; this
 * lands it as ONE squashed commit on `outerlayer/worker/<slug>` and always opens
 * a PR (`forcePullRequest`) back to the run's base branch. Write authority stays
 * server-side — the worker machine never holds push credentials.
 *
 * Wire `operation: 'write'` maps to git `create | update` by whether the file
 * exists at the base branch (the provider content API distinguishes them);
 * `delete` maps straight through. Binary files (base64) are decoded to the
 * provider's expected content encoding.
 */

interface WorkerFileChange {
  path: string;
  operation: "write" | "delete";
  content?: string;
  encoding: "utf8" | "base64";
}

async function resolveRepoAndBranch(
  supabase: SupabaseClient<Database>,
  appId: string,
): Promise<{ repository: string; branch: string }> {
  const { data: connection } = await supabase
    .from("git_connection")
    .select("repository")
    .match({ app_id: appId })
    .single();
  if (!connection?.repository) {
    throw new Error("app has no git connection to open a pull request against");
  }
  const { data: branchRow } = await supabase
    .from("git_branch")
    .select("branch_name")
    .match({ app_id: appId })
    .single();
  if (!branchRow?.branch_name) {
    throw new Error("app git connection has no tracked branch");
  }
  return { repository: connection.repository, branch: branchRow.branch_name };
}

async function toFileChanges(
  provider: Awaited<ReturnType<typeof createGitProviderForApp>>,
  repository: string,
  branch: string,
  changes: WorkerFileChange[],
): Promise<FileChange[]> {
  const out: FileChange[] = [];
  for (const change of changes) {
    if (change.operation === "delete") {
      out.push({ path: change.path, content: "", operation: "delete" });
      continue;
    }
    const content =
      change.encoding === "base64"
        ? Buffer.from(change.content ?? "", "base64").toString("utf8")
        : (change.content ?? "");
    // create vs update: the provider needs to know if the file already exists
    // on the base branch: a blob update has to send the prior sha.
    let exists = false;
    try {
      exists = (await provider!.getFileContent(repository, change.path, branch)) !== null;
    } catch {
      exists = false;
    }
    out.push({ path: change.path, content, operation: exists ? "update" : "create" });
  }
  return out;
}

/**
 * Build the landChanges hook bound to an app's git provider. `baseBranchOverride`
 * (the run's requested base) wins over the app's tracked branch when set.
 */
export function createWorkerLandChanges(
  supabase: SupabaseClient<Database>,
  opts: { baseBranchOverride?: string } = {},
) {
  return async function landChanges(ctx: LandChangesContext): Promise<LandChangesResult> {
    const resolved = await resolveRepoAndBranch(supabase, ctx.appId);
    const baseBranch = opts.baseBranchOverride || resolved.branch;

    // Local dev/e2e: land into a local bare repo, no hosted provider.
    if (isLocalRepo(resolved.repository)) {
      return landChangesToLocalRepo(resolved.repository, baseBranch, ctx);
    }

    const provider = await createGitProviderForApp(supabase, ctx.appId);
    if (!provider) {
      throw new Error("no git provider configured for this app");
    }

    const fileChanges = await toFileChanges(
      provider,
      resolved.repository,
      baseBranch,
      ctx.changes as WorkerFileChange[],
    );

    const message = `agent: ${ctx.taskPrompt}`.slice(0, 72);
    const result = await provider.createCommitWithFallback(
      resolved.repository,
      fileChanges,
      message,
      baseBranch,
      { name: "AgentMark Worker", email: "workers@agentmark.co" },
      {
        forcePullRequest: true,
        headBranchPrefix: "outerlayer/worker",
        headBranchSlug: ctx.branchSlug ?? "task",
        pullRequestBody: `Automated changes from a cloud worker run.\n\n> ${ctx.taskPrompt}\n\nRun \`${ctx.workerRunId}\`.`,
      },
    );

    return {
      branchName: result.fallbackBranch ?? baseBranch,
      prUrl: result.pullRequestUrl ?? null,
      prNumber: result.pullRequestNumber ?? null,
    };
  };
}

/**
 * The ensurePullRequest hook for persistent-environment turns: the runner
 * already pushed `workBranch`, so this only opens-or-reuses a PR from it. For a
 * local bare repo there's no hosted PR — return a file:// compare URL. For
 * GitHub, open a PR from workBranch -> base (idempotent: reuse if one is
 * already open).
 */
export function createWorkerEnsurePr(
  supabase: SupabaseClient<Database>,
  opts: { baseBranchOverride?: string } = {},
) {
  return async function ensurePullRequest(ctx: EnsurePullRequestContext): Promise<LandChangesResult> {
    const resolved = await resolveRepoAndBranch(supabase, ctx.appId);
    const base = opts.baseBranchOverride || resolved.branch;

    if (isLocalRepo(resolved.repository)) {
      return {
        branchName: ctx.workBranch,
        prUrl: `file://${resolved.repository}#${ctx.workBranch}`,
        prNumber: null,
      };
    }

    // Hosted providers: the branch is already pushed by the runner. Opening a
    // PR from an existing branch isn't exposed on the provider interface yet
    // (createCommitWithFallback owns commit+PR together), so hosted
    // persistent-PR delivery is a deferred follow-up. Throwing here is safe:
    // applyWorkerCallback catches it and records the branch with no PR, so the
    // work is never lost — the branch is on the remote and reviewable.
    void base;
    throw new Error("hosted persistent-environment PR delivery is not yet wired; branch recorded without a PR");
  };
}
