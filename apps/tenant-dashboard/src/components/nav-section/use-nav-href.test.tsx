// @vitest-environment jsdom
/**
 * Tests for `useNavHref` — the render-time seam that injects the selected
 * env's `/env/<name>/` segment into the sidebar's static, env-less
 * `appPaths.*` nav items.
 *
 * Default-env-only posture: the multi-env UI is removed, so `EnvProvider`
 * always resolves the app's default env (`dev`) and ignores any `/env/<name>/`
 * path segment. `useNavHref` therefore injects `/env/dev/` — never a
 * hand-typed non-default segment.
 *
 * `appPaths.context` is a documented app-level (env-less) surface;
 * `envPath` must not inject an env segment into it — doing so would produce
 * `/orgs/<o>/apps/<a>/env/<env>/context`, a 404. This file pins that
 * exemption.
 *
 * Boundaries: same as `env-context.test.tsx` — the gateway environments call
 * is backed by MSW, and the component renders inside the REAL `<EnvProvider>`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { usePathname } from 'next/navigation';

import { seedEnvironmentsMswState, seedGatewaySession } from '@/test-helpers/msw-handlers';
import { appPaths } from '@/routes/paths';
import type { Environment } from '@/types/environment';

import { EnvProvider, useEnvContext } from '@/context/env-context';
import { useNavHref } from './use-nav-href';

vi.mock('@/supabaseFrontendClient', () =>
  import('@/test-helpers/msw-handlers/frontend-session'),
);

const mockApp: { id: string } | null = { id: 'app-1' };
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => ({ app: mockApp }),
}));

const APP_ID = 'app-1';
const APP_BASE = '/orgs/org-1/apps/app-1';

const devEnv: Environment = {
  id: 'env-dev',
  name: 'dev',
  is_default: true,
  current_version: 0,
  current_commit_sha: null,
  epoch: 0,
  created_at: '2026-01-01T00:00:00Z',
  created_by_id: null,
};

const stagingEnv: Environment = {
  id: 'env-staging',
  name: 'staging',
  is_default: false,
  current_version: 7,
  current_commit_sha: 'fedc9876543210fedc9876543210fedc98765432',
  epoch: 1,
  created_at: '2026-01-02T00:00:00Z',
  created_by_id: 'user-1',
};

function setPathname(path: string) {
  vi.mocked(usePathname).mockReturnValue(path);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <EnvProvider>{children}</EnvProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  seedGatewaySession();
  seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
});

describe('useNavHref — env-scoped nav items', () => {
  it('injects the DEFAULT env segment into a bare (env-less) app nav item, ignoring any path segment', async () => {
    // Even on a hand-typed `/env/staging/` URL, the default-env-only provider
    // pins the selection to `dev` — so the injected segment is `/env/dev/`.
    setPathname(`${APP_BASE}/env/staging/insights`);

    const { result } = renderHook(
      () => {
        const ctx = useEnvContext();
        return { ctx, href: useNavHref(`${APP_BASE}/insights`) };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.ctx.selectedEnv.id).toBe('env-dev');
    });

    expect(result.current.href).toBe(`${APP_BASE}/env/dev/insights`);
  });

  it('leaves an already env-scoped nav item untouched', async () => {
    setPathname(`${APP_BASE}/env/dev/insights`);

    const { result } = renderHook(
      () => {
        const ctx = useEnvContext();
        return {
          ctx,
          href: useNavHref(appPaths.insights.root('org-1', 'app-1', 'staging')),
        };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.ctx.selectedEnv.id).toBe('env-dev');
    });

    // The path already carries an `/env/<name>/` segment — untouched.
    expect(result.current.href).toBe(`${APP_BASE}/env/staging/insights`);
  });

  it('leaves the Context nav item env-less (APP_LEVEL_SEGMENTS exemption)', async () => {
    setPathname(`${APP_BASE}/env/dev/insights`);

    const { result } = renderHook(
      () => {
        const ctx = useEnvContext();
        return {
          ctx,
          href: useNavHref(appPaths.context.root('org-1', 'app-1')),
        };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.ctx.selectedEnv.id).toBe('env-dev');
    });

    expect(result.current.href).toBe(`${APP_BASE}/context`);
  });
});
