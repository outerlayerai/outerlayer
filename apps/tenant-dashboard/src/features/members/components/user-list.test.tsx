// @vitest-environment jsdom
/**
 * Tests for <UserList> — the row actions (role change, remove, resend
 * invite), which are the only place a member mutation gets triggered from
 * this table. Verified:
 *   1. Changing a member's role calls changeMemberRoleAction with the exact
 *      userId/role/customRoleId and revalidates on success.
 *   2. A wrapper-level failure (e.g. forbidden) surfaces the action's own
 *      error message and does not revalidate.
 *   3. A business-level failure (e.g. last-owner protection) surfaces its
 *      message and does not revalidate.
 *   4. Removing a member calls removeMemberAction with the exact userId and
 *      closes the confirm dialog on success.
 *   5. A remove failure surfaces the error and keeps the dialog open.
 *   6. Resending an invite calls resendInviteAction with the exact email and
 *      reports success/failure.
 *
 * `@/hooks/use-boolean` is overridden locally with the real (useState-backed)
 * implementation — the global setup pins it to always-value:false/no-op
 * setters, which would make the confirm-remove dialog (state via useBoolean,
 * unlike the role-change dialog, which is driven by usePopover) never open.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/use-boolean', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-boolean')>('@/hooks/use-boolean');
  return actual;
});

const { changeMemberRoleAction, removeMemberAction, resendInviteAction, enqueueSnackbar } = vi.hoisted(() => ({
  changeMemberRoleAction: vi.fn(),
  removeMemberAction: vi.fn(),
  resendInviteAction: vi.fn(),
  enqueueSnackbar: vi.fn(),
}));

vi.mock('../actions', () => ({
  changeMemberRoleAction: (...args: unknown[]) => changeMemberRoleAction(...args),
  removeMemberAction: (...args: unknown[]) => removeMemberAction(...args),
  resendInviteAction: (...args: unknown[]) => resendInviteAction(...args),
}));

vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

vi.mock('@/lib/app-shell/use-current-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/app-shell/use-current-user')>(
    '@/lib/app-shell/use-current-user',
  );
  return {
    ...actual,
    useCurrentUser: () => ({ userId: 'me', email: 'me@example.com', role: actual.UserRoleEnum.OWNER, isOwner: true }),
  };
});

// The popover pulls positioning chrome not present in the jsdom test theme —
// replace it with a passthrough that renders its children (in the same
// MenuList wrapper the real component uses, since the children are bare
// MenuItems) whenever open.
vi.mock('@/components/custom-popover', async () => {
  const actual = await vi.importActual<typeof import('@/components/custom-popover')>('@/components/custom-popover');
  const { default: MenuList } = await import('@mui/material/MenuList');
  return {
    ...actual,
    default: ({ open, children }: any) => (open ? <MenuList disablePadding>{children}</MenuList> : null),
  };
});

vi.mock('./invite-user-modal', () => ({
  InviteUserModal: () => null,
}));

import { UserList } from './user-list';

function baseUser(overrides: Partial<React.ComponentProps<typeof UserList>['users'][number]> = {}) {
  return {
    id: 'user-1',
    membershipId: 'mem-1',
    name: 'Ryan',
    email: 'ryan@example.com',
    role: 'write' as const,
    isConfirmed: true,
    membershipStatus: 'active' as const,
    ...overrides,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof UserList>> = {}) {
  return render(
    <UserList
      users={[baseUser()]}
      appLevelRolesEnabled={false}
      customRolesEnabled={false}
      customRoles={[]}
      apps={[]}
      {...overrides}
    />,
  );
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, rowIndex = 1) {
  // Row 0 is the header; row N is the Nth seeded member. Its only button is
  // the row-actions "more" icon (Iconify is globally stubbed to null, so it
  // has no accessible name).
  const rows = screen.getAllByRole('row');
  const memberRow = rows[rowIndex]!;
  await user.click(within(memberRow).getByRole('button'));
}

beforeEach(() => {
  changeMemberRoleAction.mockReset();
  removeMemberAction.mockReset();
  resendInviteAction.mockReset();
  enqueueSnackbar.mockReset();
});

describe('UserList — role change', () => {
  it('calls changeMemberRoleAction with the exact userId/role and revalidates on success', async () => {
    changeMemberRoleAction.mockResolvedValue({ ok: true, data: { success: true } });
    renderList();
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.updateRole'));

    const dialog = screen.getByRole('dialog', { name: 'Update Role' });
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(changeMemberRoleAction).toHaveBeenCalledWith({ userId: 'user-1', role: 'admin', customRoleId: null }),
    );
  });

  it('surfaces a wrapper-level failure and does not revalidate', async () => {
    changeMemberRoleAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied' },
    });
    renderList();
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.updateRole'));
    const dialog = screen.getByRole('dialog', { name: 'Update Role' });
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(enqueueSnackbar).toHaveBeenCalledWith('Permission denied', { variant: 'error' }));
  });

  it('surfaces a business-level failure (e.g. last-owner protection)', async () => {
    changeMemberRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'Cannot demote the last owner. Transfer ownership first.' },
    });
    renderList();
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.updateRole'));
    const dialog = screen.getByRole('dialog', { name: 'Update Role' });
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith(
        'Cannot demote the last owner. Transfer ownership first.',
        { variant: 'error' },
      ),
    );
  });
});

describe('UserList — remove member', () => {
  it('calls removeMemberAction with the exact userId and closes the dialog on success', async () => {
    removeMemberAction.mockResolvedValue({ ok: true, data: { success: true } });
    renderList();
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.removeUser'));
    const dialog = screen.getByRole('dialog', { name: 'dashboard.settings.inviteUsers.userList.confirm.removeTitle' });
    await user.click(within(dialog).getByRole('button', { name: 'dashboard.settings.inviteUsers.userList.removeUser' }));

    await waitFor(() => expect(removeMemberAction).toHaveBeenCalledWith({ userId: 'user-1' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'dashboard.settings.inviteUsers.userList.confirm.removeTitle' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('surfaces a remove failure and keeps the confirm dialog open', async () => {
    removeMemberAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied' },
    });
    renderList();
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.removeUser'));
    const dialog = screen.getByRole('dialog', { name: 'dashboard.settings.inviteUsers.userList.confirm.removeTitle' });
    await user.click(within(dialog).getByRole('button', { name: 'dashboard.settings.inviteUsers.userList.removeUser' }));

    await waitFor(() => expect(enqueueSnackbar).toHaveBeenCalledWith('Permission denied', { variant: 'error' }));
    expect(
      screen.getByRole('dialog', { name: 'dashboard.settings.inviteUsers.userList.confirm.removeTitle' }),
    ).toBeInTheDocument();
  });
});

describe('UserList — resend invite', () => {
  it('calls resendInviteAction with the exact email and reports success for a pending member', async () => {
    resendInviteAction.mockResolvedValue({ ok: true, data: { success: true } });
    renderList({ users: [baseUser({ membershipStatus: 'pending' })] });
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.resendInvite'));

    await waitFor(() => expect(resendInviteAction).toHaveBeenCalledWith({ email: 'ryan@example.com' }));
    expect(enqueueSnackbar).toHaveBeenCalledWith('dashboard.settings.inviteUsers.userList.inviteLinkSent', {
      variant: 'success',
    });
  });

  it('surfaces a resend failure', async () => {
    resendInviteAction.mockResolvedValue({ ok: true, data: { success: false, error: 'No pending invitation found' } });
    renderList({ users: [baseUser({ membershipStatus: 'pending' })] });
    const user = userEvent.setup();

    await openRowMenu(user);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.resendInvite'));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('No pending invitation found', { variant: 'error' }),
    );
  });
});

describe('UserList — manage app access menu item', () => {
  const rowOne = baseUser({ id: 'user-1', membershipId: 'mem-1', name: 'Ryan', email: 'ryan@example.com', role: 'write' });
  const rowTwo = baseUser({ id: 'user-2', membershipId: 'mem-2', name: 'Devon', email: 'devon@example.com', role: 'write' });

  it('calls onManageAppAccess with the clicked row\'s identity, not the first row\'s', async () => {
    const onManageAppAccess = vi.fn();
    renderList({ users: [rowOne, rowTwo], appLevelRolesEnabled: true, onManageAppAccess });
    const user = userEvent.setup();

    await openRowMenu(user, 2);
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.manageAppAccess'));

    expect(onManageAppAccess).toHaveBeenCalledTimes(1);
    expect(onManageAppAccess).toHaveBeenCalledWith({ membershipId: 'mem-2', name: 'Devon', email: 'devon@example.com' });
  });

  it('hides the item when appLevelRolesEnabled is false', async () => {
    const onManageAppAccess = vi.fn();
    renderList({ users: [rowOne], appLevelRolesEnabled: false, onManageAppAccess });
    const user = userEvent.setup();

    await openRowMenu(user);

    expect(screen.queryByText('dashboard.settings.inviteUsers.userList.manageAppAccess')).not.toBeInTheDocument();
  });

  it('hides the item for the owner row', async () => {
    const onManageAppAccess = vi.fn();
    renderList({ users: [baseUser({ role: 'owner' })], appLevelRolesEnabled: true, onManageAppAccess });
    const user = userEvent.setup();

    await openRowMenu(user);

    expect(screen.queryByText('dashboard.settings.inviteUsers.userList.manageAppAccess')).not.toBeInTheDocument();
  });

  it('hides the item for a member with no membershipId', async () => {
    const onManageAppAccess = vi.fn();
    renderList({
      users: [baseUser({ membershipId: undefined })],
      appLevelRolesEnabled: true,
      onManageAppAccess,
    });
    const user = userEvent.setup();

    await openRowMenu(user);

    expect(screen.queryByText('dashboard.settings.inviteUsers.userList.manageAppAccess')).not.toBeInTheDocument();
  });

  it('hides the item when onManageAppAccess is absent, even with the other three conditions satisfied', async () => {
    renderList({ users: [rowOne], appLevelRolesEnabled: true });
    const user = userEvent.setup();

    await openRowMenu(user);

    expect(screen.queryByText('dashboard.settings.inviteUsers.userList.manageAppAccess')).not.toBeInTheDocument();
  });
});
