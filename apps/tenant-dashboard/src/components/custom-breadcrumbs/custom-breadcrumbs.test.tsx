// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import { createPlatformAdminTheme } from '../../theme/create-theme';
import CustomBreadcrumbs from './custom-breadcrumbs';

// ----------------------------------------------------------------------

function renderUnder(theme: ReturnType<typeof createTheme>) {
  return render(
    <ThemeProvider theme={theme}>
      <CustomBreadcrumbs
        heading="Section Title"
        links={[
          { name: 'Home', href: '/home' },
          { name: 'Middle', href: '/middle' },
          { name: 'Current Page' },
        ]}
        action={<button type="button">Add Flag</button>}
      />
    </ThemeProvider>,
  );
}

describe('CustomBreadcrumbs', () => {
  it('renders the heading, navigable href crumbs, the current crumb, and the action', () => {
    renderUnder(createTheme());

    expect(screen.getByText('Section Title')).toBeInTheDocument();

    // href crumbs are anchors pointing at their href.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
    expect(screen.getByRole('link', { name: 'Middle' })).toHaveAttribute('href', '/middle');

    // The last crumb is the current page: non-navigable (no anchor) and flagged
    // aria-current for assistive tech.
    expect(screen.queryByRole('link', { name: 'Current Page' })).toBeNull();
    const current = screen.getByText('Current Page');
    expect(current.getAttribute('aria-current')).toBe('page');

    // The action node renders.
    expect(screen.getByRole('button', { name: 'Add Flag' })).toBeInTheDocument();
  });

  it('renders under the platform-admin theme (distinct cssVarPrefix) without crashing', () => {
    renderUnder(createPlatformAdminTheme());

    expect(screen.getByText('Section Title')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
    expect(screen.getByText('Current Page').getAttribute('aria-current')).toBe('page');
  });
});
