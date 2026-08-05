// @vitest-environment jsdom
/**
 * Regression tests for the `[appName]` server layout (tab-switch flicker fix).
 *
 * The layout must resolve the app's permission set ONCE server-side and mount
 * `AppPermissionsProvider` ABOVE the client shell, so every `useAppPermissions`
 * consumer inside the app resolves synchronously from the snapshot instead of
 * firing the `get_current_user_app_permissions` RPC per mount (the blank-frame
 * flash on every tab switch). An unknown app must degrade to the bare shell —
 * no snapshot, no permission lookup — leaving AppGuard/PermissionGuard to
 * handle forbidden/not-found exactly as before.
 *
 * Boundaries:
 *  - The Supabase `app` lookup is an HTTP boundary → MSW (seedSupabaseMswState).
 *  - getAppPermissionSet is the permission-gate seam → mocked.
 *  - The shell's chrome (guards, dashboard layout, providers, banners) are
 *    internal seams with stable signatures → pass-through stubs, so the test
 *    asserts the provider/shell wiring, not the chrome internals.
 */

import { render, screen } from "@testing-library/react";

import Layout from "../layout";
import AppTabLoading from "../loading";
import { getAppPermissionSet, getAppRoleAssignments } from "@/utils/get-app-permissions";
import {
  useOptionalAppPermissionsSnapshot,
  useOptionalAppRolesSnapshot,
} from "@/auth/context/app-permissions-context";
import { seedSupabaseMswState } from "@/test-helpers/msw-handlers";

vi.mock("@/utils/get-app-permissions", () => ({
  getAppPermissionSet: vi.fn(),
  getAppRoleAssignments: vi.fn(),
}));

// Pass-through stubs for the client chrome inside AppLayoutShell. The shell
// itself stays real — the test pins that children render INSIDE it (and thus
// under the provider mounted above it).
vi.mock("@/auth/guard", () => ({
  AppGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/layouts/dashboard", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/sections/apps/context", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/context/env-context", () => ({
  EnvProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/features/onboarding/components/getting-started-checklist", () => ({
  GettingStartedChecklist: () => null,
}));
vi.mock("@/features/onboarding/components/repo-gate-banner", () => ({
  RepoGateBanner: () => null,
}));

const mockGetAppPermissionSet = getAppPermissionSet as ReturnType<typeof vi.fn>;
const mockGetAppRoleAssignments = getAppRoleAssignments as ReturnType<typeof vi.fn>;

/**
 * Client consumer standing in for PermissionGuard / sidebar nav: reads the
 * server snapshot exactly the way `useAppPermissions` does.
 */
function SnapshotProbe() {
  const snapshot = useOptionalAppPermissionsSnapshot();
  return <div data-testid="snapshot">{JSON.stringify(snapshot)}</div>;
}

/** Client consumer reading the app-role half of the seed, the way `useAppRoles` does. */
function RolesProbe() {
  const snapshot = useOptionalAppRolesSnapshot();
  return <div data-testid="roles">{JSON.stringify(snapshot)}</div>;
}

async function renderLayout(appName: string, probe: React.ReactNode = <SnapshotProbe />) {
  const tree = await Layout({
    children: probe,
    params: Promise.resolve({ orgName: "org-1", appName }),
  });
  return render(tree);
}

describe("[appName] Layout — server-resolved permission snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppRoleAssignments.mockResolvedValue(null);
  });

  it("resolves the permission set once and exposes it to client consumers via the provider", async () => {
    seedSupabaseMswState({
      apps: [{ id: "app-1", name: "my-app", tenant_id: "tenant-1" }],
    });
    mockGetAppPermissionSet.mockResolvedValue(
      new Set(["app.read", "template.read"]),
    );

    await renderLayout("my-app");

    // The lookup is keyed by the resolved app id — a wrong id here would leak
    // another app's permission set into every guard below.
    expect(mockGetAppPermissionSet).toHaveBeenCalledTimes(1);
    expect(mockGetAppPermissionSet).toHaveBeenCalledWith("app-1");

    // The probe renders INSIDE the shell, so the snapshot reaching it proves
    // the provider wraps the whole client tree (guards, nav, sections).
    expect(JSON.parse(screen.getByTestId("snapshot").textContent!)).toEqual({
      appId: "app-1",
      permissions: ["app.read", "template.read"],
    });
  });

  it("seeds the resolved app-role assignments into the provider for client consumers", async () => {
    seedSupabaseMswState({
      apps: [{ id: "app-1", name: "my-app", tenant_id: "tenant-1" }],
    });
    mockGetAppPermissionSet.mockResolvedValue(new Set(["app.read"]));
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

    await renderLayout("my-app", <RolesProbe />);

    // The seed reaches the consumer exactly as resolved — a client useAppRoles
    // below the layout reads this instead of self-fetching.
    expect(JSON.parse(screen.getByTestId("roles").textContent!)).toEqual({
      appRoles,
      isAppScoped: true,
    });
  });

  it("exposes no app-roles seed when the assignment read fails, so consumers self-fetch", async () => {
    seedSupabaseMswState({
      apps: [{ id: "app-1", name: "my-app", tenant_id: "tenant-1" }],
    });
    mockGetAppPermissionSet.mockResolvedValue(new Set(["app.read"]));
    mockGetAppRoleAssignments.mockResolvedValue(null);

    await renderLayout("my-app", <RolesProbe />);

    // Null seed (not an empty one): useOptionalAppRolesSnapshot returns null so
    // useAppRoles falls back to its own fetch rather than trusting a fail-open [].
    expect(screen.getByTestId("roles")).toHaveTextContent("null");
  });

  it("renders the bare shell with no snapshot (and no permission lookup) when the app is unknown", async () => {
    seedSupabaseMswState({
      apps: [{ id: "app-1", name: "my-app", tenant_id: "tenant-1" }],
    });

    await renderLayout("nonexistent-app");

    // No app row → no permission resolution; the client guards own the
    // forbidden/not-found UX, so children must still render.
    expect(mockGetAppPermissionSet).not.toHaveBeenCalled();
    expect(screen.getByTestId("snapshot")).toHaveTextContent("null");
  });
});

describe("[appName] loading fallback", () => {
  it("renders the content-pane spinner, not the apps-list skeleton", () => {
    render(<AppTabLoading />);

    // The regression was tab switches suspending up to `apps/loading.tsx`
    // (the "Apps" header + card grid). This boundary's fallback must be the
    // bare progress indicator only.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("Apps")).not.toBeInTheDocument();
  });
});
