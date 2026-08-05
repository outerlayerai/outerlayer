// @vitest-environment jsdom
/**
 * Tests for useRepoConnect's checklist SWR key — the one piece of this hook the
 * banner test can't reach (it stubs SWR wholesale). The key is only built when
 * BOTH the org segment and the app id are present; otherwise it is null so SWR
 * makes no request. Pinning that here kills the `orgName && appId ? url : null`
 * mutants (the AND, and each branch of the ternary).
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockUseSWR, orgNameRef } = vi.hoisted(() => ({
  mockUseSWR: vi.fn(),
  orgNameRef: { current: 'org' as string | undefined },
}));

vi.mock('swr', () => ({ default: (...args: unknown[]) => mockUseSWR(...args) }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ orgName: orgNameRef.current }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@/lib/git-connect/start-git-connect-action', () => ({
  startGitConnectAction: vi.fn(),
}));

import { useRepoConnect } from './hooks';

/** The SWR key useRepoConnect handed to useSWR on the last render. */
const keyOf = () => mockUseSWR.mock.calls[0]?.[0] as string | null;

beforeEach(() => {
  vi.clearAllMocks();
  orgNameRef.current = 'org';
  mockUseSWR.mockReturnValue({ data: undefined, mutate: vi.fn() });
});

describe('useRepoConnect — checklist SWR key', () => {
  it('keys the canonical checklist URL when org + app are both present', () => {
    renderHook(() => useRepoConnect('app-1', 'banner'));
    expect(keyOf()).toBe(
      '/api/orgs/org/apps/app-1/onboarding/checklist?appId=app-1',
    );
  });

  it('passes a null key (no fetch) when the appId is empty — the AND, not an OR', () => {
    // org present, app empty: `orgName && appId` is falsy → null. An `||` mutant
    // would build the URL from just the org, so this pins the AND specifically.
    renderHook(() => useRepoConnect('', 'banner'));
    expect(keyOf()).toBeNull();
  });

  it('passes a null key when the org segment is unresolved', () => {
    orgNameRef.current = undefined;
    renderHook(() => useRepoConnect('app-1', 'banner'));
    expect(keyOf()).toBeNull();
  });
});