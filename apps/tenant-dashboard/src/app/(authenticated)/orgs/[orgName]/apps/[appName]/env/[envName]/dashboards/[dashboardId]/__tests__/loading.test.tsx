// @vitest-environment jsdom
/**
 * Suspense fallback for the dashboard detail segment.
 *
 * The detail view is entirely server-loaded, so without a fallback of its own
 * the content frame stays blank for the whole read. The fallback mirrors the
 * destination layout — a title/action row plus the widget grid — rather than
 * showing a spinner, so the page's shape is visible before its data is.
 */

import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import DashboardDetailLoading from '../loading';

describe('DashboardDetailLoading', () => {
  it('renders a skeleton of the destination layout rather than a spinner', () => {
    const { container } = render(
      <ThemeProvider theme={createTheme()}>
        <DashboardDetailLoading />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('dashboard-detail-loading')).toBeInTheDocument();
    // Header block (title + caption + three controls) and one skeleton per
    // widget slot — a spinner would leave this at zero.
    expect(container.querySelectorAll('.MuiSkeleton-root')).toHaveLength(9);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('announces itself while it stands in', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <DashboardDetailLoading />
      </ThemeProvider>,
    );

    const placeholder = screen.getByTestId('dashboard-detail-loading');
    // Skeletons carry no accessible name, and a `status` region is named from
    // its content — so the announcement has to be real text inside it.
    expect(placeholder).toHaveAttribute('role', 'status');
    expect(placeholder).toHaveTextContent('Loading');
    // On a live region `aria-busy` defers the announcement until it clears, and
    // this region never clears — it unmounts once the data lands.
    expect(placeholder).not.toHaveAttribute('aria-busy');
  });

  it('stays bespoke rather than adopting the shared page skeleton', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <DashboardDetailLoading />
      </ThemeProvider>,
    );

    // Deliberate non-adoption: widgets are a 2-up grid of ~320px blocks under a
    // three-control header, and no PageSkeleton variant mirrors that — the
    // card-grid variant is 3-up at 160px with one header action. Swapping it in
    // would reflow the page on the axes this placeholder exists to hold still,
    // so pin it here rather than leave the next sweep to discover it visually.
    expect(screen.queryByTestId('page-skeleton')).not.toBeInTheDocument();
  });
});
