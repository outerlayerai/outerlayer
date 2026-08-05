import { App } from "octokit";
import type {
  GitFileProvider,
  GitRepositorySummary,
} from "./types";
import type { Env } from "../types";
import { validatePath } from "../utils";

/** Page size used for paginated `GET /installation/repositories` and `GET /repos/{owner}/{repo}/branches` calls. GitHub's max is 100. */
const PAGE_SIZE = 100;

/**
 * Hard ceiling on pages we'll walk in a single listing call. With
 * PAGE_SIZE=100 this caps a list at 50_000 entries — well past any
 * realistic GitHub installation's repo count — while keeping the
 * worst-case subrequest budget under Cloudflare's 1000-per-request
 * limit. If a tenant ever has more than this, they're not the user
 * we're optimizing for.
 */
const MAX_PAGES = 500;

/**
 * Gateway GitHub provider — implements {@link GitFileProvider} (headless link
 * path): `streamFile` plus discovery methods (`listRepositories`,
 * `listBranches`, `getLatestCommitSha`) used by the gateway-side OAuth/link
 * flow.
 */
export class GitHubProvider implements GitFileProvider {
  private constructor(
    private readonly octokit: Awaited<ReturnType<App["getInstallationOctokit"]>>,
    private readonly installationId: number,
    private readonly appId: string,
  ) {}

  static async create(installationId: number, env: Env): Promise<GitHubProvider> {
    console.log("[github] create", { appId: env.GITHUB_APP_ID, installationId });
    const app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    try {
      const octokit = await app.getInstallationOctokit(installationId);
      console.log("[github] octokit ready", { installationId });
      return new GitHubProvider(octokit, installationId, env.GITHUB_APP_ID);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.error("[github] create failed", {
        appId: env.GITHUB_APP_ID,
        installationId,
        status: e?.status,
        message: e?.message,
      });
      throw err;
    }
  }

  async listRepositories(): Promise<GitRepositorySummary[]> {
    const out: GitRepositorySummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.octokit.request("GET /installation/repositories", {
        per_page: PAGE_SIZE,
        page,
      });
      const repos = response.data.repositories ?? [];
      for (const repo of repos) {
        out.push({
          fullName: repo.full_name,
          name: repo.name,
          defaultBranch: repo.default_branch ?? "main",
        });
      }
      if (repos.length < PAGE_SIZE) break;
    }
    return out;
  }

  async listBranches(repository: string): Promise<string[]> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repository format: ${repository}`);
    }
    const out: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/branches", {
        owner,
        repo,
        per_page: PAGE_SIZE,
        page,
      });
      const branches = (response.data ?? []) as Array<{ name: string }>;
      for (const b of branches) out.push(b.name);
      if (branches.length < PAGE_SIZE) break;
    }
    return out;
  }

  async getLatestCommitSha(repository: string, branch: string): Promise<string | null> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) return null;
    try {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
        owner,
        repo,
        branch,
      });
      return (response.data as { commit?: { sha?: string } }).commit?.sha ?? null;
    } catch (err) {
      // Auxiliary fetch — link should succeed even if this fails (e.g.
      // branch was just created on the remote and hasn't propagated to
      // GitHub's cache yet).
      console.warn("[github] getLatestCommitSha failed", {
        repository,
        branch,
        message: (err as Error)?.message,
      });
      return null;
    }
  }

  async streamFile(
    repository: string,
    path: string,
    ref: string
  ): Promise<ReadableStream<Uint8Array>> {
    const [owner, repo] = repository.split("/");
    // Validate and normalize path to prevent traversal attacks
    const normalizedPath = validatePath(path);
    const ctx = {
      owner,
      repo,
      path: normalizedPath,
      ref,
      appId: this.appId,
      installationId: this.installationId,
    };
    console.log("[github] streamFile start", ctx);

    return new ReadableStream({
      start: (controller) => {
        let bytes = 0;
        const customFetch = async (url: string, options: RequestInit) => {
          const res = await fetch(url, options);
          console.log("[github] fetch result", {
            ...ctx,
            status: res.status,
            contentLength: res.headers.get("content-length"),
          });
          const reader = res.body?.getReader();
          if (!reader) {
            console.warn("[github] no body reader", { ...ctx, status: res.status });
            controller.close();
            return res;
          }

          const pump = (): Promise<void> =>
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  console.log("[github] stream done", { ...ctx, bytes });
                  controller.close();
                  return;
                }
                bytes += value.byteLength;
                controller.enqueue(value);
                return pump();
              })
              .catch((err) => {
                console.error("[github] pump error", {
                  ...ctx,
                  bytes,
                  message: (err as Error)?.message,
                });
                controller.error(err);
              });

          pump();
          return res;
        };

        // Without .catch, a rejection here orphans the controller and the
        // client sees 200 OK + empty chunked body that hangs until its own
        // timeout. The .catch surfaces the failure as a stream error so CF
        // aborts the response cleanly and the cause is visible in logs.
        this.octokit
          .request("GET /repos/{owner}/{repo}/contents/{path}", {
            request: { fetch: customFetch },
            owner: owner!,
            repo: repo!,
            path: normalizedPath,
            ref,
            headers: { accept: "application/vnd.github.v3.raw" },
          })
          .catch(
            (err: {
              status?: number;
              message?: string;
              response?: { data?: unknown };
            }) => {
              console.error("[github] octokit request failed", {
                ...ctx,
                status: err?.status,
                message: err?.message,
                data: err?.response?.data,
              });
              controller.error(
                err instanceof Error
                  ? err
                  : new Error(err?.message || "github request failed")
              );
            }
          );
      },
    });
  }
}
