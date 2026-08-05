// @vitest-environment jsdom
/**
 * <ManageAppAccessDialog> — the role dropdown's custom-role options come in
 * as a prop rather than a fetched list: the dialog is a leaf under
 * ee/features/app-access and may not reach ee/features/custom-roles/actions
 * (a feature never imports another feature, EE or otherwise). Pins that no
 * such fetch happens and that the options reflect exactly what was passed
 * in, plus the entitlement-denial revert paths on the master toggle and a
 * per-app grant.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const actions = vi.hoisted(() => ({
  listAppRolesAction: vi.fn(),
  assignAppRoleAction: vi.fn(),
  updateAppRoleAction: vi.fn(),
  updateAppCustomRoleAction: vi.fn(),
  revokeAppRoleAction: vi.fn(),
  listAppsForDropdownAction: vi.fn(),
  setAppScopedAction: vi.fn(),
  getAppScopedStatusAction: vi.fn(),
}));
vi.mock('../actions', () => actions);

// A regression that reintroduces the custom-roles fetch would import this
// module — mocked here so the negative assertion below actually catches it.
const listCustomRolesAction = vi.hoisted(() => vi.fn());
vi.mock('@ee/features/custom-roles/actions', () => ({ listCustomRolesAction }));

const enqueueSnackbar = vi.hoisted(() => vi.fn());
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar }) }));

// The global @outerlayer/locales mock hands back a fresh `t` identity on every
// call, which the component's `loadData` useCallback depends on — that's
// fine in production (the real hook memoizes), but under the naive mock it
// re-triggers the load effect every render. Pin a stable `t` for this file.
const stableT = (key: string) => key;
vi.mock('@outerlayer/locales', () => ({ useTranslate: () => ({ t: stableT }) }));

import { ManageAppAccessDialog } from './manage-app-access-dialog';

const ONE_APP_ONE_ROLE = {
  apps: { ok: true, data: { data: [{ appId: 'app-1', name: 'App One' }] } },
  roleAssigned: { ok: true, data: { data: [{ id: 'role-1', appId: 'app-1', role: 'read' }] } },
  roleUnassigned: { ok: true, data: { data: [] } },
};

function setup(overrides: Partial<{ appsScoped: boolean; roles: unknown }> = {}) {
  actions.listAppsForDropdownAction.mockResolvedValue(ONE_APP_ONE_ROLE.apps);
  actions.listAppRolesAction.mockResolvedValue(overrides.roles ?? ONE_APP_ONE_ROLE.roleAssigned);
  actions.getAppScopedStatusAction.mockResolvedValue({
    ok: true,
    data: { data: { isAppScoped: overrides.appsScoped ?? true } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ManageAppAccessDialog — custom roles come from props, not a fetch', () => {
  it('offers exactly the passed-in custom roles and never calls listCustomRolesAction', async () => {
    setup();
    render(
      <ManageAppAccessDialog
        open
        onClose={vi.fn()}
        membershipId="mem-1"
        userName="Ryan"
        userEmail="ryan@example.com"
        customRoles={[{ id: 'r1', name: 'Editor' }, { id: 'r2', name: 'Viewer' }]}
      />,
    );

    const user = userEvent.setup();
    const select = await screen.findByRole('combobox');
    await user.click(select);

    // MUI's Select gives every menu child role="option", including the
    // ListSubheader section labels — filter to the selectable roles.
    const options = screen
      .getAllByRole('option')
      .map((o) => o.textContent)
      .filter((text) => text && text !== 'Built-in Roles' && text !== 'Custom Roles');
    expect(options).toEqual(['Admin', 'Write', 'Read', 'Editor', 'Viewer']);
    expect(listCustomRolesAction).not.toHaveBeenCalled();
  });

  it('renders with custom roles disabled when the prop is an empty array', async () => {
    setup();
    render(
      <ManageAppAccessDialog
        open
        onClose={vi.fn()}
        membershipId="mem-1"
        userName="Ryan"
        userEmail="ryan@example.com"
        customRoles={[]}
      />,
    );

    const user = userEvent.setup();
    const select = await screen.findByRole('combobox');
    await user.click(select);

    expect(screen.queryByText('Custom Roles')).not.toBeInTheDocument();
    expect(listCustomRolesAction).not.toHaveBeenCalled();
  });
});

describe('ManageAppAccessDialog — entitlement denial reverts the switch', () => {
  it('master toggle: reverts to unchecked and shows the enterprise-required message', async () => {
    setup({ appsScoped: false });
    actions.setAppScopedAction.mockResolvedValue({ ok: true, data: { success: false, error: 'entitlement_denied' } });

    render(
      <ManageAppAccessDialog
        open
        onClose={vi.fn()}
        membershipId="mem-1"
        userName="Ryan"
        userEmail="ryan@example.com"
        customRoles={[]}
      />,
    );

    const user = userEvent.setup();
    // The master toggle is the first switch in the dialog; per-app switches
    // follow it, one per row.
    const masterSwitch = (await screen.findAllByRole('switch'))[0]!;
    expect(masterSwitch).not.toBeChecked();

    await user.click(masterSwitch);

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('dashboard.settings.manageAppAccessDialog.enterpriseRequired', {
        variant: 'error',
      }),
    );
    expect(masterSwitch).not.toBeChecked();
  });

  it('per-app grant: reverts the row switch to unchecked on denial', async () => {
    setup({ appsScoped: true, roles: ONE_APP_ONE_ROLE.roleUnassigned });
    actions.assignAppRoleAction.mockResolvedValue({ ok: true, data: { success: false, error: 'entitlement_denied' } });

    render(
      <ManageAppAccessDialog
        open
        onClose={vi.fn()}
        membershipId="mem-1"
        userName="Ryan"
        userEmail="ryan@example.com"
        customRoles={[]}
      />,
    );

    // Index 0 is the master toggle (isAppScoped: true); index 1 is the row.
    const rowSwitch = (await screen.findAllByRole('switch'))[1]!;
    expect(rowSwitch).not.toBeChecked();

    const user = userEvent.setup();
    await user.click(rowSwitch);

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('dashboard.settings.manageAppAccessDialog.enterpriseRequired', {
        variant: 'error',
      }),
    );
    expect(rowSwitch).not.toBeChecked();
  });
});
