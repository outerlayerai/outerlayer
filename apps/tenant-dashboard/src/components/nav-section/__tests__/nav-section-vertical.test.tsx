// @vitest-environment jsdom
/**
 * Behavioural contract for NavSectionVertical.
 *
 * Pins what the consumers + e2e rely on: every item is a real
 * `<a>` with the env-scoped href in order (the e2e selects sidebar links by
 * `a[href*=…]`), active state wires to `useActiveLink`, external links open in a
 * new tab, disabled items don't navigate, the `info` badge stays inside its
 * item, the subheader collapses its group, and sub-items build under a parent.
 */

import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname } from 'next/navigation';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createAppTheme } from '../../../theme/create-theme';
import { expectNoA11yViolations } from '../../../test-helpers/a11y';
import type { NavGroupData } from '../types';

// The global RouterLink mock forwards only href+children, which would silently
// drop the aria-current / onClick this family sets on internal links (Next's
// real Link forwards them). Use a faithful full-forwarding anchor so these
// assertions test real behaviour rather than the mock's lossiness.
vi.mock('@/routes/components', () => {
  const ReactModule = require('react');
  return {
    RouterLink: ReactModule.forwardRef(function RouterLink(
      { children, ...rest }: any,
      ref: any,
    ) {
      return ReactModule.createElement('a', { ...rest, ref }, children);
    }),
  };
});

import { NavSectionVertical } from '../nav-section-vertical';

const icon = <span aria-hidden />;

const DASHBOARD = '/orgs/o/apps/a/env/dev/dashboards';
const TEMPLATES = '/orgs/o/apps/a/env/dev/templates';
const DOCS = 'https://docs.example.com';

const GROUP: NavGroupData[] = [
  {
    subheader: 'Platform',
    items: [
      { title: 'Dashboard', path: DASHBOARD, icon },
      { title: 'Templates', path: TEMPLATES, icon, info: <span>NEW</span> },
      { title: 'Docs', path: DOCS, icon },
    ],
  },
];

function renderNav(data: NavGroupData[] = GROUP) {
  return render(
    <ThemeProvider theme={createAppTheme()}>
      <NavSectionVertical data={data} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue('/nowhere');
});

describe('NavSectionVertical', () => {
  it('renders one anchor per item with hrefs in data order', () => {
    renderNav();
    const hrefs = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([DASHBOARD, TEMPLATES, DOCS]);
  });

  it('marks only the active item with aria-current="page"', () => {
    vi.mocked(usePathname).mockReturnValue(TEMPLATES);
    renderNav();
    expect(screen.getByRole('link', { name: /Templates/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(screen.getByRole('link', { name: 'Docs' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('renders an external item as a new-tab anchor', () => {
    renderNav();
    const docs = screen.getByRole('link', { name: 'Docs' });
    expect(docs).toHaveAttribute('href', DOCS);
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the info badge inside its own item, after the label', () => {
    renderNav();
    const templates = screen.getByRole('link', { name: /Templates/ });
    expect(within(templates).getByText('NEW')).toBeInTheDocument();
  });

  it('renders a disabled item as a non-navigating control', () => {
    renderNav([
      {
        subheader: 'S',
        items: [{ title: 'Locked', path: '/orgs/o/apps/a/env/dev/locked', icon, disabled: true }],
      },
    ]);
    expect(screen.queryByRole('link', { name: 'Locked' })).toBeNull();
    expect(screen.getByText('Locked').closest('a')).toBeNull();
    expect(
      screen.getByText('Locked').closest('[aria-disabled="true"]'),
    ).not.toBeNull();
  });

  it('collapses its group when the subheader is clicked, and restores on the next click', async () => {
    const user = userEvent.setup();
    renderNav();
    const subheader = screen.getByRole('button', { name: 'Platform' });
    expect(subheader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();

    await user.click(subheader);
    expect(subheader).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull(),
    );

    await user.click(subheader);
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders a group without a subheader as items only — no heading button, no collapse toggle', () => {
    renderNav([
      {
        items: [
          { title: 'Dashboard', path: DASHBOARD, icon },
          { title: 'Templates', path: TEMPLATES, icon },
        ],
      },
    ]);

    // All items render, in order, and stay visible (no collapse wrapper).
    expect(
      screen.getAllByRole('link').map((a) => a.getAttribute('href')),
    ).toEqual([DASHBOARD, TEMPLATES]);

    // No heading chrome: no button role and nothing exposing aria-expanded.
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      document.querySelector('[aria-expanded]'),
    ).toBeNull();
  });

  it('builds sub-items under a parent, hidden until the parent is expanded', async () => {
    const user = userEvent.setup();
    const CHILD = '/orgs/o/apps/a/env/dev/parent/child';
    renderNav([
      {
        subheader: 'S',
        items: [
          {
            title: 'Parent',
            path: '/orgs/o/apps/a/env/dev/parent',
            icon,
            children: [{ title: 'Child', path: CHILD, icon }],
          },
        ],
      },
    ]);

    expect(screen.queryByRole('link', { name: 'Child' })).toBeNull();
    expect(screen.getByTestId('nav-item-chevron')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /Parent/ }));

    const child = await screen.findByRole('link', { name: 'Child' });
    expect(child).toHaveAttribute('href', CHILD);
  });

  it('has no a11y violations', async () => {
    const { container } = renderNav();
    await expectNoA11yViolations(container);
  });
});
