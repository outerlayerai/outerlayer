/**
 * Default-env-only posture for the env-scoped settings pages (api-keys,
 * integrations, env-vars): the multi-env UI is removed, so the `/env/<name>/`
 * path segment is NEVER a user choice — each page drops it (envParam: undefined
 * → the storage resolver falls back to the app's default env row), and the
 * settings layout header always names the default env, regardless of a
 * hand-typed `/env/<other>/settings/…` URL.
 *
 * The pages are thin async server components that only decide what `envParam`
 * to hand their section; asserting on the returned element tree pins exactly
 * that contract without booting the sections' Supabase queries.
 *
 * Boundaries: `getAppIdByName` / `getAppPermissionSet` are the integration
 * page's data/permission seams.
 */
import type React from 'react';

// The integrations page resolves the app + permission set before returning its
// tree. Both are true seams (stable-signature functions, not wire format).
vi.mock('@/utils/get-app-id', () => ({
  getAppIdByName: () => Promise.resolve('app-1'),
}));
vi.mock('@/utils/get-app-permissions', () => ({
  getAppPermissionSet: () => Promise.resolve(new Set(['api_key.read', 'env_var.read'])),
}));

import ApiKeysPage from '../api-keys/page';
import EnvVarsPage from '../env-vars/page';
import AppSettingsLayout from '../layout';

const PARAMS = Promise.resolve({
  orgName: 'org-1',
  appName: 'app-one',
  envName: 'staging',
});

describe('env-scoped settings pages — always resolve the default env', () => {
  it('api-keys drops the path env (→ default) regardless of the URL segment', async () => {
    const tree = await ApiKeysPage({ params: PARAMS });
    expect((tree.props as { envParam?: string }).envParam).toBeUndefined();
  });

  it('env-vars drops the path env (→ default)', async () => {
    const tree = await EnvVarsPage({ params: PARAMS });
    const content = (tree.props as { children: React.ReactElement }).children;
    expect((content.props as { envParam?: string }).envParam).toBeUndefined();
  });

  it('the settings layout header names the DEFAULT env, not the path segment', async () => {
    const tree = await AppSettingsLayout({ children: null, params: PARAMS });
    expect((tree.props as { description?: string }).description).toBe(
      'app-one · dev environment',
    );
  });
});
