// @vitest-environment jsdom
/**
 * AppId (General settings) — renders the publish-policy toggles only when a repo
 * is connected, wires each to its column + canEdit from app_policy.update.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mui/material", () => ({
  Typography: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@mui/system", () => ({
  Stack: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/settings-shell', () => ({
  SettingsSection: ({ children }: any) => <section>{children}</section>,
}));
vi.mock("@/components/common/copyable-id", () => ({
  CopyableId: () => <span data-testid="copyable-id" />,
}));
vi.mock("@/components/provider-badge", () => ({
  ProviderBadge: () => <span data-testid="provider-badge" />,
}));
vi.mock("@outerlayer/locales", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));
vi.mock("../actions", () => ({ setAppPolicyAction: vi.fn().mockResolvedValue({ ok: true, data: undefined }) }));

// Stub the toggle so we can read the props AppId passes each instance.
vi.mock("./app-policy-toggle", () => ({
  AppPolicyToggle: ({ initialValue, canEdit, labelKey }: any) => (
    <div
      data-testid="policy-toggle"
      data-label={labelKey}
      data-init={String(initialValue)}
      data-canedit={String(canEdit)}
    />
  ),
}));

const hasPermission = vi.fn();
vi.mock("@/lib/adapters/use-app-permissions", () => ({
  useAppPermissions: () => ({ hasPermission }),
}));
const useAppContext = vi.fn();
vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => useAppContext(),
}));

import { AppId } from "./app-id";

function appWith(overrides: Record<string, unknown>) {
  return {
    app: {
      id: "app-1",
      git_connection: [{ repository: "owner/repo", provider: "github" }],
      git_branch: [{ branch_name: "main" }],
      require_pull_request: true,
      ...overrides,
    },
  };
}

const toggleByLabel = (label: string) =>
  screen
    .getAllByTestId("policy-toggle")
    .find((el) => el.getAttribute("data-label") === label);

describe("AppId — publish-policy toggles", () => {
  beforeEach(() => {
    hasPermission.mockReset();
    useAppContext.mockReset();
  });

  it("renders only the require-pull-request toggle (previews are no longer per-app)", () => {
    hasPermission.mockReturnValue(true);
    useAppContext.mockReturnValue(appWith({ require_pull_request: true }));

    render(<AppId />);

    const toggles = screen.getAllByTestId("policy-toggle");
    expect(toggles).toHaveLength(1);
    const reqPr = toggleByLabel("dashboard.developers.requirePullRequest");
    expect(reqPr?.getAttribute("data-init")).toBe("true");
    expect(reqPr?.getAttribute("data-canedit")).toBe("true");
    expect(
      toggleByLabel("dashboard.developers.enablePrPreviewEnvs")
    ).toBeUndefined();
    expect(hasPermission).toHaveBeenCalledWith("app_policy.update");
  });

  it("hides the toggle entirely when the user lacks app_policy.update", () => {
    hasPermission.mockReturnValue(false);
    useAppContext.mockReturnValue(appWith({}));

    render(<AppId />);

    // Not just disabled — restricted members must not see the policy at all.
    expect(screen.queryAllByTestId("policy-toggle")).toHaveLength(0);
    expect(hasPermission).toHaveBeenCalledWith("app_policy.update");
  });

  it("renders no toggles when no repository is connected", () => {
    hasPermission.mockReturnValue(true);
    useAppContext.mockReturnValue(appWith({ git_connection: [] }));

    render(<AppId />);

    expect(screen.queryAllByTestId("policy-toggle")).toHaveLength(0);
  });
});
