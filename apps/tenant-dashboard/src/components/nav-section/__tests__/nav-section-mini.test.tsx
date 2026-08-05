// @vitest-environment jsdom
/**
 * Behavioural contract for NavSectionMini.
 *
 * Mini keeps anchor/href parity with vertical (same e2e selectors), drops the
 * visible label to a tooltip shown on hover AND keyboard focus (so keyboard
 * users don't lose the label), keeps active parity, and opens a right-anchored
 * menu for parents (decision D6).
 */

import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname } from 'next/navigation';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createAppTheme } from '../../../theme/create-theme';
import { expectNoA11yViolations } from '../../../test-helpers/a11y';
import type { NavGroupData } from '../types';

// The global RouterLink mock forwards only href+children, which would silently
// drop the aria-label / aria-current / menuitem role / onClick this family sets
// on internal links (Next's real Link forwards them). Use a faithful
// full-forwarding anchor so these assertions test real behaviour.
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

import { NavSectionMini } from '../nav-section-mini';

const icon = <span aria-hidden />;

const DASHBOARD = '/orgs/o/apps/a/env/dev/dashboards';
const TEMPLATES = '/orgs/o/apps/a/env/dev/templates';
const DOCS = 'https://docs.example.com';

const GROUP: NavGroupData[] = [
  {
    subheader: 'Platform',
    items: [
      { title: 'Dashboard', path: DASHBOARD, icon },
      { title: 'Templates', path: TEMPLATES, icon },
      { title: 'Docs', path: DOCS, icon },
    ],
  },
];

function renderMini(data: NavGroupData[] = GROUP) {
  return render(
    <ThemeProvider theme={createAppTheme()}>
      <NavSectionMini data={data} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue('/nowhere');
});

describe('NavSectionMini', () => {
  it('renders one anchor per item with hrefs in data order (parity with vertical)', () => {
    renderMini();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([DASHBOARD, TEMPLATES, DOCS]);
  });

  it('shows no item label text until a tooltip opens', () => {
    renderMini();
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(screen.queryByText('Templates')).toBeNull();
    expect(screen.queryByText('Docs')).toBeNull();
  });

  it('reveals the label and info in a tooltip', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={createAppTheme()}>
        <NavSectionMini
          data={[
            { subheader: 'S', items: [{ title: 'Templates', path: TEMPLATES, icon, info: <span>3</span> }] },
          ]}
        />
      </ThemeProvider>,
    );

    await user.hover(screen.getByRole('link'));
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Templates')).toBeInTheDocument();
    expect(within(tip).getByText('3')).toBeInTheDocument();
  });

  it('gives every icon-only item an accessible name so keyboard/SR users keep the label', () => {
    // The label is visually a tooltip, but the durable keyboard/screen-reader
    // guarantee is the accessible name on each control (aria-label). MUI's
    // tooltip focus-open is gated on :focus-visible, which jsdom doesn't
    // resolve, so the accessible name — not a focus-tooltip render — is what
    // pins "keyboard users don't lose the label".
    renderMini();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Templates' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toBeInTheDocument();
  });

  it('marks only the active mini item with aria-current="page"', () => {
    vi.mocked(usePathname).mockReturnValue(TEMPLATES);
    renderMini();
    expect(screen.getByRole('link', { name: 'Templates' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('renders a group without a subheader as item anchors only — no heading chrome', () => {
    renderMini([
      {
        items: [
          { title: 'Dashboard', path: DASHBOARD, icon },
          { title: 'Templates', path: TEMPLATES, icon },
          { title: 'Docs', path: DOCS, icon },
        ],
      },
    ]);

    expect(
      screen.getAllByRole('link').map((a) => a.getAttribute('href')),
    ).toEqual([DASHBOARD, TEMPLATES, DOCS]);
    // Mini never renders a subheader; leaf items carry no button/heading chrome.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a right-anchored menu of children for a parent item', async () => {
    const user = userEvent.setup();
    const CHILD = '/orgs/o/apps/a/env/dev/parent/child';
    renderMini([
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

    expect(screen.queryByRole('menuitem', { name: 'Child' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Parent' }));
    const child = await screen.findByRole('menuitem', { name: 'Child' });
    expect(child).toHaveAttribute('href', CHILD);
  });

  it('has no a11y violations', async () => {
    const { container } = renderMini();
    await expectNoA11yViolations(container);
  });
});
