// @vitest-environment jsdom
/**
 * Tests for <DeleteAppModal>. Behaviours that matter, and would silently
 * regress without a test:
 *   1. The delete control stays disabled until the typed confirmation text
 *      matches the app's name exactly.
 *   2. A successful delete reports success and closes.
 *   3. A domain-level `api_key_sweep_failed` failure still reports success
 *      (the app row is gone) but also surfaces the sweep warning.
 *   4. Any other domain-level failure reports the generic delete-failed
 *      message and does NOT close (so the user can retry).
 *   5. A wrapper-level failure (e.g. forbidden) surfaces the action's own
 *      message and does NOT close.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deleteAppAction, enqueueSnackbar } = vi.hoisted(() => ({
  deleteAppAction: vi.fn(),
  enqueueSnackbar: vi.fn(),
}));

vi.mock('../actions', () => ({
  deleteAppAction: (...args: unknown[]) => deleteAppAction(...args),
}));

vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

import { DeleteAppModal } from './delete-app-modal';

const t = (key: string) => key;

function renderModal(props: Partial<React.ComponentProps<typeof DeleteAppModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <DeleteAppModal
      appId="app-1"
      appName="brave-blue-cat"
      open
      onClose={onClose}
      t={t}
      {...props}
    />,
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  deleteAppAction.mockReset().mockResolvedValue({ ok: true, data: { ok: true } });
  enqueueSnackbar.mockReset();
});

describe('DeleteAppModal', () => {
  it('keeps the delete button disabled until the typed text matches the app name exactly', async () => {
    renderModal();
    const user = userEvent.setup();
    const deleteButton = screen.getByRole('button', { name: 'deleteButton' });
    const input = screen.getByRole('textbox');

    expect(deleteButton).toBeDisabled();

    await user.type(input, 'brave-blue-ca');
    expect(deleteButton).toBeDisabled();

    await user.type(input, 't');
    expect(deleteButton).toBeEnabled();

    expect(deleteAppAction).not.toHaveBeenCalled();
  });

  it('calls deleteAppAction with the appId, reports success, and closes', async () => {
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'brave-blue-cat');
    await user.click(screen.getByRole('button', { name: 'deleteButton' }));

    await waitFor(() => expect(deleteAppAction).toHaveBeenCalledWith({ appId: 'app-1' }));
    expect(enqueueSnackbar).toHaveBeenCalledWith('deleteAppSuccess', { variant: 'success' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports success plus a sweep warning, and still closes, on api_key_sweep_failed', async () => {
    deleteAppAction.mockResolvedValue({
      ok: true,
      data: { ok: false, errorCode: 'api_key_sweep_failed', message: 'sweep boom' },
    });
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'brave-blue-cat');
    await user.click(screen.getByRole('button', { name: 'deleteButton' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('deleteAppSuccess', { variant: 'success' }),
    );
    expect(enqueueSnackbar).toHaveBeenCalledWith('sweep boom', { variant: 'warning' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces the generic delete-failed message and keeps the dialog open on any other domain failure', async () => {
    deleteAppAction.mockResolvedValue({
      ok: true,
      data: { ok: false, errorCode: 'internal_error', message: 'boom' },
    });
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'brave-blue-cat');
    await user.click(screen.getByRole('button', { name: 'deleteButton' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('deleteAppFailed', { variant: 'error' }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a wrapper-level failure (e.g. forbidden) and keeps the dialog open', async () => {
    deleteAppAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied' },
    });
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'brave-blue-cat');
    await user.click(screen.getByRole('button', { name: 'deleteButton' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Permission denied', { variant: 'error' }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
