// @vitest-environment jsdom
/**
 * Sessions failure and loading surfaces.
 *
 * The sessions reads hit the analytics store, where an outage is a transient.
 * Without a boundary on this segment such a failure unwinds to the root one,
 * replacing the whole app shell with a crash screen and offering no way back
 * other than a reload. And the Suspense fallback must show the page's shape,
 * not a bare page-sized spinner that says nothing about what is arriving.
 */
import type React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const logError = vi.fn();
vi.mock('@/hooks/use-client-logger', () => ({
  useClientLogger: () => ({ error: logError }),
}));

// The page's own module graph reaches the analytics service; these are its
// data seams and are never exercised here — only the fallback element is.
vi.mock('@/features/agent-sessions/request-context', () => ({
  resolveAgentSessionsContext: vi.fn(),
}));
vi.mock('@/features/agent-sessions/service', () => ({
  agentSessionsService: { listSessions: vi.fn() },
}));
vi.mock('@/lib/analytics/saved-filters/read', () => ({
  listSavedFilters: vi.fn(),
}));
vi.mock('@/features/agent-sessions/components/agent-sessions', () => ({
  AgentSessions: () => null,
}));
vi.mock('@/features/agent-sessions/components/agent-session-detail', () => ({
  AgentSessionDetail: () => null,
}));

import { resetPageLoadRecoveryState } from '@/app/deployment-skew';
import AgentSessionsError from '../error';
import AgentSessionsPage from '../page';
import AgentSessionDetailPage from '../[traceId]/page';

function renderBoundary(reset: () => void, error = new Error('ClickHouse unavailable')) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <AgentSessionsError error={error} reset={reset} />
    </ThemeProvider>,
  );
}

describe('agent sessions — error boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Unconditional, so a failing expect inside a fake-timer test cannot leak
  // them into the rest of the file.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a retryable inline card and re-runs the segment on retry', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    renderBoundary(reset);

    expect(screen.getByTestId('agent-sessions-error')).toHaveTextContent(
      "Couldn't load sessions",
    );

    await user.click(screen.getByRole('button', { name: /retry now/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('reports the failure to the client logger with its digest', () => {
    const error = Object.assign(new Error('ClickHouse unavailable'), { digest: 'abc123' });
    render(
      <ThemeProvider theme={createTheme()}>
        <AgentSessionsError error={error} reset={vi.fn()} />
      </ThemeProvider>,
    );

    expect(logError).toHaveBeenCalledWith(error, {
      digest: 'abc123',
      source: 'agent-sessions-error-boundary',
    });
  });

  it('leaves a deploy landing mid-navigation to reload itself away, unreported', () => {
    // A boundary on this segment catches the error before it can unwind, so it
    // is the one that has to recognise skew — otherwise it blames the analytics
    // store for a stale bundle and ships the noise to error reporting.
    vi.useFakeTimers();
    sessionStorage.clear();
    const skew = Object.assign(new Error('Loading chunk 42 failed'), {
      name: 'ChunkLoadError',
    });

    render(
      <ThemeProvider theme={createTheme()}>
        <AgentSessionsError error={skew} reset={vi.fn()} />
      </ThemeProvider>,
    );

    expect(logError).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-sessions-updating')).toHaveTextContent(
      'Updating application',
    );
    expect(screen.queryByTestId('agent-sessions-error')).not.toBeInTheDocument();
  });
});

describe('agent sessions — stale-bundle card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    resetPageLoadRecoveryState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers a browser refresh and not the analytics-store retry, once the reloads are spent', async () => {
    // A spent budget means a reload already ran twice and the chunk is still
    // missing, so `reset()` would re-run the segment against the same bundle.
    // Blaming the analytics store here would be wrong twice over: wrong cause,
    // and a retry that cannot succeed.
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    sessionStorage.setItem('deployment-skew-reload-attempted', `${Date.now()}:2`);
    const reset = vi.fn();

    renderBoundary(
      reset,
      Object.assign(new Error('Loading chunk 42 failed'), { name: 'ChunkLoadError' }),
    );
    await vi.runAllTimersAsync();

    const card = within(screen.getByTestId('agent-sessions-stale-bundle'));
    // The wording admits the reloads failed rather than promising a release that
    // two of them already failed to deliver.
    expect(card.getByRole('heading').textContent).toBe('This page still is not loading');
    expect(card.getByText('Reloading did not fix it. Refresh to try again.').tagName).toBe('P');

    // The affordance has to be a real browser refresh. `reset()` re-renders the
    // same bundle, so a retry button here cannot fetch the missing chunk.
    card.getByRole('button', { name: 'Refresh page' }).click();
    expect(reload).toHaveBeenCalledTimes(1);

    // The analytics-store card must not be what the user sees: its retry is
    // wired to `reset()`, and its copy blames the session read for a failure
    // that is really a missing chunk.
    expect(screen.queryByTestId('agent-sessions-error')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
    expect(screen.queryByText("Couldn't load sessions")).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('agent sessions — Suspense fallbacks', () => {
  function renderFallback(tree: React.ReactElement) {
    const fallback = (tree.props as { fallback: React.ReactElement }).fallback;
    return render(<ThemeProvider theme={createTheme()}>{fallback}</ThemeProvider>);
  }

  it('falls back to a skeleton of the destination layout on the list, not a page-sized spinner', async () => {
    const tree = (await AgentSessionsPage({
      params: Promise.resolve({ appName: 'app-one', envName: 'staging' }),
      searchParams: Promise.resolve({}),
    })) as React.ReactElement;

    renderFallback(tree);

    // Shaped like the table it precedes — a head row plus body rows — so first
    // paint does not reflow once the sessions land.
    const skeleton = screen.getByTestId('sessions-skeleton');
    expect(skeleton).toHaveAttribute('data-variant', 'table-page');
    expect(screen.getByTestId('sessions-skeleton-head-row')).toBeInTheDocument();
    expect(screen.getAllByTestId('sessions-skeleton-row').length).toBeGreaterThan(1);
    // Announced while it stands in, rather than a silent blank.
    expect(skeleton).toHaveTextContent('Loading');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('falls back to a skeleton on the detail too — the same route, the same rule', async () => {
    const tree = (await AgentSessionDetailPage({
      params: Promise.resolve({ appName: 'app-one', traceId: 'trace-1' }),
    })) as React.ReactElement;

    renderFallback(tree);

    expect(screen.getByTestId('session-detail-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
