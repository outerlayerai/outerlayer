/**
 * The ONE canonicalizer for the repository identity behind the PR session
 * comment.
 *
 * Three producers name the same repository in three different ways:
 *   - the `pull_request` webhook and the hourly cron sweep pass
 *     `git_connection.repository`'s own bare `owner/repo`;
 *   - the sync-ingest queue producer passes ClickHouse
 *     `agent_session_summary.GitRepo`, which is host-qualified
 *     (`github.com/owner/repo`);
 *   - a `.git` suffix or a `https://` prefix can ride along on either.
 *
 * Every downstream read and write of the comment — the `pr_session_comment`
 * identity row, the `git_connection` installation lookup, the GitHub API
 * call — keys off ONE form: LOWERCASE bare `owner/repo`. Two spellings of
 * one repository produce two identity rows and therefore two comments on one
 * PR, which the one-comment-per-PR guarantee forbids, so this function is
 * deliberately the only
 * place that decides what the key is, and it is shared by the producer, the
 * queue consumer, and the orchestrator rather than re-derived at each
 * boundary. Lowercasing is part of that one form: GitHub owner/repo routes
 * are case-insensitive, so `Acme/API` and `acme/api` are the same repository
 * and must collapse to the same identity row rather than fork into two on a
 * casing difference between where the name came from (a git remote vs.
 * GitHub's own `full_name`).
 *
 * STRICT BY DESIGN: anything that does not reduce to a GitHub `owner/repo`
 * — a GitHub Enterprise Server host, an ssh/scp remote, a local path — is
 * `null`, not a best-effort guess. A silently mis-parsed key is the exact
 * failure that posts a second comment; a `null` makes the caller fail
 * loudly (or skip) instead. The feature is GitHub.com-only today, and this
 * is where that assumption is stated.
 */

/** github.com, optionally scheme- and/or `www.`-prefixed. */
const GITHUB_HOST_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?github\.com\//i;
/** `owner/repo`, GitHub's own character set for both segments. */
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * `repository` in any of the accepted spellings → the canonical LOWERCASE
 * bare `owner/repo`, or `null` when it isn't a GitHub.com repository this
 * feature can address.
 */
export function canonicalPrCommentRepo(repository: string | null | undefined): string | null {
  if (!repository) return null;
  const trimmed = repository.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  const withoutHost = trimmed.replace(GITHUB_HOST_PREFIX, '');
  // Only the repo segment carries a `.git` suffix; the regex below rejects
  // anything with a second slash, so this can't eat a path component.
  const withoutSuffix = withoutHost.replace(/\.git$/i, '');

  return OWNER_REPO.test(withoutSuffix) ? withoutSuffix.toLowerCase() : null;
}
