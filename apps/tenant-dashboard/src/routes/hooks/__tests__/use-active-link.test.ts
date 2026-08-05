// @vitest-environment jsdom
/**
 * useActiveLink — sidebar active-state matching.
 *
 * The Dashboard nav item's path is the env overview ("/env/<env>"), which is
 * the URL parent of every other tab. A substring/prefix match marks Dashboard
 * active on every route (double-highlight with the current tab), so the env
 * root must only match exactly while real tabs still match their child routes.
 */
import { renderHook } from '@testing-library/react';

import { useActiveLink } from '../use-active-link';

const mockUsePathname = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ orgName: 'test-org', appName: 'test-app' }),
  usePathname: () => mockUsePathname(),
}));

const BASE = '/orgs/test-org/apps/test-app';

const isActive = (itemPath: string, currentPathname: string) => {
  mockUsePathname.mockReturnValue(currentPathname);
  return renderHook(() => useActiveLink(itemPath)).result.current;
};

describe('useActiveLink', () => {
  it('marks the env root (Dashboard) active only on the env overview itself', () => {
    expect(isActive(`${BASE}/env/dev`, `${BASE}/env/dev`)).toBe(true);
  });

  it('does NOT mark the env root (Dashboard) active on a tab route', () => {
    expect(isActive(`${BASE}/env/dev`, `${BASE}/env/dev/templates`)).toBe(false);
    expect(isActive(`${BASE}/env/dev`, `${BASE}/env/dev/settings/api-keys`)).toBe(false);
  });

  it('keeps the env root (Dashboard) active on the dashboards surface it redirects to', () => {
    expect(isActive(`${BASE}/env/dev`, `${BASE}/env/dev/dashboards`)).toBe(true);
    expect(
      isActive(`${BASE}/env/dev`, `${BASE}/env/dev/dashboards/42e00b82-8af7-467e-b94d-ce0917cd1b0f`),
    ).toBe(true);
    // segment boundary: a sibling route sharing the name prefix must not match
    expect(isActive(`${BASE}/env/dev`, `${BASE}/env/dev/dashboards-archive`)).toBe(false);
  });

  it('marks a tab active on its own route', () => {
    expect(isActive(`${BASE}/env/dev/templates`, `${BASE}/env/dev/templates`)).toBe(true);
  });

  it('keeps a tab active on its child routes', () => {
    expect(
      isActive(`${BASE}/env/dev/templates`, `${BASE}/env/dev/templates/greeting.prompt.mdx`),
    ).toBe(true);
    expect(isActive(`${BASE}/env/dev/settings`, `${BASE}/env/dev/settings/api-keys`)).toBe(true);
  });

  it('does NOT mark a tab active on a sibling tab', () => {
    expect(isActive(`${BASE}/env/dev/templates`, `${BASE}/env/dev/traces`)).toBe(false);
  });

  it('does NOT mark a tab active on a sibling sharing its name as a prefix', () => {
    expect(isActive(`${BASE}/env/dev/traces`, `${BASE}/env/dev/traces-archive`)).toBe(false);
  });

  it('matches app-level (no env segment) paths exactly and on children', () => {
    expect(isActive(`${BASE}/setup`, `${BASE}/setup`)).toBe(true);
    expect(isActive(`${BASE}/setup`, `${BASE}/env/dev/templates`)).toBe(false);
  });
});
