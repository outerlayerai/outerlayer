// @vitest-environment jsdom
/**
 * `(authenticated)/layout.tsx` — provider topology around the persistent header.
 *
 * The one property this file pins: `AppProvider` + `EnvProvider` wrap the
 * HEADER MOUNT POINT, not just the routed children. Mounting the
 * persistent `<AppHeader>` outside the providers regresses silently: because
 * `<AppBreadcrumb.EnvSelect>` self-hides without an `<EnvProvider>` above it,
 * the env selector silently vanished from every app page (caught only by the
 * post-merge staging e2e). A unit pin means the next chrome refactor fails
 * here, in PR CI, instead.
 *
 * SEAM CHOICES: the auth guards are permission gates (an allowed mock seam) —
 * they pass children through. `AppHeader` itself is replaced by a PROBE that
 * reads the real `useOptionalEnvContext()` + `useAppContext()` via the same
 * module instances the layout tree uses (dynamic `import()` inside the mock
 * factory resolves through the live module graph), so the assertions exercise
 * the genuine provider wiring, not a mocked context.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  // Org-level route: no `appName` param — the providers must still mount and
  // settle (AppProvider without querying; EnvProvider on the default env).
  useParams: () => ({}),
  usePathname: () => '/orgs/acme/settings',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../../../auth/guard', () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TermsGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../auth/hooks', () => ({
  useAuthContext: () => ({ user: { app_metadata: { tenant_id: 't1' } } }),
}));

// The probe stands where the real header stands. It reports whether the
// contexts are reachable from that exact position in the tree:
//  - `data-env`: 'present' only when an `<EnvProvider>` is above (the optional
//    accessor returns null outside one — the self-hide path that caused the
//    regression).
//  - `data-app-loading`: 'false' only when the value comes from a mounted
//    `<AppProvider>` that settled (the bare `createContext` DEFAULT pins
//    `loading: true`, so a missing provider reads 'true' here).
vi.mock('../../../layouts/app-header', async () => {
  const { useOptionalEnvContext } = await import('../../../context/env-context');
  const { useAppContext } = await import('@/lib/app-shell/app-context');
  function HeaderProbe() {
    const envContext = useOptionalEnvContext();
    const { loading } = useAppContext();
    return (
      <div
        data-testid="header-probe"
        data-env={envContext ? 'present' : 'absent'}
        data-app-loading={String(loading)}
        data-default-env={envContext?.selectedEnv.name ?? 'n/a'}
      />
    );
  }
  return { AppHeader: HeaderProbe };
});

import Layout from '../layout';

describe('(authenticated) layout — provider topology', () => {
  it('mounts the persistent header INSIDE AppProvider + EnvProvider (and the children too)', () => {
    render(
      <Layout>
        <div data-testid="routed-child" />
      </Layout>,
    );

    const probe = screen.getByTestId('header-probe');
    // EnvProvider above the header — without it EnvSelect self-hides and the
    // app loses its only env selector.
    expect(probe).toHaveAttribute('data-env', 'present');
    // AppProvider above the header, settled for an org-level route: the
    // provider value reads loading:false; the provider-less DEFAULT context
    // would read loading:true.
    expect(probe).toHaveAttribute('data-app-loading', 'false');
    // Outside an app route the selection degrades to the default env.
    expect(probe).toHaveAttribute('data-default-env', 'dev');

    // The routed content renders alongside the header, inside the same tree.
    expect(screen.getByTestId('routed-child')).toBeInTheDocument();
  });
});
