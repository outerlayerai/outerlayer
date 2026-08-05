import "server-only";

// Stryker disable all: this module spawns REAL `git` processes and its tests
// exercise them against temp repos. A mutant that corrupts a path/cwd argument
// escapes the test's temp sandbox and runs git checkout/commit/reset against
// whatever repository the runner itself sits in (observed locally: a mutant
// checked out `outerlayer/worker/add-thing` and reset the developer checkout
// mid-gate). Process-spawning git plumbing must never be mutation-tested
// in place.
import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { LandChangesContext, LandChangesResult } from "@repo/worker-core";

const execFileAsync = promisify(execFile);

interface WorkerFileChange {
  path: string;
  operation: "write" | "delete";
  content?: string;
  encoding: "utf8" | "base64";
}

/**
 * Lands a worker run's diff into a LOCAL bare git repo (dev + e2e only): clone
 * the bare repo, create `outerlayer/worker/<slug>`, apply the changes, commit,
 * and push the branch back. Returns the branch name and a `file://` compare
 * URL in place of a hosted PR — enough to demonstrate the full changes-delivery
 * path with zero external side effects. Production uses the GitHub
 * provider path instead (see land-changes.ts).
 */
export async function landChangesToLocalRepo(
  bareRepoPath: string,
  baseBranch: string,
  ctx: LandChangesContext,
): Promise<LandChangesResult> {
  const changes = ctx.changes as WorkerFileChange[];
  const branchName = `outerlayer/worker/${(ctx.branchSlug ?? "task").slice(0, 48)}`;
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `worker-land-${ctx.workerRunId.slice(0, 8)}-`));
  const git = (args: string[]) => execFileAsync("git", args, { cwd: workdir });

  try {
    await execFileAsync("git", ["clone", "--branch", baseBranch, bareRepoPath, workdir]);
    await git(["config", "user.email", "workers@agentmark.co"]);
    await git(["config", "user.name", "AgentMark Worker"]);
    await git(["checkout", "-b", branchName]);

    for (const change of changes) {
      const abs = path.join(workdir, change.path);
      if (change.operation === "delete") {
        await fs.rm(abs, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const buf =
        change.encoding === "base64"
          ? Buffer.from(change.content ?? "", "base64")
          : Buffer.from(change.content ?? "", "utf8");
      await fs.writeFile(abs, buf);
    }

    await git(["add", "-A"]);
    await git(["commit", "-m", `agent: ${ctx.taskPrompt}`.slice(0, 72)]);
    await git(["push", "origin", branchName]);

    return {
      branchName,
      prUrl: `file://${bareRepoPath}#${branchName}`,
      prNumber: null,
    };
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A repository reference is local when it's an absolute path or a file:// URL. */
export function isLocalRepo(repository: string): boolean {
  return repository.startsWith("/") || repository.startsWith("file://");
}
