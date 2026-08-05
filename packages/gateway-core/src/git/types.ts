export type GitProviderType = "github";

/**
 * Summary metadata for a repository visible to the installation.
 *
 * `full_name` is the canonical form callers send back to `link` /
 * `branches` (e.g. `acme-inc/triage-bot`). `default_branch` is
 * provider-reported and exists so UIs can pre-select a sensible
 * branch in the picker — callers should not rely on it as authoritative
 * because admins can change a repo's default after the listing was
 * cached.
 */
export interface GitRepositorySummary {
  fullName: string;
  name: string;
  defaultBranch: string;
}

export interface GitFileProvider {
  streamFile(
    repository: string,
    path: string,
    ref: string
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * List repositories accessible to the installation/token. Used by
   * the headless link flow so callers can discover repos without
   * hitting the Dashboard.
   *
   * Implementations should paginate internally — callers expect the
   * full set. Pagination shouldn't leak through the gateway surface.
   */
  listRepositories(): Promise<GitRepositorySummary[]>;

  /**
   * List branch names for a repository. Used by the headless link
   * flow so callers can choose a branch to watch. Implementations
   * paginate internally.
   */
  listBranches(repository: string): Promise<string[]>;

  /**
   * Latest commit SHA on a branch. Used to seed `app.commit_sha`
   * during link so the dashboard's "current commit" display has a
   * meaningful value before the first deploy. Returns `null` on any
   * provider error rather than throwing — link should still succeed
   * if this auxiliary fetch fails.
   */
  getLatestCommitSha(repository: string, branch: string): Promise<string | null>;
}

export interface GitProviderContext {
  provider: GitProviderType;
  /** GitHub App installation ID */
  installationId?: number;
}

/**
 * Raised by `createGitProvider` when a `git_connection.provider` value has
 * no matching implementation — a row (e.g. `provider: 'gitlab'`) whose value
 * the schema accepts but the factory cannot build a client for. Routes must
 * map this to a structured 4xx, not a 500: the row is real and readable
 * (see `GitConnectionStatusResponseSchema`), it simply cannot reach a
 * provider.
 */
export class UnsupportedGitProviderError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(
      `This app is linked via "${provider}", which is no longer supported. Reconnect with GitHub.`,
    );
    this.name = 'UnsupportedGitProviderError';
    this.provider = provider;
  }
}
