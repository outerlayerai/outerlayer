// @vitest-environment jsdom
/**
 * DoraCollectionHealthBanner Tests
 *
 * The banner is the alarm for a dead collection pipeline — these tests pin
 * its gating exactly: render NOTHING while loading, on status-endpoint
 * error, or when healthy; render one Alert per issue otherwise. ("Nothing"
 * means a null render — an empty Stack would still be a layout bug.)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

vi.mock('server-only', () => ({}));
vi.mock('@/hooks/dora-metrics/use-dora-collection-status');

import { useDoraCollectionStatus } from '@/hooks/dora-metrics/use-dora-collection-status';

import { DoraCollectionHealthBanner } from '../dora-collection-health-banner';

const mockedUseStatus = vi.mocked(useDoraCollectionStatus);

const theme = createTheme();

function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}

function freshIso(): string {
  return new Date().toISOString();
}

const HEALTHY_SOURCES = [
  {
    source: 'betterstack_incidents',
    last_collected_at: freshIso(),
    last_run_at: freshIso(),
    last_run_status: 'success',
    last_error: null,
  },
  {
    source: 'cd_push',
    last_collected_at: freshIso(),
    last_run_at: freshIso(),
    last_run_status: 'success',
    last_error: null,
  },
];

describe('DoraCollectionHealthBanner', () => {
  it('should render null while the status is loading — even though empty sources would otherwise warn', () => {
    mockedUseStatus.mockReturnValue({ sources: [], isLoading: true, error: undefined });

    const { container } = wrap(<DoraCollectionHealthBanner />);

    expect(container.firstChild).toBeNull();
  });

  it('should render null when the status endpoint itself errored', () => {
    mockedUseStatus.mockReturnValue({
      sources: [],
      isLoading: false,
      error: new Error('boom'),
    });

    const { container } = wrap(<DoraCollectionHealthBanner />);

    expect(container.firstChild).toBeNull();
  });

  it('should render null — not an empty container — when every source is healthy', () => {
    mockedUseStatus.mockReturnValue({
      sources: HEALTHY_SOURCES,
      isLoading: false,
      error: undefined,
    });

    const { container } = wrap(<DoraCollectionHealthBanner />);

    expect(container.firstChild).toBeNull();
  });

  it('should render one Alert per issue with its severity and message', () => {
    mockedUseStatus.mockReturnValue({
      sources: [
        {
          source: 'betterstack_incidents',
          last_collected_at: freshIso(),
          last_run_at: freshIso(),
          last_run_status: 'error',
          last_error: 'BetterStack API error: 401 Unauthorized',
        },
        // No cd_push row and the incidents row errored → exactly one issue
        // (error). Add a stale cd_push heartbeat for a second (warning) issue.
        {
          source: 'cd_push',
          last_collected_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
          last_run_at: freshIso(),
          last_run_status: 'success',
          last_error: null,
        },
      ],
      isLoading: false,
      error: undefined,
    });

    wrap(<DoraCollectionHealthBanner />);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent(
      'betterstack_incidents collection is failing: BetterStack API error: 401 Unauthorized',
    );
    expect(alerts[0]?.className).toContain('MuiAlert-colorError');
    expect(alerts[1]).toHaveTextContent('No deployments recorded since 6 days ago');
    expect(alerts[1]?.className).toContain('MuiAlert-colorWarning');
  });
});
