/**
 * Unified git-provider URL builder.
 *
 * Constructs a link into a git provider's web UI for either a commit (`type:
 * 'commit'`) or a single file at a commit (`type: 'blob'`, requires
 * `filePath`). New connections are GitHub-only; the `gitlab` case stays wired
 * so a repository row still carrying a legacy provider value renders a real
 * link. Returns `null` for any unknown provider or when a required piece
 * (repo / sha) is missing — callers then render no link rather than a broken
 * one.
 *
 * Consolidates three prior copies: `buildCommitUrl` (alerts — dead),
 * `buildProviderFileUrl` (pinned-env-chip — private), and a hardcoded inline
 * URL in `template-history.tsx`.
 */

/** What the URL should point at. */
interface BuildProviderUrlOptions {
  /** `'commit'` → the commit page; `'blob'` → a file at that commit. */
  type: 'commit' | 'blob';
  /** Repo-relative file path — required for `type: 'blob'`, ignored otherwise. */
  filePath?: string;
}

/**
 * Build a git-provider web URL for a commit or a file-at-commit.
 *
 * @param provider   git provider id (`'github'`, or a legacy `'gitlab'` row), or null/undefined.
 * @param repository `owner/repo`.
 * @param sha        the commit SHA.
 * @param opts       `{ type, filePath? }` — see {@link BuildProviderUrlOptions}.
 * @returns the URL, or `null` when it cannot be built.
 */
export function buildProviderUrl(
  provider: string | null | undefined,
  repository: string | null | undefined,
  sha: string | null | undefined,
  opts: BuildProviderUrlOptions,
): string | null {
  if (!sha || !repository) return null;

  if (opts.type === 'blob') {
    // A blob link needs a file path; without one there is nothing to link to.
    if (!opts.filePath) return null;
    const cleanPath = opts.filePath.replace(/^\/+/, '');
    switch (provider) {
      case 'github':
        return `https://github.com/${repository}/blob/${sha}/${cleanPath}`;
      case 'gitlab':
        return `https://gitlab.com/${repository}/-/blob/${sha}/${cleanPath}`;
      default:
        return null;
    }
  }

  // type === 'commit'
  switch (provider) {
    case 'github':
      return `https://github.com/${repository}/commit/${sha}`;
    case 'gitlab':
      return `https://gitlab.com/${repository}/-/commit/${sha}`;
    default:
      return null;
  }
}
