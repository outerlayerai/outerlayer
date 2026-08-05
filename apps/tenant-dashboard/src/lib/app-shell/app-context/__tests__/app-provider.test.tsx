// @vitest-environment jsdom
/**
 * Tests for `<AppProvider>`.
 *
 * The provider opens no Supabase client: the `[appName]` React Server
 * Component (RSC) layout
 * resolves the app row server-side and a client `<AppSeeder>` pushes it up via
 * `AppSeedSetterContext`. These tests drive the provider through that same
 * seam (render `<AppSeeder app={row}>` as the child that seeds it) rather than
 * mocking a browser query, and pin:
 *
 *   1. The initial has-traces check FAILS CLOSED. A non-ok/thrown has-traces
 *      call must leave `hasCreatedTrace` false rather than fail open to `true`.
 *   2. `markTraceSeen()` flips the gate to true in place (powers the panel's
 *      "Check now" without a full page reload).
 *   3. `(authenticated)`-layout mount semantics: no seed on an org-level route,
 *      a synchronous render-time reset on app switch (no stale frame), and a
 *      stale seed landing after the route moved on is superseded by whichever
 *      seed arrives next (the seeder's own effect ordering, not a cancellation
 *      flag — there is no in-flight network call to cancel).
 *   4. The has-traces poll's visibility/wall-clock/self-scheduling behaviour.
 */

import { useEffect } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../test-helpers/msw-server';

const { fake } = vi.hoisted(() => ({
  fake: { appName: 'app' as string | undefined },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ appName: fake.appName, orgName: 'org-1' }),
}));

import { AppProvider } from '../app-provider';
import { AppSeeder } from '../app-seeder';
import { useAppContext } from '../use-app-context';
import type { AppWithGitConnection } from '../app-context';

const appRow = { id: 'app-1', name: 'app' } as unknown as AppWithGitConnection;

let capturedMarkTraceSeen: (() => void) | undefined;

function Consumer() {
  const { app, loading, hasCreatedTrace, markTraceSeen } = useAppContext();
  useEffect(() => {
    capturedMarkTraceSeen = markTraceSeen;
  }, [markTraceSeen]);
  return (
    <div>
      <span data-testid="has-trace">{String(hasCreatedTrace)}</span>
      <span data-testid="app-id">{app?.id ?? 'none'}</span>
      <span data-testid="loading">{String(loading)}</span>
    </div>
  );
}

/** Render the provider with a seeder pushing `app` — the `[appName]` RSC shape. */
const renderSeeded = (app: AppWithGitConnection | null) =>
  render(
    <AppProvider>
      <AppSeeder app={app}>
        <Consumer />
      </AppSeeder>
    </AppProvider>,
  );

/** Render the provider with NO seeder — the org-level-route shape. */
const renderUnseeded = () =>
  render(
    <AppProvider>
      <Consumer />
    </AppProvider>,
  );

const settled = (value: 'true' | 'false') =>
  waitFor(() => expect(screen.getByTestId('has-trace')).toHaveTextContent(value));

beforeEach(() => {
  vi.clearAllMocks();
  fake.appName = 'app';
  server.use(
    http.get('*/api/orgs/:orgName/has-traces', () =>
      HttpResponse.json({ hasTraces: false }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppProvider — onboarding gate', () => {
  it('keeps hasCreatedTrace false when has-traces reports no traces (gate stays up)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: false }) }),
    );

    renderSeeded(appRow);

    await settled('false');
  });

  it('flips hasCreatedTrace true when has-traces reports a trace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: true }) }),
    );

    renderSeeded(appRow);

    await settled('true');
  });

  it('FAILS CLOSED: a non-ok has-traces response leaves the gate up (false), not open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );

    renderSeeded(appRow);

    await settled('false');
  });

  it('markTraceSeen() flips the gate true in place (no reload)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: false }) }),
    );

    renderSeeded(appRow);
    await settled('false');

    act(() => capturedMarkTraceSeen?.());

    await settled('true');
  });

  it('surfaces the seeded app and clears loading once the seeder pushes it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: false }) }),
    );

    renderSeeded(appRow);

    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-1'));
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
  });

  // Regression guard: `useSetupGate` (sections/onboarding/use-setup-gate.ts)
  // derives `showSetup` from `!loading && app && !hasCreatedTrace`. If
  // `loading` cleared the moment the seed landed — before the initial
  // has-traces check resolves — a returning user who already has traces
  // would see `showSetup` flip briefly true (the onboarding placeholder)
  // before the real `hasCreatedTrace: true` catches up. `loading` must stay
  // true across that whole window.
  it('keeps loading true between the seed landing and the has-traces initial check settling', async () => {
    let resolveFetch: (v: { ok: boolean; json: () => Promise<{ hasTraces: boolean }> }) => void;
    const pending = new Promise<{ ok: boolean; json: () => Promise<{ hasTraces: boolean }> }>(
      (resolve) => {
        resolveFetch = resolve;
      },
    );
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    renderSeeded(appRow);

    // The seed has landed (app is visible)...
    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-1'));
    // ...but the has-traces initial check hasn't resolved yet: loading must
    // still be true, and hasCreatedTrace must not be read as a final `false`.
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    expect(screen.getByTestId('has-trace')).toHaveTextContent('false');

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ hasTraces: true }) });
    });

    // Now that the check has settled, loading clears and the real (already
    // seen) trace state is visible in the same commit — never a frame where
    // loading:false pairs with the stale hasCreatedTrace:false default.
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('has-trace')).toHaveTextContent('true');
  });

  it('an app resolved to null (not found) settles loading immediately — no has-traces check to wait on', async () => {
    vi.stubGlobal('fetch', vi.fn()); // any fetch here would be a bug — no app id to check

    renderSeeded(null);

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('app-id')).toHaveTextContent('none');
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `(authenticated)`-layout mount semantics. The provider is mounted once above
// the persistent header and does not remount per `[appName]` subtree, so it
// must self-manage: `loading:false`/no has-traces fetch outside an app route,
// and a SYNCHRONOUS state reset on app switches (no stale frame).
// ---------------------------------------------------------------------------

describe('AppProvider — (authenticated)-layout mount semantics', () => {
  it('org-level route (no seeder mounted): settles app:null / loading:false and issues NO has-traces fetch', async () => {
    fake.appName = undefined;
    vi.stubGlobal('fetch', vi.fn()); // any fetch here would be a bug

    renderUnseeded();

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('app-id')).toHaveTextContent('none');
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('app switch clears the previous app in the SAME render — the reset fires off the route param, independent of when the new seed arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: true }) }),
    );

    const view = render(
      <AppProvider>
        <AppSeeder app={appRow}>
          <Consumer />
        </AppSeeder>
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-1'));
    await settled('true');

    // The route's `appName` param changes, but the seeder is still passed the
    // OLD app row (the new route's RSC seed hasn't arrived yet) — isolating
    // the render-time reset (keyed on the route param inside `AppProvider`)
    // from the seeder's own re-seed timing. The reset must win regardless: no
    // frame shows app-1's row, gate state, or `loading:false` under the new
    // route.
    fake.appName = 'other-app';
    view.rerender(
      <AppProvider>
        <AppSeeder app={appRow}>
          <Consumer />
        </AppSeeder>
      </AppProvider>,
    );
    expect(screen.getByTestId('app-id')).toHaveTextContent('none');
    expect(screen.getByTestId('has-trace')).toHaveTextContent('false');
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    // ...then the new app's seed arrives.
    const otherApp = { id: 'app-2', name: 'other-app' } as unknown as AppWithGitConnection;
    view.rerender(
      <AppProvider>
        <AppSeeder app={otherApp}>
          <Consumer />
        </AppSeeder>
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-2'));
  });

  it('leaving the app area (seeder unmounts) clears the app and stops loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: false }) }),
    );

    const view = render(
      <AppProvider>
        <AppSeeder app={appRow}>
          <Consumer />
        </AppSeeder>
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-1'));

    fake.appName = undefined;
    view.rerender(
      <AppProvider>
        <Consumer />
      </AppProvider>,
    );
    expect(screen.getByTestId('app-id')).toHaveTextContent('none');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('a stale seed effect from an unmounted seeder never lands after the route moved on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasTraces: false }) }),
    );

    // Two seeders mounted in sequence (simulating an app switch); only the
    // LAST one's effect should determine the visible app.
    const view = render(
      <AppProvider>
        <AppSeeder app={appRow}>
          <Consumer />
        </AppSeeder>
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-1'));

    fake.appName = 'other-app';
    const otherApp = { id: 'app-2', name: 'other-app' } as unknown as AppWithGitConnection;
    view.rerender(
      <AppProvider>
        <AppSeeder app={otherApp}>
          <Consumer />
        </AppSeeder>
      </AppProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('app-id')).toHaveTextContent('app-2'));
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });
});

// ---------------------------------------------------------------------------
// Regression: logging out must not crash `<AppProvider>` (the provider no
// longer reads `useAuthContext`/the JWT claim at all, so this class of bug is
// structurally closed — kept as a smoke test on the org-level shape).
// ---------------------------------------------------------------------------

describe('AppProvider — logout crash regression', () => {
  it('renders through on an org-level route with no seeder mounted', async () => {
    fake.appName = undefined;
    vi.stubGlobal('fetch', vi.fn());

    renderUnseeded();

    expect(screen.getByTestId('app-id')).toHaveTextContent('none');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('has-trace')).toHaveTextContent('false');
  });
});

// ---------------------------------------------------------------------------
// The self-scheduling trace poll — unchanged by the re-home.
// ---------------------------------------------------------------------------

type TraceBackend = {
  fetch: ReturnType<typeof vi.fn>;
  setTrace: (exists: boolean) => void;
  freshCalls: () => number;
};

function makeTraceBackend(): TraceBackend {
  let traceExists = false;
  const fetch = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => ({ hasTraces: (void url, traceExists) }),
    }),
  );
  return {
    fetch,
    setTrace: (exists: boolean) => {
      traceExists = exists;
    },
    freshCalls: () =>
      fetch.mock.calls.filter(([u]) => String(u).includes('fresh=1')).length,
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

describe('AppProvider — trace poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  async function advancePoll(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
    });
  }

  async function renderAndSettleFalse(backend: TraceBackend) {
    vi.stubGlobal('fetch', backend.fetch);
    renderSeeded(appRow);
    await advancePoll(0);
    expect(screen.getByTestId('has-trace')).toHaveTextContent('false');
  }

  it('polls the uncached fresh=1 endpoint while visible and flips the gate when a trace lands', async () => {
    const backend = makeTraceBackend();
    await renderAndSettleFalse(backend);

    expect(backend.freshCalls()).toBe(0);

    backend.setTrace(true);
    await advancePoll(5000);
    expect(backend.freshCalls()).toBe(1);
    expect(screen.getByTestId('has-trace')).toHaveTextContent('true');

    await advancePoll(5000);
    await advancePoll(5000);
    expect(backend.freshCalls()).toBe(1);
  });

  it('keeps polling every 5s while a trace has not appeared yet', async () => {
    const backend = makeTraceBackend();
    await renderAndSettleFalse(backend);

    await advancePoll(5000);
    expect(backend.freshCalls()).toBe(1);

    await advancePoll(5000);
    expect(backend.freshCalls()).toBe(2);
    expect(screen.getByTestId('has-trace')).toHaveTextContent('false');
  });

  it('PAUSES on a hidden tab — it reschedules without spending a request', async () => {
    const backend = makeTraceBackend();
    await renderAndSettleFalse(backend);

    backend.setTrace(true);
    setHidden(true);
    await advancePoll(5000);
    expect(backend.freshCalls()).toBe(0);
    expect(screen.getByTestId('has-trace')).toHaveTextContent('false');

    setHidden(false);
    await advancePoll(5000);
    expect(backend.freshCalls()).toBe(1);
    expect(screen.getByTestId('has-trace')).toHaveTextContent('true');
  });

  it('STOPS after the ~15min wall-clock cap (no further polling)', async () => {
    const backend = makeTraceBackend();
    await renderAndSettleFalse(backend);

    await advancePoll(15 * 60 * 1000);
    const callsAtCap = backend.freshCalls();
    expect(callsAtCap).toBeGreaterThan(0);

    await advancePoll(10 * 60 * 1000);
    expect(backend.freshCalls()).toBe(callsAtCap);
  });
});
