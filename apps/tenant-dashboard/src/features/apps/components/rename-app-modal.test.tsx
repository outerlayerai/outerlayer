// @vitest-environment jsdom
/**
 * Tests for <RenameAppModal>.
 *
 * The modal edits ONLY `display_name` (the UI label) via `renameAppAction` —
 * never the URL slug (`name`). The behaviours that matter, and would silently
 * regress without a test:
 *   1. Saving sends `{ appId, displayName: <trimmed> }` and reports success.
 *   2. An emptied field clears the override by sending `displayName: null`
 *      (so the app falls back to its identifier) — NOT undefined/omitted.
 *   3. The field re-seeds from the current display_name each time it opens.
 *   4. An action failure surfaces the message and does NOT close the dialog.
 *
 * Boundaries:
 *   - `../actions` (the server action) is mocked.
 *   - `notistack` is mocked for the snackbar spy (the component imports
 *     `useSnackbar` from notistack directly, not the app's snackbar module).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { renameAppAction, enqueueSnackbar } = vi.hoisted(() => ({
  renameAppAction: vi.fn(),
  enqueueSnackbar: vi.fn(),
}));

vi.mock('../actions', () => ({
  renameAppAction: (...args: unknown[]) => renameAppAction(...args),
}));

vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

import { RenameAppModal } from './rename-app-modal';

const t = (key: string) => key;

function renderModal(props: Partial<React.ComponentProps<typeof RenameAppModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <RenameAppModal
      appId="app-1"
      displayName={null}
      identifier="brave-blue-cat"
      open
      onClose={onClose}
      t={t}
      {...props}
    />,
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  renameAppAction.mockReset().mockResolvedValue({
    ok: true,
    data: { ok: true, app: { id: 'app-1', display_name: 'Triage Bot' } },
  });
  enqueueSnackbar.mockReset();
});

describe('RenameAppModal', () => {
  it('sends the trimmed displayName and reports success on save', async () => {
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('displayName'), '  Triage Bot  ');
    await user.click(screen.getByRole('button', { name: 'renameButton' }));

    await waitFor(() => expect(renameAppAction).toHaveBeenCalledTimes(1));
    // The slug is never touched here — only appId + the trimmed displayName.
    expect(renameAppAction).toHaveBeenCalledWith({
      appId: 'app-1',
      displayName: 'Triage Bot',
    });
    expect(enqueueSnackbar).toHaveBeenCalledWith('renameSuccess', {
      variant: 'success',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the override by sending displayName: null when emptied', async () => {
    renderModal({ displayName: 'Triage Bot' });
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText('displayName'));
    await user.click(screen.getByRole('button', { name: 'renameButton' }));

    await waitFor(() => expect(renameAppAction).toHaveBeenCalledTimes(1));
    expect(renameAppAction).toHaveBeenCalledWith({
      appId: 'app-1',
      displayName: null,
    });
  });

  it('seeds the input from the current display_name and shows the slug as placeholder', () => {
    renderModal({ displayName: 'Existing Name', identifier: 'brave-blue-cat' });
    const input = screen.getByLabelText('displayName');
    expect(input).toHaveValue('Existing Name');
    // The identifier is surfaced as the placeholder so the user sees the
    // fallback the app reverts to when the field is cleared.
    expect(input).toHaveAttribute('placeholder', 'brave-blue-cat');
  });

  it('rejects a display_name longer than 100 chars without calling the action', async () => {
    renderModal({ displayName: '' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('displayName'), 'a'.repeat(101));
    await user.click(screen.getByRole('button', { name: 'renameButton' }));

    expect(renameAppAction).not.toHaveBeenCalled();
    expect(screen.getByText('validation.name.max')).toBeInTheDocument();
  });

  it('falls back to the generic error message on a thrown failure', async () => {
    renameAppAction.mockRejectedValueOnce(new Error('network down'));
    const { onClose } = renderModal({ displayName: 'X' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'renameButton' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('renameFailed', { variant: 'error' }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a domain-level action failure and keeps the dialog open', async () => {
    renameAppAction.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, errorCode: 'duplicate_app_name', message: 'duplicate' },
    });
    const { onClose } = renderModal({ displayName: 'X' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'renameButton' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('duplicate', { variant: 'error' }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a wrapper-level failure (e.g. forbidden) and keeps the dialog open', async () => {
    renameAppAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied' },
    });
    const { onClose } = renderModal({ displayName: 'X' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'renameButton' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Permission denied', { variant: 'error' }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
