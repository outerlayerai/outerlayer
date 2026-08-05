// @vitest-environment jsdom
/**
 * Tests for useSetupGate — the onboarding v2 guard the trace-family pages
 * (Dashboard, Traces, Sessions, Requests) use to swap in the shared
 * Getting Started card before the app's first trace (in place — no
 * redirect, no per-page placeholder drift).
 *
 * The contract under test (a pure derivation — full truth table):
 *  - loading → pending true, showSetup false (returning users must never
 *    see the card flash while the trace check is in flight)
 *  - resolved + app + no trace → showSetup true (render the card)
 *  - resolved + app + trace → both false (render the real page)
 *  - resolved + no app → showSetup false (nothing to set up)
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ctxRef } = vi.hoisted(() => ({
  ctxRef: {
    current: { app: null as { id: string } | null, loading: true, hasCreatedTrace: false },
  },
}));

vi.mock('@/lib/adapters/use-app-context', () => ({
  useAppContext: () => ctxRef.current,
}));

import { useSetupGate } from '../use-setup-gate';

beforeEach(() => {
  ctxRef.current = { app: null, loading: true, hasCreatedTrace: false };
});

describe('useSetupGate', () => {
  it('is pending (and NOT showing setup) while the trace check is loading', () => {
    ctxRef.current = { app: { id: 'app-1' }, loading: true, hasCreatedTrace: false };

    const { result } = renderHook(() => useSetupGate());

    expect(result.current).toEqual({ pending: true, showSetup: false });
  });

  it('shows the setup card exactly when the check resolves with no traces', () => {
    ctxRef.current = { app: { id: 'app-1' }, loading: false, hasCreatedTrace: false };

    const { result } = renderHook(() => useSetupGate());

    expect(result.current).toEqual({ pending: false, showSetup: true });
  });

  it('shows the real page once the app has a trace', () => {
    ctxRef.current = { app: { id: 'app-1' }, loading: false, hasCreatedTrace: true };

    const { result } = renderHook(() => useSetupGate());

    expect(result.current).toEqual({ pending: false, showSetup: false });
  });

  it('does not show setup when no app resolved', () => {
    ctxRef.current = { app: null, loading: false, hasCreatedTrace: false };

    const { result } = renderHook(() => useSetupGate());

    expect(result.current).toEqual({ pending: false, showSetup: false });
  });

  it('flips from card to real page in place when the first trace lands', () => {
    ctxRef.current = { app: { id: 'app-1' }, loading: false, hasCreatedTrace: false };
    const { result, rerender } = renderHook(() => useSetupGate());
    expect(result.current.showSetup).toBe(true);

    // AppProvider's has-traces poll resolves — same mount, new context.
    ctxRef.current = { app: { id: 'app-1' }, loading: false, hasCreatedTrace: true };
    rerender();

    expect(result.current).toEqual({ pending: false, showSetup: false });
  });
});
