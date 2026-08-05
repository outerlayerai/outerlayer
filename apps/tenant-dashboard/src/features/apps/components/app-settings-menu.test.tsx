// @vitest-environment jsdom
/**
 * Tests for <AppSettingsMenu> — the rename affordance.
 *
 * The Rename item is the only entry point to renaming an app, gated on
 * `canRenameApp` (app.update). Verified:
 *   1. Shown + wired to onRenameApp when canRenameApp is true.
 *   2. Absent when canRenameApp is false (so a reader can't trigger it).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

// CustomPopover pulls `bgBlur` from @/theme (not in the global mock) and only
// adds positioning chrome. Replace it with a passthrough that renders children
// when open — the menu contents are what this test cares about.
vi.mock('@/components/custom-popover', () => ({
  __esModule: true,
  default: ({ open, children }: any) => (open ? <div>{children}</div> : null),
}));

import { AppSettingsMenu } from './app-settings-menu';
import type { AppWithGitConnection } from '../types';

const app = {
  id: 'app-1',
  name: 'brave-blue-cat',
  display_name: null,
  isGitConnected: false,
  provider: null,
  repository: null,
} as unknown as AppWithGitConnection;

const t = (key: string) => key;

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof AppSettingsMenu>> = {},
) {
  const onRenameApp = vi.fn();
  render(
    <AppSettingsMenu
      // truthy anchor so CustomPopover renders open
      open={document.body}
      onClose={vi.fn()}
      app={app}
      canDeleteApp={false}
      canRenameApp
      canLinkGit={false}
      onConnectProvider={vi.fn()}
      onLinkRepository={vi.fn()}
      onRenameApp={onRenameApp}
      onDeleteApp={vi.fn()}
      t={t}
      {...overrides}
    />,
  );
  return { onRenameApp };
}

describe('AppSettingsMenu', () => {
  it('shows the Rename item and calls onRenameApp when canRenameApp is true', async () => {
    const { onRenameApp } = renderMenu();
    const user = userEvent.setup();

    const rename = screen.getByText('settingsMenu.rename');
    await user.click(rename);

    expect(onRenameApp).toHaveBeenCalledTimes(1);
  });

  it('hides the Rename item when canRenameApp is false', () => {
    renderMenu({ canRenameApp: false });
    expect(screen.queryByText('settingsMenu.rename')).not.toBeInTheDocument();
  });
});
