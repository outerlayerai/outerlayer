// @vitest-environment jsdom
/**
 * Tests for <AppList> — app naming surfacing + rename wiring.
 *
 * Focused on AppList's own orchestration logic, not the heavy child dialogs
 * (mocked as prop-capturing stubs):
 *   1. Renders one card per app, titled by display_name (slug fallback).
 *   2. Clicking a card routes by the URL slug `name`, never display_name.
 *   3. The Create App control is gated on `app.insert`.
 *   4. Permission flags (incl. the new `app.update` → canRenameApp) are
 *      forwarded to the settings menu.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useParams, useRouter } from 'next/navigation';

// --- Heavy children → prop-capturing stubs ---------------------------------
let settingsMenuProps: Record<string, unknown> = {};
vi.mock('./create-app-modal', () => ({
  CreateAppModal: () => <div data-testid="create-app-modal" />,
}));
vi.mock('./app-settings-menu', () => ({
  AppSettingsMenu: (props: Record<string, unknown>) => {
    settingsMenuProps = props;
    return <div data-testid="app-settings-menu" />;
  },
}));
vi.mock('./delete-app-modal', () => ({ DeleteAppModal: () => null }));
let renameModalProps: Record<string, unknown> = {};
vi.mock('./rename-app-modal', () => ({
  RenameAppModal: (props: Record<string, unknown>) => {
    renameModalProps = props;
    return <div data-testid="rename-app-modal" />;
  },
}));
vi.mock('@/components/link-repository', () => ({ LinkRepositoryModal: () => null }));
vi.mock('@/lib/git-connect/start-git-connect-action', () => ({
  startGitConnectAction: vi.fn(),
}));

// --- Hooks -----------------------------------------------------------------
let permissions: Array<{ permission: string }> = [];
vi.mock('@/auth/hooks', () => ({
  useAuthContext: () => ({ user: { permissions } }),
}));
vi.mock('@/auth/hooks/use-app-roles', () => ({
  useAppRoles: () => ({ isAppScoped: false, isLoading: false }),
}));
vi.mock('@/components/custom-popover', () => ({
  usePopover: () => ({ open: null, onOpen: vi.fn(), onClose: vi.fn() }),
}));
// The global setup stubs `../routes/paths` with only auth/dashboard; restore
// the real path builders so the slug-routing assertion is meaningful.
vi.mock('@/routes/paths', async (importOriginal) => await importOriginal());

import { AppList } from './app-list';
import type { AppWithGitConnection } from '../types';

const apps: AppWithGitConnection[] = [
  {
    id: 'app-1',
    tenant_id: 't',
    name: 'brave-blue-cat',
    display_name: 'Triage Bot',
    runtime: 'nodejs',
    entry_point: null,
    commit_sha: null,
    environment_migration_done_at: null,
    require_pull_request: false,
    created_at: '2026-05-21T00:00:00Z',
    created_by: null,
    updated_at: null,
    updated_by: null,
    isGitConnected: false,
    provider: null,
    repository: null,
    connectedBranch: null,
    environments: [],
  },
  {
    id: 'app-2',
    tenant_id: 't',
    name: 'plain-slug',
    display_name: null,
    runtime: 'nodejs',
    entry_point: null,
    commit_sha: null,
    environment_migration_done_at: null,
    require_pull_request: false,
    created_at: '2026-05-21T00:00:00Z',
    created_by: null,
    updated_at: null,
    updated_by: null,
    isGitConnected: false,
    provider: null,
    repository: null,
    connectedBranch: null,
    environments: [],
  },
];

const ALL_PERMS = [
  { permission: 'app.insert' },
  { permission: 'app.delete' },
  { permission: 'app.update' },
  { permission: 'git_connection.update' },
];

const push = vi.fn();

beforeEach(() => {
  permissions = [];
  settingsMenuProps = {};
  renameModalProps = {};
  push.mockReset();
  vi.mocked(useParams).mockReturnValue({ orgName: 'acme' });
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});

describe('AppList', () => {
  it('renders one card per app, titled by display_name with slug fallback', () => {
    render(<AppList apps={apps} />);
    expect(screen.getByText('Triage Bot')).toBeInTheDocument();
    expect(screen.getByText('plain-slug')).toBeInTheDocument();
    // the slug of the named app is NOT shown as the title
    expect(screen.queryByText('brave-blue-cat')).not.toBeInTheDocument();
  });

  it('routes by the URL slug (not display_name) when a card is clicked', async () => {
    render(<AppList apps={apps} />);
    const user = userEvent.setup();

    await user.click(screen.getByText('Triage Bot'));

    expect(push).toHaveBeenCalledWith('/orgs/acme/apps/brave-blue-cat');
  });

  it('shows the Create App control only when the user has app.insert', () => {
    const { rerender } = render(<AppList apps={apps} />);
    expect(screen.queryByTestId('create-app-modal')).not.toBeInTheDocument();

    permissions = ALL_PERMS;
    rerender(<AppList apps={apps} />);
    expect(screen.getByTestId('create-app-modal')).toBeInTheDocument();
  });

  it('forwards rename/delete/link permission flags to the settings menu', () => {
    permissions = ALL_PERMS;
    render(<AppList apps={apps} />);
    expect(settingsMenuProps.canRenameApp).toBe(true);
    expect(settingsMenuProps.canDeleteApp).toBe(true);
    expect(settingsMenuProps.canLinkGit).toBe(true);
  });

  it('marks rename/delete/link as false when the user lacks those permissions', () => {
    permissions = [];
    render(<AppList apps={apps} />);
    expect(settingsMenuProps.canRenameApp).toBe(false);
    expect(settingsMenuProps.canDeleteApp).toBe(false);
    expect(settingsMenuProps.canLinkGit).toBe(false);
  });

  // Granular single-permission sets: each flag must hinge on its OWN
  // permission string. An all-perms set can't catch a `===`→`!==` mutant
  // (some other perm keeps `.some()` true), so we isolate each one.
  it('derives canRenameApp strictly from app.update', () => {
    permissions = [{ permission: 'app.update' }];
    render(<AppList apps={apps} />);
    expect(settingsMenuProps.canRenameApp).toBe(true);
    expect(settingsMenuProps.canDeleteApp).toBe(false);
    expect(settingsMenuProps.canLinkGit).toBe(false);
  });

  it('does not grant rename for an unrelated single permission', () => {
    permissions = [{ permission: 'app.delete' }];
    render(<AppList apps={apps} />);
    expect(settingsMenuProps.canRenameApp).toBe(false);
    expect(settingsMenuProps.canDeleteApp).toBe(true);
  });

  it('shows the settings gear when the user can only rename (not delete or link)', () => {
    permissions = [{ permission: 'app.update' }];
    render(<AppList apps={[apps[0]!]} />);
    // The card title is present and the gear (by its accessible name) renders —
    // proving canRenameApp alone surfaces the settings affordance. The card is
    // itself a button, so target the gear by name, not by count.
    expect(screen.getByText('Triage Bot')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /app settings/i }),
    ).toBeInTheDocument();
  });

  it('passes the clicked app identifier (slug) and display_name to the rename dialog', async () => {
    permissions = [{ permission: 'app.update' }];
    render(<AppList apps={[apps[0]!]} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /app settings/i }));

    // Rename edits display_name; the identifier shown is the URL slug, never
    // the display_name — so a swap of these props is a real bug.
    expect(renameModalProps.appId).toBe('app-1');
    expect(renameModalProps.identifier).toBe('brave-blue-cat');
    expect(renameModalProps.displayName).toBe('Triage Bot');
  });
});
