/**
 * In-memory `GitProvider` implementation for the integration harness — a
 * third implementation of the same contract `GitHubProvider`/`GitLabProvider`
 * satisfy — compile-checked (`implements GitProvider`) and covered by the
 * same method/signature parity suite
 * (`src/tests/providers/interface-parity.test.ts`).
 *
 * One module-level store keyed by `repo` ("owner/repo") backs any number of
 * seeded apps; branch state is content-addressed with a deterministic sha1 of
 * the file content, so `baseBlobSha` conflict semantics in
 * `save-service.ts` behave like git without hardcoding any git internals.
 *
 * Installed via `installFakeGitProvider()` (overrides the `'github'` factory
 * registry entry — see `src/lib/system/git/factory.ts`'s exported
 * `overrideProviderFactoryForTesting`), so `createGitProviderForApp` and every
 * caller reachable from it (save-service, `resolveAppGitProvider`,
 * context-sync) exercise this fake with zero test-only wiring elsewhere.
 *
 * Known fidelity gaps (deliberate — this fakes the `GitProvider` contract's
 * semantics, not a real git object model):
 * - `ref` arguments are treated as branch names only; a commit sha or tag
 *   passed as `ref` will not resolve.
 * - `compareCommits` diffs two commits' full-tree snapshots directly rather
 *   than counting per-file line changes, so `additions`/`deletions` are whole
 *   files' line counts, not a real diff.
 * - `createCommitWithFallback`'s branch-protection fallback (`landed:
 *   'pull_request'` via a rejected direct push) is unreachable — this fake
 *   only takes the PR path when the caller passes `forcePullRequest`, never
 *   from a simulated protected-branch rejection.
 */
import { createHash, randomUUID } from 'crypto';
import type { GitProvider } from 'tenant-dashboard/src/lib/system/git/git-provider.interface';
import type {
  Commit,
  CommitAuthor,
  CommitFallbackOptions,
  CommitHistoryOptions,
  CommitHistoryResult,
  CommitWithFallbackResult,
  CommitWithPath,
  FileChange,
  FileContent,
  FileDiff,
  FileEntry,
  ListPullRequestsOptions,
  PullRequestSummary,
  WebhookRegistration,
} from 'tenant-dashboard/src/lib/system/git/types';
import { FileNotFoundError, GitProviderError, RepositoryNotFoundError } from 'tenant-dashboard/src/lib/system/git/errors';
import { overrideProviderFactoryForTesting } from 'tenant-dashboard/src/lib/system/git/factory';

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

interface FakeCommitRecord {
  sha: string;
  message: string;
  author: CommitAuthor;
  timestamp: string;
  branch: string;
  /** Full file state immediately after this commit — powers compareCommits/history. */
  snapshot: Map<string, string>;
  changedPaths: string[];
}

interface FakeBranch {
  headSha: string | null;
  files: Map<string, string>; // path -> content, current head state
}

interface FakePullRequest {
  number: number;
  headBranch: string;
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
}

interface FakeRepo {
  branches: Map<string, FakeBranch>;
  commits: FakeCommitRecord[]; // chronological, oldest first
  pullRequests: FakePullRequest[];
  nextPrNumber: number;
}

const repos = new Map<string, FakeRepo>();

/** `{method, error}` — the next call to `method` on any fake instance throws `error` once, then clears. */
let pendingFailure: { method: string; error: Error } | null = null;

/**
 * Deterministic, content-addressed blob sha for `content` — a real sha1, not a
 * git blob sha (no `"blob <size>\0"` header), but that's all `baseBlobSha`
 * conflict detection needs: same content in, same sha out. Exported so tests
 * computing an expected `baseBlobSha` (e.g. for a conflict case) derive it
 * from the same function the fake uses internally, instead of re-implementing
 * the hash.
 */
export function fakeBlobSha(content: string): string {
  return createHash('sha1').update(content, 'utf-8').digest('hex');
}

function getOrCreateRepo(repo: string): FakeRepo {
  let state = repos.get(repo);
  if (!state) {
    state = { branches: new Map(), commits: [], pullRequests: [], nextPrNumber: 1 };
    repos.set(repo, state);
  }
  return state;
}

function requireRepo(repo: string): FakeRepo {
  const state = repos.get(repo);
  if (!state) throw new RepositoryNotFoundError('github', repo);
  return state;
}

// -----------------------------------------------------------------------------
// Seed / assert helpers
// -----------------------------------------------------------------------------

/**
 * Seed (or reseed) a branch of a repo with a fixed file set. Creates the repo
 * if new. A non-empty file set is recorded as a synthetic initial commit (a
 * branch with content but `headSha: null` is an impossible git state), so
 * `getFakeRepoCommits`/`getCommitHistory` see it like any other commit; an
 * empty file set leaves the branch commit-less (`headSha: null`), matching a
 * freshly created, still-empty branch.
 */
export function seedFakeRepo(
  repo: string,
  options: { branch: string; files: Record<string, string> },
): void {
  const state = getOrCreateRepo(repo);
  const files = new Map(Object.entries(options.files));

  if (files.size === 0) {
    state.branches.set(options.branch, { headSha: null, files });
    return;
  }

  const sha = fakeBlobSha(`seed:${options.branch}:${JSON.stringify(options.files)}`);
  state.commits.push({
    sha,
    message: 'seed',
    author: { name: 'fixture', email: 'fixture@fake.git' },
    timestamp: new Date().toISOString(),
    branch: options.branch,
    snapshot: new Map(files),
    changedPaths: Array.from(files.keys()),
  });
  state.branches.set(options.branch, { headSha: sha, files });
}

/** Every commit landed on `repo` (any branch), oldest first. */
export function getFakeRepoCommits(repo: string, branch?: string): FakeCommitRecord[] {
  const state = repos.get(repo);
  if (!state) return [];
  return branch ? state.commits.filter((c) => c.branch === branch) : state.commits;
}

/** Current content of `path` on `branch`'s head, or null if absent. */
export function getFakeRepoFile(repo: string, branch: string, path: string): string | null {
  const state = repos.get(repo);
  const branchState = state?.branches.get(branch);
  return branchState?.files.get(path) ?? null;
}

/** Open pull requests recorded against `repo` (from a `forcePullRequest` commit). */
export function getFakeRepoPullRequests(repo: string): FakePullRequest[] {
  return repos.get(repo)?.pullRequests ?? [];
}

/**
 * The next call to `method` on any fake provider instance throws `error`,
 * once. "Next call" means the first call from ANYWHERE the method is
 * invoked, including calls the code under test makes internally before its
 * own write — e.g. `failNextCall('getFileContent', …)` fires on
 * save-service's pre-write conflict read (`getRemoteSha`), not on a
 * subsequent `createCommitWithFallback`.
 */
export function failNextCall(method: keyof GitProvider, error: GitProviderError): void {
  pendingFailure = { method: method as string, error };
}

/** Clears every seeded repo and any pending scripted failure. Call in `afterEach`. */
export function resetFakeRepos(): void {
  repos.clear();
  pendingFailure = null;
}

function checkScriptedFailure(method: string): void {
  if (pendingFailure && pendingFailure.method === method) {
    const { error } = pendingFailure;
    pendingFailure = null;
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

export class FakeGitProvider implements GitProvider {
  readonly type = 'github' as const;

  async listRepositories(): Promise<{ fullName: string; name: string; defaultBranch: string }[]> {
    checkScriptedFailure('listRepositories');
    return Array.from(repos.entries()).map(([fullName, state]) => ({
      fullName,
      name: fullName.split('/').pop() ?? fullName,
      defaultBranch: state.branches.has('main') ? 'main' : (Array.from(state.branches.keys())[0] ?? 'main'),
    }));
  }

  async listBranches(repo: string): Promise<string[]> {
    checkScriptedFailure('listBranches');
    return Array.from((repos.get(repo)?.branches ?? new Map()).keys());
  }

  async getLatestCommitSha(repo: string, branch: string): Promise<string | null> {
    checkScriptedFailure('getLatestCommitSha');
    return repos.get(repo)?.branches.get(branch)?.headSha ?? null;
  }

  async listTree(repo: string, ref: string): Promise<Array<{ path: string; sha: string; size: number }>> {
    checkScriptedFailure('listTree');
    const branchState = repos.get(repo)?.branches.get(ref);
    if (!branchState) return [];
    return Array.from(branchState.files.entries()).map(([path, content]) => ({
      path,
      sha: fakeBlobSha(content),
      size: Buffer.byteLength(content, 'utf-8'),
    }));
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<FileContent> {
    checkScriptedFailure('getFileContent');
    const branchState = repos.get(repo)?.branches.get(ref);
    const content = branchState?.files.get(path);
    if (content === undefined) throw new FileNotFoundError('github', repo, path);
    return {
      path,
      content,
      sha: fakeBlobSha(content),
      size: Buffer.byteLength(content, 'utf-8'),
      encoding: 'utf-8',
    };
  }

  async getFileRaw(repo: string, path: string, ref: string): Promise<ReadableStream<Uint8Array>> {
    checkScriptedFailure('getFileRaw');
    const file = await this.getFileContent(repo, path, ref);
    const bytes = new TextEncoder().encode(file.content);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async listDirectory(repo: string, path: string, ref: string): Promise<FileEntry[]> {
    checkScriptedFailure('listDirectory');
    const branchState = repos.get(repo)?.branches.get(ref);
    if (!branchState) return [];
    const prefix = path === '' ? '' : `${path.replace(/\/$/, '')}/`;
    const entries = new Map<string, FileEntry>();
    for (const [filePath, content] of branchState.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const [segment, ...more] = rest.split('/');
      if (!segment) continue;
      const isDir = more.length > 0;
      const entryPath = prefix + segment;
      if (!entries.has(entryPath)) {
        entries.set(entryPath, {
          path: entryPath,
          name: segment,
          type: isDir ? 'dir' : 'file',
          ...(isDir ? {} : { sha: fakeBlobSha(content), size: Buffer.byteLength(content, 'utf-8') }),
        });
      }
    }
    return Array.from(entries.values());
  }

  private applyCommit(
    repo: string,
    branch: string,
    changes: FileChange[],
    message: string,
    committer: CommitAuthor,
  ): Commit {
    const state = requireRepo(repo);
    let branchState = state.branches.get(branch);
    if (!branchState) {
      branchState = { headSha: null, files: new Map() };
      state.branches.set(branch, branchState);
    }
    for (const change of changes) {
      if (change.operation === 'delete') {
        branchState.files.delete(change.path);
      } else {
        branchState.files.set(change.path, change.content);
      }
    }
    const sha = fakeBlobSha(`${branch}:${message}:${randomUUID()}`);
    const timestamp = new Date().toISOString();
    const record: FakeCommitRecord = {
      sha,
      message,
      author: committer,
      timestamp,
      branch,
      snapshot: new Map(branchState.files),
      changedPaths: changes.map((c) => c.path),
    };
    state.commits.push(record);
    branchState.headSha = sha;
    return { sha, message, author: committer, timestamp, url: `https://fake.git/${repo}/commit/${sha}` };
  }

  async createCommit(
    repo: string,
    changes: FileChange[],
    message: string,
    branch: string,
    committer: CommitAuthor,
  ): Promise<Commit> {
    checkScriptedFailure('createCommit');
    return this.applyCommit(repo, branch, changes, message, committer);
  }

  async createCommitWithFallback(
    repo: string,
    changes: FileChange[],
    message: string,
    branch: string,
    committer: CommitAuthor,
    options?: CommitFallbackOptions,
  ): Promise<CommitWithFallbackResult> {
    checkScriptedFailure('createCommitWithFallback');
    const state = requireRepo(repo);

    if (!options?.forcePullRequest) {
      const commit = this.applyCommit(repo, branch, changes, message, committer);
      return { landed: 'branch', commit };
    }

    // require_pull_request policy path: land on a separate head branch,
    // branched from the target branch's current head, and open/reuse a PR.
    const baseBranch = state.branches.get(branch);
    if (!baseBranch) throw new RepositoryNotFoundError('github', repo);

    const headBranchName =
      options.headBranchName ??
      `${options.headBranchPrefix ?? 'outerlayer/dataset'}/${options.headBranchSlug ?? 'changes'}-${randomUUID().slice(0, 8)}`;

    let existingPr = state.pullRequests.find((pr) => pr.headBranch === headBranchName && pr.state === 'open');
    if (!state.branches.has(headBranchName)) {
      state.branches.set(headBranchName, { headSha: baseBranch.headSha, files: new Map(baseBranch.files) });
    }

    const commit = this.applyCommit(repo, headBranchName, changes, message, committer);

    let action: 'created' | 'updated';
    if (existingPr) {
      action = 'updated';
    } else {
      existingPr = {
        number: state.nextPrNumber++,
        headBranch: headBranchName,
        baseBranch: branch,
        state: 'open',
        url: `https://fake.git/${repo}/pull/${state.nextPrNumber - 1}`,
      };
      state.pullRequests.push(existingPr);
      action = 'created';
    }

    return {
      landed: 'pull_request',
      commit,
      pullRequestUrl: existingPr.url,
      pullRequestNumber: existingPr.number,
      fallbackBranch: headBranchName,
      pullRequestAction: action,
      fallbackReason: 'forced',
    };
  }

  async compareCommits(repo: string, base: string, head: string): Promise<FileDiff[]> {
    checkScriptedFailure('compareCommits');
    const state = repos.get(repo);
    const baseCommit = state?.commits.find((c) => c.sha === base);
    const headCommit = state?.commits.find((c) => c.sha === head);
    const baseFiles = baseCommit?.snapshot ?? new Map<string, string>();
    const headFiles = headCommit?.snapshot ?? new Map<string, string>();

    const diffs: FileDiff[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before === after) continue;
      diffs.push({
        path,
        status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
        additions: after ? after.split('\n').length : 0,
        deletions: before ? before.split('\n').length : 0,
        sha: fakeBlobSha(after ?? before ?? ''),
      });
    }
    return diffs;
  }

  async getCommitHistory(repo: string, options: CommitHistoryOptions): Promise<CommitHistoryResult> {
    checkScriptedFailure('getCommitHistory');
    const state = repos.get(repo);
    const all = (state?.commits ?? [])
      .filter((c) => c.branch === options.branch)
      .filter((c) => !options.path || c.changedPaths.includes(options.path))
      .slice()
      .reverse(); // newest first

    const page = options.page ?? 1;
    const perPage = options.perPage ?? 10;
    const start = (page - 1) * perPage;
    const pageCommits = all.slice(start, start + perPage);

    const commits: CommitWithPath[] = pageCommits.map((c) => ({
      sha: c.sha,
      message: c.message,
      author: c.author,
      timestamp: c.timestamp,
      url: `https://fake.git/${repo}/commit/${c.sha}`,
      filePath: options.path ?? c.changedPaths[0] ?? '',
    }));

    return { commits, hasMore: start + perPage < all.length };
  }

  async listPullRequests(repo: string, options: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
    checkScriptedFailure('listPullRequests');
    const state = repos.get(repo);
    const prs = state?.pullRequests ?? [];
    return prs.slice(0, options.limit).map((pr) => ({
      number: pr.number,
      authorId: null,
      draft: false,
      headBranch: pr.headBranch,
      headSha: state?.branches.get(pr.headBranch)?.headSha ?? null,
      baseBranch: pr.baseBranch,
      state: pr.state,
      url: pr.url,
      openedAt: null,
      closedAt: null,
      mergedAt: null,
    }));
  }

  async registerWebhook(_repo: string, webhookUrl: string): Promise<WebhookRegistration> {
    checkScriptedFailure('registerWebhook');
    return {
      id: `fake-webhook-${randomUUID()}`,
      url: webhookUrl,
      active: true,
      events: ['push'],
      createdAt: new Date().toISOString(),
    };
  }

  async removeWebhook(_repo: string, _webhookId: string): Promise<void> {
    checkScriptedFailure('removeWebhook');
  }

  async verifyWebhookSignature(_payload: string, _signature: string, _secret: string): Promise<boolean> {
    checkScriptedFailure('verifyWebhookSignature');
    return true;
  }
}

/**
 * Overrides the `'github'` provider registry entry so every
 * `createGitProviderForApp` call in this test process resolves a
 * `FakeGitProvider` instead of constructing a real GitHub App client — no
 * installation token, no Octokit. Returns a restore function; pair with
 * `beforeAll`/`afterAll` (the override is process-wide, not per-test).
 *
 * Seed a `git_connection` row with `provider: 'github'` and any
 * `installation_id` (the fake ignores it) to route an app at this fixture.
 */
export function installFakeGitProvider(): () => void {
  return overrideProviderFactoryForTesting('github', async () => new FakeGitProvider());
}
