// @vitest-environment jsdom
/**
 * Tests for <InviteUserModal> — the invite submission flow. Verified:
 *   1. Submitting name/email/role calls sendInviteAction with the exact
 *      parsed args (built-in role, no customRoleId) and reports success.
 *   2. Selecting a custom role parses it into the "read" fallback role plus
 *      the customRoleId, rather than sending the raw "custom:<id>" value.
 *   3. A wrapper-level failure (e.g. forbidden) surfaces the action's own
 *      error message inline on the email field (the only field the handler
 *      attaches errors to).
 *   4. A business-level failure (e.g. entitlement denial) surfaces its
 *      message the same way.
 *
 * `@/hooks/use-boolean` is overridden locally so the dialog renders open —
 * the global setup pins it to always-closed.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/use-boolean', () => ({
  useBoolean: () => ({
    value: true,
    onTrue: vi.fn(),
    onFalse: vi.fn(),
    onToggle: vi.fn(),
    setValue: vi.fn(),
  }),
}));

// The global setup stubs `@/components/hook-form` with a disconnected fake
// (no real react-hook-form wiring, no RHFSelect at all) — fine for plain
// useState forms, but this modal is a REAL react-hook-form + zod form, so
// typed/selected values must actually reach form state. Use the real module.
vi.mock('@/components/hook-form', async () => vi.importActual('@/components/hook-form'));

const { sendInviteAction, enqueueSnackbar } = vi.hoisted(() => ({
  sendInviteAction: vi.fn(),
  enqueueSnackbar: vi.fn(),
}));

vi.mock('../actions', () => ({
  sendInviteAction: (...args: unknown[]) => sendInviteAction(...args),
}));

vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

import { InviteUserModal } from './invite-user-modal';

function renderModal(overrides: Partial<React.ComponentProps<typeof InviteUserModal>> = {}) {
  return render(
    <InviteUserModal
      appLevelRolesEnabled={false}
      customRolesEnabled
      customRoles={[{ id: 'cr-1', name: 'Support' }]}
      apps={[]}
      {...overrides}
    />,
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, role: string) {
  await user.type(screen.getByLabelText('dashboard.settings.inviteUsers.namePlaceholder'), 'Ryan');
  await user.type(screen.getByLabelText('auth.register.emailPlaceholder'), 'ryan@example.com');
  await user.click(screen.getByLabelText('dashboard.settings.inviteUsers.rolePlaceholder'));
  await user.click(await screen.findByRole('option', { name: role }));
  await user.click(screen.getByRole('button', { name: 'dashboard.settings.inviteUsers.inviteButton' }));
}

beforeEach(() => {
  sendInviteAction.mockReset();
  enqueueSnackbar.mockReset();
});

describe('InviteUserModal', () => {
  it('sends the exact parsed args for a built-in role and reports success', async () => {
    sendInviteAction.mockResolvedValue({ ok: true, data: { success: true, membershipId: 'mem-1' } });
    renderModal();
    const user = userEvent.setup();

    await fillAndSubmit(user, 'dashboard.settings.inviteUsers.roleAdmin');

    await waitFor(() =>
      expect(sendInviteAction).toHaveBeenCalledWith({
        name: 'Ryan',
        email: 'ryan@example.com',
        role: 'admin',
        appRoles: undefined,
        customRoleId: undefined,
      }),
    );
    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('dashboard.settings.inviteUsers.inviteSuccess', {
        variant: 'success',
      }),
    );
  });

  it('parses a selected custom role into the read fallback role plus customRoleId', async () => {
    sendInviteAction.mockResolvedValue({ ok: true, data: { success: true, membershipId: 'mem-1' } });
    renderModal();
    const user = userEvent.setup();

    await fillAndSubmit(user, 'Support');

    await waitFor(() =>
      expect(sendInviteAction).toHaveBeenCalledWith({
        name: 'Ryan',
        email: 'ryan@example.com',
        role: 'read',
        appRoles: undefined,
        customRoleId: 'cr-1',
      }),
    );
  });

  it('surfaces a wrapper-level failure inline on the email field', async () => {
    sendInviteAction.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'Permission denied' } });
    renderModal();
    const user = userEvent.setup();

    await fillAndSubmit(user, 'dashboard.settings.inviteUsers.roleAdmin');

    await waitFor(() => expect(screen.getByText('Permission denied')).toBeInTheDocument());
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });

  it('surfaces a business-level failure (e.g. entitlement denial) inline on the email field', async () => {
    sendInviteAction.mockResolvedValue({ ok: true, data: { success: false, error: 'entitlement_denied' } });
    renderModal();
    const user = userEvent.setup();

    await fillAndSubmit(user, 'dashboard.settings.inviteUsers.roleAdmin');

    await waitFor(() => expect(screen.getByText('entitlement_denied')).toBeInTheDocument());
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });
});
