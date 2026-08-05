// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import MenuItem from '@mui/material/MenuItem';

// The global @/theme mock omits bgBlur; the StyledArrow calls it. Re-add it as
// a no-op style helper so the real CustomPopover renders (matches the pattern in
// the dataset-items consumer test).
vi.mock('@/theme', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => children,
  ThemeProvider: ({ children }: { children?: React.ReactNode }) => children,
  bgBlur: () => ({}),
}));

import CustomPopover from './custom-popover';

const theme = createTheme();

function renderPopover(ui: React.ReactElement) {
  return render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}

function makeAnchor() {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

describe('CustomPopover', () => {
  it('does not render its content when open is null', () => {
    renderPopover(
      <CustomPopover open={null} onClose={() => {}}>
        <MenuItem>Profile</MenuItem>
      </CustomPopover>,
    );
    expect(screen.queryByText('Profile')).toBeNull();
  });

  it('wraps children in a MenuList by default so MenuItem resolves the v9 context', () => {
    const anchor = makeAnchor();
    // A bare <MenuItem> throws under MUI v9 without a MenuListContext — rendering
    // it successfully proves the default MenuList wrapper supplies that context.
    renderPopover(
      <CustomPopover open={anchor} onClose={() => {}}>
        <MenuItem>Profile</MenuItem>
      </CustomPopover>,
    );

    expect(screen.getByText('Profile')).toBeInTheDocument();
    // MenuList renders the child list as a <ul>; the MenuItem resolves as a
    // menuitem only because it is inside that list's context.
    expect(document.querySelector('.MuiPopover-paper ul')).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
  });

  it('renders children bare (no MenuList) when disableList is set', () => {
    const anchor = makeAnchor();
    renderPopover(
      <CustomPopover open={anchor} onClose={() => {}} disableList>
        <div>Custom form content</div>
      </CustomPopover>,
    );

    expect(screen.getByText('Custom form content')).toBeInTheDocument();
    // No MenuList wrapper → no <ul> around the custom form content.
    expect(document.querySelector('.MuiPopover-paper ul')).toBeNull();
  });

  it('renders the pointer arrow by default', () => {
    const anchor = makeAnchor();
    renderPopover(
      <CustomPopover open={anchor} onClose={() => {}}>
        <MenuItem>Profile</MenuItem>
      </CustomPopover>,
    );

    // The StyledArrow is the only <span> rendered as a direct child of the
    // paper (menu items live inside the nested <ul>). Its presence is the beak.
    expect(document.querySelector('.MuiPopover-paper > span')).not.toBeNull();
  });

  it('does not render the pointer arrow when hiddenArrow is set', () => {
    const anchor = makeAnchor();
    renderPopover(
      <CustomPopover open={anchor} onClose={() => {}} hiddenArrow>
        <MenuItem>Profile</MenuItem>
      </CustomPopover>,
    );

    expect(document.querySelector('.MuiPopover-paper > span')).toBeNull();
    // The rest of the popover still renders — hiddenArrow drops only the beak.
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
  });

  it('uses the open element as the anchor and lands consumer sx on the Paper', () => {
    const anchor = makeAnchor();
    renderPopover(
      <CustomPopover open={anchor} onClose={() => {}} sx={{ width: 234 }}>
        <MenuItem>Profile</MenuItem>
      </CustomPopover>,
    );

    const paper = document.querySelector('.MuiPopover-paper') as HTMLElement;
    expect(paper).not.toBeNull();
    // The consumer sx is spread last, so its width wins over the base
    // `width: 'auto'` — proving sx reaches the Paper slot.
    expect(getComputedStyle(paper).width).toBe('234px');
  });
});
