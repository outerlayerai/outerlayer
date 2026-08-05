// @vitest-environment jsdom
/**
 * <MembersView> composes the core members list with the EE app-access
 * dialog — the one place either side is allowed to know the other exists,
 * since `UserList` (src/features) and `ManageAppAccessDialog`
 * (ee/features) may not import each other directly. Pins that the dialog
 * opens for the clicked member's identity and that the same `customRoles`
 * array reaches both the list and the dialog.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/use-boolean', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-boolean')>('@/hooks/use-boolean');
  return actual;
});

vi.mock('@/features/members/actions', () => ({
  changeMemberRoleAction: vi.fn(),
  removeMemberAction: vi.fn(),
  resendInviteAction: vi.fn(),
}));

vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));

vi.mock('@/features/members/components/invite-user-modal', () => ({
  InviteUserModal: () => null,
}));

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

const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@ee/features/app-access/components/manage-app-access-dialog', () => ({
  ManageAppAccessDialog: (props: Record<string, unknown>) => {
    dialogProps.current = props;
    return <div data-testid="app-access-dialog">{String(props.open)}</div>;
  },
}));

import { MembersView } from './members-view';

const users = [
  {
    id: 'user-1',
    membershipId: 'mem-1',
    name: 'Ryan',
    email: 'ryan@example.com',
    role: 'write' as const,
    isConfirmed: true,
    membershipStatus: 'active' as const,
  },
];

const customRoles = [{ id: 'r1', name: 'Editor' }];

beforeEach(() => {
  dialogProps.current = null;
});

describe('MembersView', () => {
  it('is closed initially and opens the dialog with the clicked member\'s identity', async () => {
    render(
      <MembersView
        users={users}
        appLevelRolesEnabled
        customRolesEnabled={false}
        customRoles={customRoles}
        apps={[]}
      />,
    );

    expect(screen.queryByTestId('app-access-dialog')).not.toBeInTheDocument();

    const user = userEvent.setup();
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getByRole('button'));
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.manageAppAccess'));

    await waitFor(() => expect(screen.getByTestId('app-access-dialog')).toBeInTheDocument());
    expect(dialogProps.current).toMatchObject({
      open: true,
      membershipId: 'mem-1',
      userName: 'Ryan',
      userEmail: 'ryan@example.com',
      customRoles,
    });
  });

  it('closes the dialog through onClose', async () => {
    render(
      <MembersView
        users={users}
        appLevelRolesEnabled
        customRolesEnabled={false}
        customRoles={customRoles}
        apps={[]}
      />,
    );

    const user = userEvent.setup();
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getByRole('button'));
    await user.click(screen.getByText('dashboard.settings.inviteUsers.userList.manageAppAccess'));
    await waitFor(() => expect(screen.getByTestId('app-access-dialog')).toBeInTheDocument());

    (dialogProps.current!.onClose as () => void)();

    await waitFor(() => expect(screen.queryByTestId('app-access-dialog')).not.toBeInTheDocument());
  });
});
