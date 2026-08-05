// @vitest-environment jsdom
/**
 * The type-to-confirm gate lives here now (shared by the custom-role and
 * SSO-config deletes). Pin the behavior directly: the destructive button is
 * disabled until the confirmation text is typed EXACTLY. Deleting the match
 * check in production flips both assertions, so this catches it.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import { ConfirmDeleteDialog } from '..';

function setup(confirmationText = 'my-thing') {
  const onConfirm = vi.fn();
  render(
    <ConfirmDeleteDialog
      open
      onClose={vi.fn()}
      onConfirm={onConfirm}
      title="Delete thing"
      confirmationText={confirmationText}
    />,
  );
  return { onConfirm };
}

describe('ConfirmDeleteDialog', () => {
  it('disables the destructive button until the confirmation text matches exactly', async () => {
    const user = userEvent.setup();
    setup('prod-db');

    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();

    const field = screen.getByLabelText('Type "prod-db" to confirm');
    await user.type(field, 'prod-d'); // near-miss
    expect(del).toBeDisabled();

    await user.type(field, 'b'); // now "prod-db"
    expect(del).toBeEnabled();
  });

  it('re-disables when the text no longer matches (e.g. an extra char)', async () => {
    const user = userEvent.setup();
    setup('x');

    const field = screen.getByLabelText('Type "x" to confirm');
    await user.type(field, 'x');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();

    await user.type(field, 'y'); // "xy" ≠ "x"
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('fires onConfirm only once the match is typed and the button is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup('go');

    await user.type(screen.getByLabelText('Type "go" to confirm'), 'go');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
