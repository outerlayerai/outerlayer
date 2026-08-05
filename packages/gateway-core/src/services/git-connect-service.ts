/**
 * GitConnectService — builds the GitHub App install URL with an
 * HMAC-signed state token.
 *
 *   https://github.com/apps/<slug>/installations/new?state=<signed>
 *
 * After install, GitHub redirects to the App's configured callback (set
 * in the GitHub App settings) with `installation_id` + `state`, which the
 * dashboard callback validates before persisting the connection — that's
 * standard OAuth state behaviour and the basis of our CSRF defense.
 */

import {
  signGitConnectState,
  GIT_CONNECT_STATE_TTL_SECONDS,
  type GitConnectStatePayload,
} from '../lib/git-connect-state';
import type { GitProvider } from '@repo/api-schemas';

export class GitConnectConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitConnectConfigurationError';
  }
}

export interface BuildAuthorizationUrlInput {
  appId: string;
  tenantId: string;
  provider: GitProvider;
}

export interface BuildAuthorizationUrlResult {
  authorizationUrl: string;
  state: string;
  /** ISO-8601 expiry the caller can render verbatim to the user. */
  expiresAt: string;
  payload: GitConnectStatePayload;
}

export interface GitConnectServiceConfig {
  oauthStateSecret: string;
  /**
   * Resolves the GitHub App's public slug (the `<slug>` in
   * `github.com/apps/<slug>`). Injected as a thunk rather than passed as
   * a string so the value is sourced from the App itself (`GET /app`)
   * instead of a hand-maintained env var that can silently drift from
   * reality — see `lib/github-app-slug.ts`.
   */
  resolveGithubAppSlug: () => Promise<string>;
}

export class GitConnectService {
  constructor(private readonly config: GitConnectServiceConfig) {}

  async buildAuthorizationUrl(
    input: BuildAuthorizationUrlInput,
  ): Promise<BuildAuthorizationUrlResult> {
    const { token, payload } = await signGitConnectState({
      secret: this.config.oauthStateSecret,
      appId: input.appId,
      tenantId: input.tenantId,
      provider: input.provider,
    });

    const url = await this.buildGithubUrl(token);

    return {
      authorizationUrl: url,
      state: token,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      payload,
    };
  }

  private async buildGithubUrl(state: string): Promise<string> {
    // GitHub App install URL. The slug is the human-readable identifier
    // in the App's URL — distinct from the numeric `GITHUB_APP_ID`. We
    // resolve it from the App itself (`GET /app`) rather than config, so
    // a stale or typo'd value can't silently 404 — see
    // `lib/github-app-slug.ts`. Still URL-encoded defensively.
    const slug = await this.config.resolveGithubAppSlug();
    if (!slug) {
      throw new GitConnectConfigurationError(
        'GitHub App slug could not be resolved',
      );
    }
    const search = new URLSearchParams({ state });
    return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${search.toString()}`;
  }
}

export { GIT_CONNECT_STATE_TTL_SECONDS };
