// @vitest-environment jsdom
/**
 * Tests for the EnvContext provider.
 *
 * Default-env-only posture: the multi-env UI (breadcrumb switcher, promotion)
 * is removed, so the provider ALWAYS resolves the app's default env (`dev`) and
 * IGNORES any `/env/<name>/` path segment. It still owns `setEnv`/`envPath` for
 * the sidebar nav, which now scope every href to the default env.
 *
 * Boundaries:
 *  - The gateway `/v1/environments` HTTP call is backed by MSW
 *    (`seedEnvironmentsMswState`) — never a hand-rolled fetch mock.
 *  - `next/navigation` (`usePathname`/`useRouter`/`useSearchParams`) is the
 *    URL seam — overridden per test.
 *  - `@/lib/app-shell/app-context` (`useAppContext`) is a React-context seam.
 *  - `@/supabaseFrontendClient` is the browser-session seam `gatewayFetch`
 *    reads for its bearer token — mocked WITH the SHARED frontend-session
 *    helper; the token is declared with `seedGatewaySession()`.
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import {
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';

import {
  seedEnvironmentsMswState,
  seedGatewaySession,
} from '../test-helpers/msw-handlers';
import type { Environment } from '@/types/environment';

import { EnvProvider, useEnvContext, DEFAULT_ENV_NAME } from './env-context';

vi.mock('@/supabaseFrontendClient', () =>
  import('@/test-helpers/msw-handlers/frontend-session'),
);

const mockApp: { id: string } | null = { id: 'app-1' };
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => ({ app: mockApp }),
}));

const APP_ID = 'app-1';
const APP_BASE = '/orgs/tenant-1/apps/app-1';

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

/** Point `usePathname` at a concrete app path for the test. */
function setPathname(path: string) {
  vi.mocked(usePathname).mockReturnValue(path);
}

/** Point `useSearchParams` at a query string (defaults to empty). */
function setSearchParams(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

/** Capture `router.push` calls so the `setEnv` write path can be asserted. */
function setupRouter() {
  const push = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  return push;
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
  setPathname(`${APP_BASE}/env/dev/traces`);
  setSearchParams('');
  setupRouter();
});

describe('EnvContext — default-env-only resolution', () => {
  it('resolves the default env even when the path names a real non-default env', async () => {
    // A hand-typed URL naming a real, non-default env. The multi-env UI is gone,
    // so the provider must NOT scope to it — it renders the default env instead.
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });
    // Exact pin: default env, sourced as the implicit default (not the URL).
    expect(result.current.selectedEnv.name).toBe(DEFAULT_ENV_NAME);
    expect(result.current.selectedEnv.isDefault).toBe(true);
    expect(result.current.selectedEnv.isPinned).toBe(false);
    expect(result.current.selectedEnv.isUnknown).toBe(false);
    expect(result.current.selectedEnv.nameSource).toBe('default');
  });

  it('resolves the default env when the path has no env segment', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/setup`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });
    expect(result.current.selectedEnv.name).toBe(DEFAULT_ENV_NAME);
    expect(result.current.selectedEnv.isDefault).toBe(true);
    expect(result.current.selectedEnv.nameSource).toBe('default');
  });

  it('does NOT push a recovery redirect for an /env/<other>/ URL', async () => {
    // There is no deleted-env recovery effect any more — the pin forces
    // `nameSource: 'default'`, so a stray env URL is rendered-as-default
    // WITHOUT a URL rewrite (the env UI is unreachable anyway).
    const push = setupRouter();
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });

    expect(push).not.toHaveBeenCalled();
  });

  it('does NOT push recovery when the default env itself is unseeded', async () => {
    const push = setupRouter();
    seedEnvironmentsMswState({ [APP_ID]: [] });
    setPathname(`${APP_BASE}/setup`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.selectedEnv.isUnknown).toBe(true);
    });

    expect(result.current.selectedEnv).toEqual(
      expect.objectContaining({
        name: DEFAULT_ENV_NAME,
        id: null,
        isDefault: true,
        isUnknown: true,
        nameSource: 'default',
      }),
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('EnvContext — useEnvContext guard', () => {
  it('throws when useEnvContext is called outside an EnvProvider', () => {
    expect(() => renderHook(() => useEnvContext())).toThrow(
      'useEnvContext must be used within an <EnvProvider>',
    );
  });
});

describe('EnvContext — setEnv write path', () => {
  it('rewrites the env segment in place when selecting a different env', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/dev/traces`);
    const push = setupRouter();

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });

    act(() => {
      result.current.setEnv('staging');
    });

    // The tab segment (`/traces`) is preserved; only the env name changes.
    expect(push).toHaveBeenCalledWith(`${APP_BASE}/env/staging/traces`);
  });

  it('drops the page cursor when switching env, preserving other query params', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);
    setSearchParams('page=3&q=hello');
    const push = setupRouter();

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.name).toBe(DEFAULT_ENV_NAME);
    });

    act(() => {
      result.current.setEnv(DEFAULT_ENV_NAME);
    });

    // `page` is dropped (cursor invalidated); `q` survives.
    expect(push).toHaveBeenCalledWith(`${APP_BASE}/env/dev/traces?q=hello`);
  });

  // setEnv's no-env-segment insertion branch mirrors envPath's unconditional
  // insert guard — it must not rewrite an app-level (env-less) path either.
  it('does not inject an env segment when called while on the env-less context path', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/context`);
    const push = setupRouter();

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.name).toBe(DEFAULT_ENV_NAME);
    });

    act(() => {
      result.current.setEnv('staging');
    });

    expect(push).toHaveBeenCalledWith(`${APP_BASE}/context`);
  });
});

describe('EnvContext — envPath helper', () => {
  it('inserts the default env segment into a bare app path', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });

    // The current env is always the default (`dev`), so that is what is injected.
    expect(result.current.envPath(`${APP_BASE}/templates`)).toBe(
      `${APP_BASE}/env/dev/templates`,
    );
  });

  it('leaves a path that already carries an env segment untouched (idempotent)', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });

    // A path already scoped to staging is not re-pointed at the default.
    expect(result.current.envPath(`${APP_BASE}/env/staging/templates`)).toBe(
      `${APP_BASE}/env/staging/templates`,
    );
  });

  it('returns a non-app path unchanged', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });

    expect(result.current.envPath('/orgs/tenant-1/settings')).toBe(
      '/orgs/tenant-1/settings',
    );
  });

  // envPath must not inject `/env/<name>/` into every app path lacking one —
  // the intentionally env-less `appPaths.context` is exempt, since
  // `/orgs/<o>/apps/<a>/env/<env>/context` has no matching route (404).
  it('leaves the env-less context path untouched (bug #4 APP_LEVEL_SEGMENTS exemption)', async () => {
    seedEnvironmentsMswState({ [APP_ID]: [devEnv, stagingEnv] });
    setPathname(`${APP_BASE}/env/staging/traces`);

    const { result } = renderHook(() => useEnvContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedEnv.id).toBe('env-dev');
    });

    expect(result.current.envPath(`${APP_BASE}/context`)).toBe(`${APP_BASE}/context`);
  });
});
