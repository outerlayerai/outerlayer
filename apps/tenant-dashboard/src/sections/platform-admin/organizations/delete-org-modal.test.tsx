// @vitest-environment jsdom
/**
 * Tests for <DeleteOrgModal>'s exact-name confirmation gate: the delete
 * control stays disabled until the typed text matches the organization's
 * name, and only then does it call the delete action.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deleteOrganization } = vi.hoisted(() => ({
  deleteOrganization: vi.fn(),
}));

vi.mock('./actions', () => ({
  deleteOrganization: (...args: unknown[]) => deleteOrganization(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../../routes/paths', () => ({
  paths: { platformAdmin: { organizations: '/platform-admin/organizations' } },
}));

import { DeleteOrgModal } from './delete-org-modal';

function renderModal(props: Partial<React.ComponentProps<typeof DeleteOrgModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <DeleteOrgModal
      open
      onClose={onClose}
      tenantId="tenant-1"
      organizationName="Acme Corp"
      userCount={3}
      appsCount={2}
      apiKeysCount={1}
      hasActiveSubscription={false}
      {...props}
    />,
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  deleteOrganization.mockReset().mockResolvedValue({ data: { success: true } });
});

describe('DeleteOrgModal', () => {
  // proves AC-065-12
  it('keeps the delete button disabled until the typed text matches the organization name exactly, then fires the delete', async () => {
    const { onClose } = renderModal();
    const user = userEvent.setup();
    const deleteButton = screen.getByTestId('delete-org-confirm-button');
    const input = screen.getByTestId('delete-org-name-input-field');

    expect(deleteButton).toBeDisabled();

    await user.type(input, 'Acme Cor');
    expect(deleteButton).toBeDisabled();
    expect(deleteOrganization).not.toHaveBeenCalled();

    await user.type(input, 'p');
    expect(deleteButton).toBeEnabled();

    await user.click(deleteButton);
    await waitFor(() =>
      expect(deleteOrganization).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', confirmationName: 'Acme Corp' }),
      ),
    );
    // Wait out the rest of the success path (onClose + redirect) so it
    // can't leak an unhandled async update into the next test.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('never calls the delete action while the typed name is wrong, and the disabled button ignores a click', async () => {
    renderModal();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const deleteButton = screen.getByTestId('delete-org-confirm-button');
    const input = screen.getByTestId('delete-org-name-input-field');

    await user.type(input, 'Not Acme Corp');
    expect(deleteButton).toBeDisabled();

    await user.click(deleteButton);
    expect(deleteOrganization).not.toHaveBeenCalled();
  });
});
