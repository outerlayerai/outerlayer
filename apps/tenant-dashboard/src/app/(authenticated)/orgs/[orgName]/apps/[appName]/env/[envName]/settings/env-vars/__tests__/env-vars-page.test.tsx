// @vitest-environment jsdom
/**
 * Regression tests for the Environment Variables settings page content.
 *
 * Env var data now rides the request-tenant RLS-scoped client
 * (`loadRequestServiceContext`), so the underlying query is gated by the
 * `env_var.read` RLS policy itself; the explicit permission check
 * below is a friendly early message, not the enforcement boundary. This pins
 * that the message shows (and no env-var read runs) before the RLS-scoped
 * reads fire.
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md):
 *  - The Supabase `app` lookup is an HTTP boundary → MSW (seedSupabaseMswState),
 *    not a Supabase client mock.
 *  - getAppPermissionSet is the permission-gate seam → mocked.
 *  - loadRequestServiceContext, resolveEnvIdForStorage, and the
 *    `@/features/integrations/read` reads are internal seams with stable
 *    signatures → mocked; EnvVarEditor is a stub so the test asserts the
 *    gate, not the editor internals.
 */

import { render, screen } from "@testing-library/react";

import { EnvVarsContent } from "../page";
import { getAppPermissionSet } from "@/utils/get-app-permissions";
import { resolveEnvIdForStorage } from "@/lib/environments/env-scope";
import { loadEnvironmentNames, loadEnvVarsForApp } from "@/features/integrations/read";
import { seedSupabaseMswState } from "@/test-helpers/msw-handlers";
import type { Permission } from "@/utils/permissions";

vi.mock("@/utils/get-app-permissions", () => ({
  getAppPermissionSet: vi.fn(),
}));

vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: vi.fn().mockResolvedValue({
    db: {},
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "member" },
  }),
}));

vi.mock("@/lib/environments/env-scope", () => ({
  resolveEnvIdForStorage: vi.fn(),
}));

vi.mock("@/features/integrations/read", () => ({
  loadEnvVarsForApp: vi.fn(),
  loadEnvironmentNames: vi.fn(),
}));

vi.mock("@/features/integrations/components/env-vars", () => ({
  EnvVarEditor: () => <div data-testid="env-var-editor" />,
}));

const mockGetAppPermissionSet = getAppPermissionSet as ReturnType<typeof vi.fn>;
const mockResolveEnvIdForStorage = resolveEnvIdForStorage as ReturnType<typeof vi.fn>;
const mockLoadEnvVarsForApp = loadEnvVarsForApp as ReturnType<typeof vi.fn>;
const mockLoadEnvironmentNames = loadEnvironmentNames as ReturnType<typeof vi.fn>;

async function renderContent(permissions: Permission[]) {
  seedSupabaseMswState({ apps: [{ id: "app-1", name: "app-1", tenant_id: "tenant-1" }] });
  mockGetAppPermissionSet.mockResolvedValue(new Set(permissions));
  const tree = await EnvVarsContent({ appName: "app-1", envParam: undefined });
  return render(tree);
}

describe("EnvVarsContent — read gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEnvIdForStorage.mockResolvedValue({ envId: "env-1", envName: "dev" });
    mockLoadEnvVarsForApp.mockResolvedValue([]);
    mockLoadEnvironmentNames.mockResolvedValue({});
  });

  it("denies access and loads no env vars when the user lacks env_var.read", async () => {
    await renderContent(["app.read"]);

    expect(screen.getByText(/don.?t have permission to view environment variables/i)).toBeInTheDocument();
    expect(screen.queryByTestId("env-var-editor")).not.toBeInTheDocument();
    // The gate must short-circuit before any env var data is fetched.
    expect(mockLoadEnvVarsForApp).not.toHaveBeenCalled();
  });

  it("renders the editor when the user has env_var.read", async () => {
    await renderContent(["env_var.read"]);

    expect(screen.getByTestId("env-var-editor")).toBeInTheDocument();
    expect(mockLoadEnvVarsForApp).toHaveBeenCalledWith("app-1");
  });
});
