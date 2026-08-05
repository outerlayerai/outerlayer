// @vitest-environment jsdom
/**
 * Pins the type-to-confirm gate on the custom-role delete dialog: the Delete
 * button must stay disabled until the role name is typed back exactly. The
 * smallest breaking change to production — dropping the `deleteConfirm === name`
 * check — flips both assertions, so this catches it.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import type { CustomRoleWithPermissions } from '@/types/custom-role';

vi.mock('../actions', () => ({
  listCustomRolesAction: vi.fn(),
  createCustomRoleAction: vi.fn(),
  updateCustomRoleAction: vi.fn(),
  deleteCustomRoleAction: vi.fn(),
  getCustomRoleAction: vi.fn(),
}));
vi.mock('./custom-role-form', () => ({ CustomRoleForm: () => null }));
vi.mock('@/components/role-select-dropdown', () => ({ RoleSelectDropdown: () => null }));
vi.mock('@/components/iconify', () => ({ default: () => <span /> }));

import { CustomRolesList } from './custom-roles-list';

const role = {
  id: 'r1',
  name: 'Editor',
  description: 'Can edit',
  permissions: [],
  memberCount: 0,
  created_at: '2026-01-01T00:00:00Z',
} as unknown as CustomRoleWithPermissions;

describe('CustomRolesList delete — type-to-confirm gate', () => {
  it('keeps Delete disabled until the role name is typed exactly', async () => {
    const user = userEvent.setup();
    render(<CustomRolesList customRolesEnabled initialRoles={[role]} />);

    await user.click(screen.getByRole('button', { name: 'Delete role' }));

    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();

    const field = screen.getByLabelText('Type "Editor" to confirm');
    await user.type(field, 'Edito'); // near-miss
    expect(del).toBeDisabled();

    await user.type(field, 'r'); // now "Editor" — exact match
    expect(del).toBeEnabled();
  });
});
