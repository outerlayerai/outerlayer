// @vitest-environment jsdom
/**
 * Composition tests for `<AppBreadcrumb>` — the header context trail.
 *
 * These pin the breadcrumb's OWN structural contract, independent of what each
 * segment renders internally: the App segment and its leading separator
 * self-collapse on org-level routes, the in-app trail has exactly one
 * separator (`aria-hidden`), and the root is a labelled `nav` landmark.
 *
 * Default-env-only posture: the multi-env UI is removed, so the breadcrumb has no
 * Env segment — it is `Org / App` only.
 *
 * Boundaries:
 *  - The two segment components (`OrgSelect`/`AppSelect`) are replaced with
 *    testid stubs — their data seams (SWR/Supabase/EnvContext) are exercised in
 *    their own suites; here they would only add noise.
 *  - `next/navigation`'s `useParams` is the route seam (globally stubbed by
 *    `unit-test-setup`); each test points it at an org-level or in-app route.
 */

import { render, screen } from '@testing-library/react';
import { useParams } from 'next/navigation';

vi.mock('./org-select', () => ({
  OrgSelect: () => <div data-testid="seg-org" />,
}));
vi.mock('./app-select', () => ({
  AppSelect: () => <div data-testid="seg-app" />,
}));

import { AppBreadcrumb } from './app-breadcrumb';

/** Count the `aria-hidden` separator markers inside the breadcrumb. */
function separatorCount(nav: HTMLElement): number {
  return nav.querySelectorAll('[aria-hidden="true"]').length;
}

describe('AppBreadcrumb — breadcrumb composition', () => {
  it('renders a single labelled `nav` landmark', () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'tenant-1' });
    render(<AppBreadcrumb />);

    const nav = screen.getByRole('navigation', {
      name: 'App navigation breadcrumb',
    });
    expect(nav).toBeInTheDocument();
  });

  it('collapses to the org segment alone on an org-level route (no dangling separators or app segment)', () => {
    // Org-level route: `appName` param absent.
    vi.mocked(useParams).mockReturnValue({ orgName: 'tenant-1' });
    render(<AppBreadcrumb />);

    const nav = screen.getByRole('navigation', {
      name: 'App navigation breadcrumb',
    });
    // Exactly the org segment — the App segment is gone, not merely hidden.
    expect(screen.getByTestId('seg-org')).toBeInTheDocument();
    expect(screen.queryByTestId('seg-app')).not.toBeInTheDocument();
    // …and with it, every separator: a lone org segment has none.
    expect(separatorCount(nav)).toBe(0);
  });

  it('renders nothing on the org picker route (no active org → no dead switcher)', () => {
    // /orgs has no orgName param; the breadcrumb must not render a chevron-only stub.
    vi.mocked(useParams).mockReturnValue({});
    render(<AppBreadcrumb />);
    expect(
      screen.queryByRole('navigation', { name: 'App navigation breadcrumb' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('seg-org')).not.toBeInTheDocument();
  });

  it('renders Org / App with exactly one aria-hidden separator inside an app route', () => {
    // In-app route: `appName` present unlocks the App segment.
    vi.mocked(useParams).mockReturnValue({
      orgName: 'tenant-1',
      appName: 'app-a',
    });
    render(<AppBreadcrumb />);

    const nav = screen.getByRole('navigation', {
      name: 'App navigation breadcrumb',
    });
    // Both segments present…
    expect(screen.getByTestId('seg-org')).toBeInTheDocument();
    expect(screen.getByTestId('seg-app')).toBeInTheDocument();
    // …joined by exactly one separator (org/app), no more.
    expect(separatorCount(nav)).toBe(1);
  });

  it('marks the separator aria-hidden so assistive tech never announces it', () => {
    vi.mocked(useParams).mockReturnValue({
      orgName: 'tenant-1',
      appName: 'app-a',
    });
    render(<AppBreadcrumb />);

    const nav = screen.getByRole('navigation', {
      name: 'App navigation breadcrumb',
    });
    const separators = nav.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(1);
    separators.forEach((sep) => {
      expect(sep.getAttribute('aria-hidden')).toBe('true');
    });
  });
});
