// @vitest-environment jsdom
/**
 * Topics loading surface.
 *
 * The topic map is read on the server, so what stands in while it resolves is
 * the Suspense fallback. It must carry the page's shape — a header plus the
 * table it precedes — rather than a page-sized spinner that says nothing about
 * what is arriving.
 */
import type React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

// The page's module graph reaches the analytics store; these are its data
// seams and are never exercised here — only the fallback element is.
vi.mock('@/utils/get-app-id', () => ({
  getAppIdByName: vi.fn().mockResolvedValue('app-1'),
}));
vi.mock('@/features/topics/read', () => ({
  loadTopicsForApp: vi.fn(),
}));
vi.mock('@/features/topics', () => ({
  Topics: () => null,
}));

import TopicsPage from '../page';

describe('topics — Suspense fallback', () => {
  function renderFallback(tree: React.ReactElement) {
    const fallback = (tree.props as { fallback: React.ReactElement }).fallback;
    return render(<ThemeProvider theme={createTheme()}>{fallback}</ThemeProvider>);
  }

  it('falls back to a skeleton of the destination layout, not a page-sized spinner', async () => {
    const tree = (await TopicsPage({
      params: Promise.resolve({ appName: 'app-one' }),
      searchParams: Promise.resolve({}),
    })) as React.ReactElement;

    renderFallback(tree);

    // Shaped like the table it precedes — a head row plus body rows — so first
    // paint does not reflow once the map lands.
    const skeleton = screen.getByTestId('topics-skeleton');
    expect(skeleton).toHaveAttribute('data-variant', 'table-page');
    expect(screen.getByTestId('topics-skeleton-head-row')).toBeInTheDocument();
    expect(screen.getAllByTestId('topics-skeleton-row').length).toBeGreaterThan(1);
    // The header renders inside the suspended child, so the placeholder brings
    // its own — otherwise the title pops in after the body.
    expect(screen.getByTestId('topics-skeleton-header')).toBeInTheDocument();
    // Announced while it stands in, rather than a silent blank.
    expect(skeleton).toHaveTextContent('Loading');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // This table carries neither a filter bar nor a pager, so reserving either
    // would reflow the page on the axis the placeholder exists to hold still.
    expect(screen.queryByTestId('topics-skeleton-filter-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topics-skeleton-pager')).not.toBeInTheDocument();
  });

  it('keys the boundary by facet so a facet switch shows the placeholder again', async () => {
    // A facet switch re-reads the map on the server. Without a per-facet key the
    // boundary is already resolved and the previous facet's table stays on
    // screen until the new one lands, reading as a stale result.
    const tree = (await TopicsPage({
      params: Promise.resolve({ appName: 'app-one' }),
      searchParams: Promise.resolve({ facet: 'issues' }),
    })) as React.ReactElement;

    expect(tree.key).toBe('issues');
  });
});
