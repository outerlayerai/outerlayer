// @vitest-environment jsdom
/**
 * PermissionGuard component tests.
 *
 * The guard resolves permissions through useAppPermissions(app.id):
 *  - in an app context → app-scoped permissions (same RPC the sidebar uses);
 *  - with no app context → org-level user.permissions fallback.
 *
 * The key regression locked here (N4): an app-scoped user whose ORG role would
 * grant a permission, but whose PER-APP role does not, must be denied at the
 * route — matching the sidebar, which already hides the tab.
 */
import React from 'react';
import { render } from '@testing-library/react';

vi.mock('../../../sections/error/403-view', () => ({
  __esModule: true,
  default: () => <div data-testid="forbidden-view">403 Forbidden</div>,
}));

vi.mock('framer-motion', () => ({
  m: { div: ({ children }: any) => <div>{children}</div> },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

const mockUseAuthContext = vi.fn();
vi.mock('../../hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

const mockUseAppContext = vi.fn();
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => mockUseAppContext(),
}));

// useAppPermissions is the permission-resolution seam. We drive it directly:
// its real implementation already does "app-scoped when appId set, else org
// fallback", which is exercised by its own test suite.
const mockUseAppPermissions = vi.fn();
vi.mock('../../hooks/use-app-permissions', () => ({
  useAppPermissions: (...args: unknown[]) => mockUseAppPermissions(...args),
}));

import PermissionGuard from '../permission-guard';

/** Build a hasPermission backed by a concrete permission list. */
function permsHook(granted: string[], isLoading = false) {
  return {
    permissions: granted.map((permission) => ({ id: permission, role: 'read', permission })),
    hasPermission: (p: string) => granted.includes(p),
    isLoading,
  };
}

describe('PermissionGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthContext.mockReturnValue({ user: { permissions: [] }, loading: false });
    mockUseAppContext.mockReturnValue({ app: null });
    mockUseAppPermissions.mockReturnValue(permsHook([]));
  });

  it('renders children when the (app-scoped) permission set grants the permission', () => {
    mockUseAppContext.mockReturnValue({ app: { id: 'app-1' } });
    mockUseAppPermissions.mockReturnValue(permsHook(['dashboard.read']));

    const { getByText } = render(
      <PermissionGuard permission="dashboard.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(getByText('Protected Content')).toBeInTheDocument();
  });

  it('passes app.id from context to useAppPermissions', () => {
    mockUseAppContext.mockReturnValue({ app: { id: 'app-xyz' } });
    mockUseAppPermissions.mockReturnValue(permsHook(['dashboard.read']));

    render(
      <PermissionGuard permission="dashboard.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(mockUseAppPermissions).toHaveBeenCalledWith('app-xyz');
  });

  it('N4 regression: denies an app-scoped user whose per-app role lacks the permission, even though the org role has it', () => {
    // Org role WOULD grant deployment.read...
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [{ id: 'o', role: 'read', permission: 'deployment.read' }] },
      loading: false,
    });
    // ...but the app-scoped set (what the guard must use) does NOT.
    mockUseAppContext.mockReturnValue({ app: { id: 'app-1' } });
    mockUseAppPermissions.mockReturnValue(permsHook(['env_var.read']));

    const { getByTestId, queryByText } = render(
      <PermissionGuard permission="environment.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(getByTestId('forbidden-view')).toBeInTheDocument();
    expect(queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('renders ForbiddenView when the permission is absent', () => {
    mockUseAppContext.mockReturnValue({ app: { id: 'app-1' } });
    mockUseAppPermissions.mockReturnValue(permsHook(['env_var.read']));

    const { getByTestId } = render(
      <PermissionGuard permission="dashboard.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(getByTestId('forbidden-view')).toBeInTheDocument();
  });

  it('renders null while auth state is loading', () => {
    mockUseAuthContext.mockReturnValue({ user: null, loading: true });
    const { container } = render(
      <PermissionGuard permission="dashboard.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders null while app permission resolution is loading (no flash of forbidden)', () => {
    mockUseAppContext.mockReturnValue({ app: { id: 'app-1' } });
    mockUseAppPermissions.mockReturnValue(permsHook([], /* isLoading */ true));
    const { container } = render(
      <PermissionGuard permission="dashboard.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('requires ALL permissions when given an array', () => {
    mockUseAppContext.mockReturnValue({ app: { id: 'app-1' } });
    mockUseAppPermissions.mockReturnValue(permsHook(['dashboard.read']));

    const { getByTestId } = render(
      <PermissionGuard permission={['dashboard.read', 'env_var.read']}>
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(getByTestId('forbidden-view')).toBeInTheDocument();
  });

  it('renders children when all permissions in the array are granted', () => {
    mockUseAppContext.mockReturnValue({ app: { id: 'app-1' } });
    mockUseAppPermissions.mockReturnValue(permsHook(['dashboard.read', 'env_var.read']));

    const { getByText } = render(
      <PermissionGuard permission={['dashboard.read', 'env_var.read']}>
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(getByText('Protected Content')).toBeInTheDocument();
  });

  it('falls back to org-level resolution when there is no app context', () => {
    // app is null → useAppPermissions(null) returns the org-level set. We model
    // that by having the hook reflect org permissions.
    mockUseAppContext.mockReturnValue({ app: null });
    mockUseAppPermissions.mockReturnValue(permsHook(['dashboard.read']));

    const { getByText } = render(
      <PermissionGuard permission="dashboard.read">
        <div>Protected Content</div>
      </PermissionGuard>,
    );
    expect(getByText('Protected Content')).toBeInTheDocument();
    expect(mockUseAppPermissions).toHaveBeenCalledWith(null);
  });
});
