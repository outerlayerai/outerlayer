/**
 * getGithubApp on a deployment with no GitHub App key.
 *
 * GITHUB_APP_PRIVATE_KEY is optional config, so this is reachable rather than
 * theoretical: a staging environment can run for weeks without it. Constructing
 * an App around `undefined` defers the failure to whatever request happens
 * first, where it surfaces as an opaque auth error far from the cause. Fail
 * here, naming the variable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

async function importWith(privateKey: string | undefined) {
  vi.resetModules();
  vi.doMock('../config-global.server', () => ({
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: privateKey,
  }));
  return import('../octo-kit');
}

describe('getGithubApp', () => {
  afterEach(() => {
    vi.doUnmock('../config-global.server');
    vi.resetModules();
  });

  it('throws naming the missing variable when the private key is unset', async () => {
    const { getGithubApp } = await importWith(undefined);

    expect(() => getGithubApp()).toThrow(/GITHUB_APP_PRIVATE_KEY is unset/);
  });

  it('treats an empty key as unset rather than handing it to Octokit', async () => {
    const { getGithubApp } = await importWith('');

    expect(() => getGithubApp()).toThrow(/GITHUB_APP_PRIVATE_KEY is unset/);
  });
});
