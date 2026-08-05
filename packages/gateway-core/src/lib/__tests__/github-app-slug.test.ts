/**
 * getGithubAppSlug — derives the GitHub App's public slug from GET /app
 * (replacing the hand-set GITHUB_APP_SLUG env var) and memoizes it.
 *
 * The `octokit` App is mocked so we assert the request contract, the App
 * credentials, and the cache/error behaviour without real network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory below can reference them (vi.mock is
// lifted above imports; a plain const would be in the TDZ). appCtorArgs
// records what `new App(...)` was constructed with, so we can assert the
// gateway authenticates with the real App credentials (not a wrong env var).
const { requestMock, appCtorArgs } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  appCtorArgs: [] as unknown[],
}));

vi.mock('octokit', () => ({
  App: class {
    octokit = { request: requestMock };
    constructor(opts: unknown) {
      appCtorArgs.push(opts);
    }
  },
}));

import {
  getGithubAppSlug,
  __resetGithubAppSlugCacheForTests,
} from '../github-app-slug';
import { GitConnectConfigurationError } from '../../services/git-connect-service';

const ENV = {
  GITHUB_APP_ID: '984275',
  GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
} as unknown as Parameters<typeof getGithubAppSlug>[0];

describe('getGithubAppSlug', () => {
  beforeEach(() => {
    requestMock.mockReset();
    appCtorArgs.length = 0;
    __resetGithubAppSlugCacheForTests();
  });

  it('authenticates as the App and returns the slug from GET /app', async () => {
    requestMock.mockResolvedValue({ data: { slug: 'agentmarkai' } });

    await expect(getGithubAppSlug(ENV)).resolves.toBe('agentmarkai');
    // Right endpoint…
    expect(requestMock).toHaveBeenCalledWith('GET /app');
    // …and the App is built with OUR App's id + key, not some other env
    // var — a swap would mint a JWT for the wrong App and silently break.
    expect(appCtorArgs[0]).toEqual({
      appId: '984275',
      privateKey: 'fake-private-key',
    });
  });

  it('memoizes the slug — a second call does not hit GET /app again', async () => {
    requestMock.mockResolvedValue({ data: { slug: 'agentmarkai' } });

    await getGithubAppSlug(ENV);
    await getGithubAppSlug(ENV);

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('throws a config error naming the missing slug when GET /app returns no/empty body', async () => {
    // Null body exercises the optional-chain guard: a clean "no slug"
    // config error, not a raw TypeError on `data.slug`.
    requestMock.mockResolvedValue({ data: null });

    const err = await getGithubAppSlug(ENV).catch((e) => e);
    expect(err).toBeInstanceOf(GitConnectConfigurationError);
    expect(err.message).toMatch(/no slug/i);
  });

  it('maps a GET /app failure to a config error carrying the HTTP status', async () => {
    requestMock.mockRejectedValue(
      Object.assign(new Error('bad credentials'), { status: 401 }),
    );

    const err = await getGithubAppSlug(ENV).catch((e) => e);
    expect(err).toBeInstanceOf(GitConnectConfigurationError);
    expect(err.message).toMatch(/Failed to resolve GitHub App slug/);
    expect(err.message).toMatch(/status=401/);
  });

  it('labels the status "unknown" when the failure carries no HTTP status', async () => {
    requestMock.mockRejectedValue(new Error('network down'));

    await expect(getGithubAppSlug(ENV)).rejects.toThrow(/status=unknown/);
  });

  it('does NOT cache a failure — a later success still resolves', async () => {
    requestMock.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { status: 502 }),
    );
    await expect(getGithubAppSlug(ENV)).rejects.toBeInstanceOf(
      GitConnectConfigurationError,
    );

    requestMock.mockResolvedValue({ data: { slug: 'agentmarkai' } });
    await expect(getGithubAppSlug(ENV)).resolves.toBe('agentmarkai');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
