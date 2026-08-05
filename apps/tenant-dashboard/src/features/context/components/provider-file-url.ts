/**
 * Deep link to a file on the git provider's web UI, for the viewer's oversize
 * "view on your provider" CTA. Pure: provider type + `owner/name`
 * repo + branch + repo-relative path in, browse URL out. Hosts default to the
 * public SaaS instances (self-hosted GitLab is a later concern); an unknown
 * provider or a missing branch yields `undefined` so the CTA falls back to the
 * generic "open it in your repository" copy rather than a broken link.
 */
export function providerFileUrl(input: {
  provider: string | null | undefined;
  repository: string | null | undefined;
  branch: string | null | undefined;
  path: string;
}): string | undefined {
  const { provider, repository, branch, path } = input;
  if (!repository || !branch) return undefined;

  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

  switch (provider) {
    // Default to GitHub for legacy connections with no provider recorded,
    // matching createGitProviderForApp's own fallback.
    case undefined:
    case null:
    case "":
    case "github":
      return `https://github.com/${repository}/blob/${branch}/${encodedPath}`;
    case "gitlab":
      return `https://gitlab.com/${repository}/-/blob/${branch}/${encodedPath}`;
    default:
      return undefined;
  }
}
