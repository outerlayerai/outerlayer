// @vitest-environment jsdom
/**
 * Regression tests for `<EnvVarEditor>`: the Add/Edit/Delete affordances must
 * gate on `env_var.insert/update/delete` permissions via
 * `useAppPermissions`, not render unconditionally.
 *
 * Two behaviours verified:
 *   1. A reader (no insert/update/delete perms) sees NO Add/Edit/Delete
 *      controls — only the reveal eye button.
 *   2. A writer/owner (all perms) sees the Add button in the header, and
 *      Edit + Delete icon-buttons for each var.
 *
 * Boundaries:
 *   - `@/lib/adapters/use-app-permissions` (`useAppPermissions`) is the
 *     permission-gate seam — a true seam (function with stable signature, not
 *     HTTP traffic). Mocked with `vi.mock` per `apps/tenant-dashboard/CLAUDE.md`.
 *   - `@/lib/adapters/use-app-context` (`useAppContext`) is a React-context
 *     seam — mocked to avoid the module-level Supabase client it constructs.
 *   - `../../actions` (the authorizedAction mutations) is mocked so the test
 *     never reaches the server-action boundary.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// ---------------------------------------------------------------------------
// `useAppContext` — React-context seam. Mocked so the test doesn't need the
// full AppProvider + Supabase initialisation.
// ---------------------------------------------------------------------------

vi.mock('@/sections/apps/context', () => ({
  useAppContext: () => ({ app: { id: 'app-1', name: 'Test App' } }),
}));

// ---------------------------------------------------------------------------
// `useAppPermissions` — the permission-gate seam under test.
// We control which permissions are returned per test via the `perms` variable.
// ---------------------------------------------------------------------------

let perms: string[] = [];

vi.mock('@/auth/hooks/use-app-permissions', () => ({
  useAppPermissions: () => ({
    permissions: [],
    isLoading: false,
    hasPermission: (p: string) => perms.includes(p),
  }),
}));

// ---------------------------------------------------------------------------
// `../../actions` — the authorizedAction mutations the component calls
// directly. Mocked so the test never reaches the server-action boundary;
// each resolves the `ActionResult` shape.
// ---------------------------------------------------------------------------

vi.mock('../../actions', () => ({
  setEnvVar: vi.fn().mockResolvedValue({ ok: true, data: { id: 'var-1', key: 'DATABASE_URL' } }),
  setEnvVarForTargets: vi.fn().mockResolvedValue({ ok: true, data: { count: 1 } }),
  deleteEnvVar: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  revealEnvVarValue: vi.fn().mockResolvedValue({ ok: true, data: { value: 'secret-value' } }),
}));

// ---------------------------------------------------------------------------
// Import CUT after all vi.mock declarations.
// ---------------------------------------------------------------------------

import { EnvVarEditor } from './EnvVarEditor';
import * as envVarActions from '../../actions';
import type { EnvVarRecord } from '../../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_ID = 'app-1';
const ENV_ID = 'env-1';
const ENV_NAME = 'staging';

const sampleEnvVars: EnvVarRecord[] = [
  { id: 'var-1', key: 'DATABASE_URL', environment_id: ENV_ID, target_kind: null, created_at: '2026-01-01T00:00:00Z', updated_at: null },
  { id: 'var-2', key: 'API_TOKEN', environment_id: null, target_kind: 'preview', created_at: '2026-01-02T00:00:00Z', updated_at: null },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnvVarEditor — C4 regression: permission-gated write controls', () => {
  beforeEach(() => {
    perms = [];
  });

  it('should NOT show the Add button when the user lacks env_var.insert', () => {
    // Reader has NO insert/update/delete perms.
    perms = [];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    // No Add button in the card header (insert is denied).
    // The translation returns the key under the test mock: "dashboard.apps.envVars.addButton"
    expect(
      screen.queryByRole('button', { name: /dashboard\.apps\.envVars\.addButton/i }),
    ).not.toBeInTheDocument();
  });

  it('should NOT show Edit icon buttons when the user lacks env_var.update', () => {
    // Reader has no update permission.
    perms = [];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    // No edit icon buttons (the tooltip key is the translation key).
    // Each env-var row has an eye (reveal) button; there should be NO edit button.
    const revealButtons = screen.getAllByRole('button', {
      name: /dashboard\.apps\.envVars\.revealValueTooltip/i,
    });
    expect(revealButtons).toHaveLength(sampleEnvVars.length);

    // Edit buttons have the editTooltip translation key as accessible name.
    expect(
      screen.queryByRole('button', { name: /dashboard\.apps\.envVars\.editTooltip/i }),
    ).not.toBeInTheDocument();
  });

  it('should NOT show Delete icon buttons when the user lacks env_var.delete', () => {
    // Reader has no delete permission.
    perms = [];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    expect(
      screen.queryByRole('button', { name: /dashboard\.apps\.envVars\.deleteTooltip/i }),
    ).not.toBeInTheDocument();
  });

  it('should show the Add button when the user has env_var.insert', () => {
    // Writer has insert permission.
    perms = ['env_var.insert'];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    expect(
      screen.getByRole('button', { name: /dashboard\.apps\.envVars\.addButton/i }),
    ).toBeInTheDocument();
  });

  it('should show Edit icon buttons when the user has env_var.update', () => {
    // Editor has update permission.
    perms = ['env_var.update'];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    const editButtons = screen.getAllByRole('button', {
      name: /dashboard\.apps\.envVars\.editTooltip/i,
    });
    expect(editButtons).toHaveLength(sampleEnvVars.length);
  });

  it('should show Delete icon buttons when the user has env_var.delete', () => {
    // Editor has delete permission.
    perms = ['env_var.delete'];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    const deleteButtons = screen.getAllByRole('button', {
      name: /dashboard\.apps\.envVars\.deleteTooltip/i,
    });
    expect(deleteButtons).toHaveLength(sampleEnvVars.length);
  });

  it('should show all write controls when the user has all write permissions', () => {
    // Owner has all permissions.
    perms = [
      'env_var.insert',
      'env_var.update',
      'env_var.delete',
    ];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    // Add button, and Edit + Delete buttons per row.
    expect(
      screen.getByRole('button', { name: /dashboard\.apps\.envVars\.addButton/i }),
    ).toBeInTheDocument();

    const editButtons = screen.getAllByRole('button', {
      name: /dashboard\.apps\.envVars\.editTooltip/i,
    });
    expect(editButtons).toHaveLength(sampleEnvVars.length);

    const deleteButtons = screen.getAllByRole('button', {
      name: /dashboard\.apps\.envVars\.deleteTooltip/i,
    });
    expect(deleteButtons).toHaveLength(sampleEnvVars.length);
  });

  it('should always show the reveal eye button regardless of permissions', () => {
    // Reader with zero permissions still needs to see values.
    perms = [];

    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );

    const revealButtons = screen.getAllByRole('button', {
      name: /dashboard\.apps\.envVars\.revealValueTooltip/i,
    });
    expect(revealButtons).toHaveLength(sampleEnvVars.length);
  });
});

describe('EnvVarEditor — interactions', () => {
  beforeEach(() => {
    perms = [
      'env_var.insert',
      'env_var.update',
      'env_var.delete',
    ];
    vi.clearAllMocks();
  });

  function renderEditor() {
    render(
      <EnvVarEditor
        appId={APP_ID}
        currentEnvId={ENV_ID}
        currentEnvName={ENV_NAME}
        envVars={sampleEnvVars}
        envNames={{ [ENV_ID]: ENV_NAME }}
      />,
    );
  }

  it('reveals a value via revealEnvVarValue({ appId, envVarId })', async () => {
    renderEditor();
    fireEvent.click(
      screen.getAllByRole('button', {
        name: /dashboard\.apps\.envVars\.revealValueTooltip/i,
      })[0]!,
    );
    await waitFor(() =>
      expect(vi.mocked(envVarActions.revealEnvVarValue)).toHaveBeenCalledWith({
        appId: APP_ID,
        envVarId: 'var-1',
      }),
    );
    expect(await screen.findByText('secret-value')).toBeInTheDocument();
  });

  it('deletes a row by id after confirmation', async () => {
    renderEditor();
    fireEvent.click(
      screen.getAllByRole('button', {
        name: /dashboard\.apps\.envVars\.deleteTooltip/i,
      })[0]!,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /dashboard\.apps\.envVars\.deleteButton/i,
      }),
    );
    await waitFor(() =>
      expect(vi.mocked(envVarActions.deleteEnvVar)).toHaveBeenCalledWith({
        appId: APP_ID,
        envVarId: 'var-1',
      }),
    );
  });

  it('edits a row value via setEnvVar with the row scope (specific env)', async () => {
    renderEditor();
    fireEvent.click(
      screen.getAllByRole('button', {
        name: /dashboard\.apps\.envVars\.editTooltip/i,
      })[0]!,
    );
    const dialog = screen.getByRole('dialog');
    const valueInput = dialog.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'new-val' } });
    fireEvent.click(
      within(dialog).getByText(/dashboard\.apps\.envVars\.updateButton/i),
    );
    await waitFor(() =>
      expect(vi.mocked(envVarActions.setEnvVar)).toHaveBeenCalledWith({
        appId: APP_ID,
        scope: { environmentId: ENV_ID },
        key: 'DATABASE_URL',
        value: 'new-val',
      }),
    );
  });

  it('adds a var via setEnvVarForTargets with the picked targets', async () => {
    renderEditor();
    fireEvent.click(
      screen.getByRole('button', {
        name: /dashboard\.apps\.envVars\.addButton/i,
      }),
    );
    const dialog = screen.getByRole('dialog');
    const keyInput = within(dialog).getAllByRole(
      'textbox',
    )[0] as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'NEW_VAR' } });
    const valueInput = dialog.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'v' } });
    fireEvent.click(
      within(dialog).getByText(/dashboard\.apps\.envVars\.addButton/i),
    );
    await waitFor(() =>
      expect(
        vi.mocked(envVarActions.setEnvVarForTargets),
      ).toHaveBeenCalledWith({
        appId: APP_ID,
        // default target = "all" → scopesFromChoices(['all'], envId)
        scopes: [{ targetKind: 'all' }],
        key: 'NEW_VAR',
        value: 'v',
      }),
    );
  });
});
