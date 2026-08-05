// @vitest-environment jsdom
/**
 * Suspense fallback for the dashboards list segment.
 *
 * The list is read on the server and the segment is force-dynamic, so without a
 * fallback of its own the content frame stays blank for the whole read. The
 * placeholder mirrors the destination — a header over the same card grid — so
 * first paint does not reflow once the dashboards land.
 */

import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import DashboardsLoading from '../loading';

function renderLoading() {
  return render(
    <ThemeProvider theme={createTheme()}>
      <DashboardsLoading />
    </ThemeProvider>,
  );
}

describe('DashboardsLoading', () => {
  it('mirrors the destination card grid rather than showing a spinner', () => {
    renderLoading();

    const placeholder = screen.getByTestId('dashboards-loading');
    // The list is a grid of cards, not a table — a table-shaped placeholder
    // would reflow the page on the axis this exists to hold still.
    expect(placeholder).toHaveAttribute('data-variant', 'card-grid');
    expect(screen.getByTestId('dashboards-loading-grid')).toBeInTheDocument();
    expect(screen.getAllByTestId('dashboards-loading-card').length).toBeGreaterThan(1);
    // The page header renders inside the suspended child, so the placeholder
    // brings its own — otherwise the title pops in after the body.
    expect(screen.getByTestId('dashboards-loading-header')).toBeInTheDocument();
    // The list header carries "New Dashboard", so its slot is reserved too.
    expect(screen.getByTestId('dashboards-loading-header-action')).toBeInTheDocument();
    // A full-page spinner is not an alternative here; the destination shape is
    // known, and a spinner says nothing about what is arriving.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('announces itself while it stands in', () => {
    renderLoading();

    const placeholder = screen.getByTestId('dashboards-loading');
    expect(placeholder).toHaveAttribute('role', 'status');
    expect(placeholder).toHaveTextContent('Loading');
    expect(placeholder).not.toHaveAttribute('aria-busy');
  });
});
