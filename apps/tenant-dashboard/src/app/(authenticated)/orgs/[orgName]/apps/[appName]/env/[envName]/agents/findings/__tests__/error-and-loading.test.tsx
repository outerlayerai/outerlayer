// @vitest-environment jsdom
/**
 * Findings failure and loading surfaces.
 *
 * The findings read hits the analytics store, where an outage is a transient.
 * Without a boundary on this segment such a failure unwinds to the root one,
 * replacing the whole app shell with a crash screen and leaving a reload as the
 * only way back. And the segment's loading state must show the page's shape
 * rather than nothing at all, which is what a bare server await leaves behind.
 */
import type React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const logError = vi.fn();
vi.mock('@/hooks/use-client-logger', () => ({
  useClientLogger: () => ({ error: logError }),
}));

import AgentFindingsError from '../error';
import AgentFindingsLoading from '../loading';

function withTheme(node: React.ReactElement) {
  return render(<ThemeProvider theme={createTheme()}>{node}</ThemeProvider>);
}

describe('agent findings — error boundary', () => {
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
    withTheme(<AgentFindingsError error={new Error('ClickHouse unavailable')} reset={reset} />);

    const card = screen.getByTestId('error-state');
    expect(card).toHaveTextContent("Couldn't load findings");
    // Marked as a fault rather than an empty result — two identical-looking
    // cards are otherwise indistinguishable to a screen reader.
    expect(card).toHaveAttribute('role', 'alert');

    await user.click(screen.getByRole('button', { name: /retry now/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('keeps the raw failure out of the card and out of the copy', () => {
    withTheme(
      <AgentFindingsError
        error={Object.assign(new Error('ClickHouse unavailable'), { digest: 'abc123' })}
        reset={vi.fn()}
      />,
    );
    // Whatever unwinds to a route boundary can be a framework internal, so the
    // reason is authored copy — a digest or chunk path tells the reader nothing.
    const card = screen.getByTestId('error-state');
    expect(card).not.toHaveTextContent('ClickHouse unavailable');
    expect(card).not.toHaveTextContent('abc123');
  });

  it('reports the failure to the client logger with its digest', () => {
    const error = Object.assign(new Error('ClickHouse unavailable'), { digest: 'abc123' });
    withTheme(<AgentFindingsError error={error} reset={vi.fn()} />);

    expect(logError).toHaveBeenCalledWith(error, {
      digest: 'abc123',
      source: 'agent-findings-error-boundary',
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

    withTheme(<AgentFindingsError error={skew} reset={vi.fn()} />);

    expect(logError).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-findings-updating')).toHaveTextContent(
      'Updating application',
    );
    // A reload already in flight is not a fault to announce, and a retry button
    // here would race it.
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry now/i })).not.toBeInTheDocument();
  });
});

describe('agent findings — loading state', () => {
  it('stands in with the destination shape, announced, rather than a spinner or a blank', () => {
    withTheme(<AgentFindingsLoading />);

    const skeleton = screen.getByTestId('findings-skeleton');
    // Announced while it stands in, rather than a silent blank.
    expect(skeleton).toHaveTextContent('Loading');
    expect(skeleton).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    // The header renders inside the segment being awaited, so the placeholder
    // brings its own — otherwise the title pops in after the body.
    expect(screen.getByTestId('findings-skeleton-header')).toBeInTheDocument();
    // A column of full-width cards, which is what the findings list paints.
    expect(screen.getAllByTestId('findings-skeleton-card')).toHaveLength(5);
  });

  it('reserves no furniture the page does not have', () => {
    withTheme(<AgentFindingsLoading />);
    // Findings has no page-level action, no filter bar, no table and no pager.
    // Reserving any of them would reflow the page on exactly the axis this
    // placeholder exists to hold still.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-pager')).not.toBeInTheDocument();
  });
});
