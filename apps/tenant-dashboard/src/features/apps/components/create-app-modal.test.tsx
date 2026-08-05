// @vitest-environment jsdom
/**
 * Tests for <CreateAppModal> display-name support.
 *
 * The create dialog auto-generates the URL slug (`name`, shown disabled) and
 * lets the user type an optional friendly `display_name`. Verified:
 *   1. Saving with a display name sends both `name` (the generated slug) and
 *      the trimmed `displayName`.
 *   2. Saving with the display name left blank omits `displayName` entirely
 *      (so the app falls back to its slug) rather than sending "".
 *   3. The identifier field is disabled — the slug is not user-editable.
 *
 * Boundaries:
 *   - `@/hooks/use-boolean` is overridden locally so the dialog renders
 *     open (the global setup pins it to always-closed).
 *   - `../actions` (the server action) and `notistack` are mocked.
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

const { createAppAction, enqueueSnackbar } = vi.hoisted(() => ({
  createAppAction: vi.fn(),
  enqueueSnackbar: vi.fn(),
}));

vi.mock('../actions', () => ({
  createAppAction: (...args: unknown[]) => createAppAction(...args),
}));

vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

import { CreateAppModal } from './create-app-modal';

beforeEach(() => {
  createAppAction.mockReset().mockResolvedValue({
    ok: true,
    data: { ok: true, app: { id: 'app-1', name: 'x', display_name: null } },
  });
  enqueueSnackbar.mockReset();
});

describe('CreateAppModal', () => {
  it('sends the generated slug plus the trimmed displayName on save', async () => {
    render(<CreateAppModal />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('app.displayName'), '  Triage Bot  ');
    await user.click(screen.getByRole('button', { name: 'app.saveButton' }));

    await waitFor(() => expect(createAppAction).toHaveBeenCalledTimes(1));
    const arg = createAppAction.mock.calls[0]![0] as { name: string; displayName?: string };
    expect(arg.displayName).toBe('Triage Bot');
    // The slug is auto-generated and non-empty — it must ride along, untouched.
    expect(typeof arg.name).toBe('string');
    expect(arg.name.length).toBeGreaterThan(0);
  });

  it('omits displayName when the field is left blank', async () => {
    render(<CreateAppModal />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'app.saveButton' }));

    await waitFor(() => expect(createAppAction).toHaveBeenCalledTimes(1));
    const arg = createAppAction.mock.calls[0]![0] as { name: string; displayName?: string };
    expect(arg.displayName).toBeUndefined();
  });

  it('keeps the identifier field disabled (the slug is not user-editable)', () => {
    render(<CreateAppModal />);
    expect(screen.getByLabelText('app.identifier')).toBeDisabled();
  });

  it('uses the generated slug as the display-name placeholder and shows the helper text', () => {
    render(<CreateAppModal />);
    const displayInput = screen.getByLabelText('app.displayName');
    const slug = (screen.getByLabelText('app.identifier') as HTMLInputElement).value;
    // The slug doubles as the placeholder so the user sees what the app is
    // called if they leave the display name blank.
    expect(displayInput).toHaveAttribute('placeholder', slug);
    expect(screen.getByText('app.displayNameHelper')).toBeInTheDocument();
  });

  it('surfaces a duplicate_app_name error inline on the field', async () => {
    createAppAction.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, errorCode: 'duplicate_app_name', message: 'name taken' },
    });
    render(<CreateAppModal />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('app.displayName'), 'Triage Bot');
    await user.click(screen.getByRole('button', { name: 'app.saveButton' }));

    await waitFor(() => expect(screen.getByText('name taken')).toBeInTheDocument());
  });
});
