/**
 * Resolve the GitHub App's public slug — the `<slug>` segment in the
 * install URL `https://github.com/apps/<slug>/installations/new`.
 *
 * The slug is derived from the App's own credentials rather than configured
 * separately. A hand-maintained slug value silently 404s whenever it drifts
 * from the App's real slug, and GitHub owns that 404, so nothing on this side
 * would notice.
 *
 * Every git operation already authenticates AS the App (`GITHUB_APP_ID` +
 * `GITHUB_APP_PRIVATE_KEY`), and `GET /app` returns the App's own `slug`.
 * Reading it from the same credentials used to install makes the wrong-slug
 * failure impossible: there is no separate value left to mis-set.
 */
import { App } from "octokit";
import type { Env } from "../types";
import { GitConnectConfigurationError } from "../services/git-connect-service";

/**
 * Per-isolate memo. The slug is immutable for the App's lifetime and
 * `GET /app` is a cheap, idempotent call, so one lookup per isolate is
 * plenty. Only *successful* lookups are cached — a transient failure
 * (GitHub down, key rotation mid-flight) must not poison the cache and
 * wedge the connect flow for the isolate's whole lifetime.
 */
let cachedSlug: string | undefined;

export async function getGithubAppSlug(env: Env): Promise<string> {
  if (cachedSlug) return cachedSlug;

  let slug: string | undefined;
  try {
    const app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    const { data } = await app.octokit.request("GET /app");
    // `data` is typed nullable; `?.` keeps an empty body on the clean
    // "no slug" path below instead of throwing a raw TypeError.
    slug = data?.slug;
  } catch (err) {
    const status = (err as { status?: number }).status ?? "unknown";
    // Mapped to 503 `git_connect_not_configured` at the route — the
    // caller retries / ops verify the App credentials. Status only in
    // the operator-facing message, never the response body.
    throw new GitConnectConfigurationError(
      `Failed to resolve GitHub App slug via GET /app (status=${status})`,
    );
  }

  if (!slug) {
    throw new GitConnectConfigurationError(
      "GET /app returned no slug for the configured GitHub App",
    );
  }

  cachedSlug = slug;
  return slug;
}

/** Test-only: clear the per-isolate slug memo between cases. */
export function __resetGithubAppSlugCacheForTests(): void {
  cachedSlug = undefined;
}
