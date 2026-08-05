// @vitest-environment jsdom
/**
 * Regression tests for the org layout's React Server Component (RSC) conversion.
 *
 * The layout resolves the user's per-app role assignments ONCE, server-side
 * (`getAppRoleAssignments`, user-global — not keyed by app), and seeds them
 * into an `AppPermissionsProvider` mounted ABOVE `<TenantGuard>` — so
 * org-level consumers like the apps-list page's `useAppRoles()` resolve
 * synchronously instead of self-fetching. `TenantGuard` is preserved as the
 * exact same child: this test pins that the conversion adds a provider
 * without touching, reordering, or bypassing the guard — `TenantGuard`
 * receives exactly the `children` the layout was given, unchanged.
 */

import { render, screen } from "@testing-library/react";

import Layout from "../layout";
import { getAppRoleAssignments } from "@/utils/get-app-permissions";
import { useOptionalAppRolesSnapshot } from "@/auth/context/app-permissions-context";

vi.mock("@/utils/get-app-permissions", () => ({
  getAppRoleAssignments: vi.fn(),
}));

// TenantGuard owns real, security-relevant gating logic (membership/tenant-sync
// checks) exercised by its own dedicated test suite (`tenant-guard.test.tsx`).
// Here it's a pass-through stub so this test asserts the SEEDING wiring
// (provider mounted above it, children unchanged) without re-driving that
// guard's own auth/membership state machine.
vi.mock("@/auth/guard", () => ({
  TenantGuard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tenant-guard">{children}</div>
  ),
}));

const mockGetAppRoleAssignments = getAppRoleAssignments as ReturnType<typeof vi.fn>;

/** Client consumer reading the app-role half of the seed, the way `useAppRoles` does. */
function RolesProbe() {
  const snapshot = useOptionalAppRolesSnapshot();
  return <div data-testid="roles">{JSON.stringify(snapshot)}</div>;
}

async function renderLayout() {
  const tree = await Layout({ children: <RolesProbe /> });
  return render(tree);
}

describe("orgs/[orgName] Layout — org-wide role seed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds the resolved app-role assignments above TenantGuard, TenantGuard still wraps the same children", async () => {
    const appRoles = [
      {
        id: "amr-1",
        membership_id: "mem-1",
        app_id: "app-1",
        tenant_id: "tenant-1",
        role: "read",
        custom_role_id: null,
        created_at: "2026-01-01T00:00:00Z",
        created_by: null,
        updated_at: null,
        updated_by: null,
      },
    ];
    mockGetAppRoleAssignments.mockResolvedValue({ appRoles, isAppScoped: true });

    await renderLayout();

    expect(mockGetAppRoleAssignments).toHaveBeenCalledTimes(1);
    // TenantGuard still renders as the child, wrapping the exact same content.
    expect(screen.getByTestId("tenant-guard")).toBeInTheDocument();
    // The seed reaches a consumer rendered inside TenantGuard's children,
    // proving the provider sits ABOVE the guard.
    expect(JSON.parse(screen.getByTestId("roles").textContent!)).toEqual({
      appRoles,
      isAppScoped: true,
    });
  });

  it("exposes no app-roles seed when the assignment read fails, so consumers resolve fail-closed", async () => {
    mockGetAppRoleAssignments.mockResolvedValue(null);

    await renderLayout();

    expect(screen.getByTestId("roles")).toHaveTextContent("null");
  });
});
