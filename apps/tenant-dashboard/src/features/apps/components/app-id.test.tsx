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
      git_connection: [
        { repository: "owner/repo", provider: "github", pr_comments_enabled: true },
      ],
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

const savePrCommentsEnabled = vi.fn().mockResolvedValue({});

describe("AppId — publish-policy toggles", () => {
  beforeEach(() => {
    hasPermission.mockReset();
    useAppContext.mockReset();
    savePrCommentsEnabled.mockClear();
  });

  it("renders the require-pull-request and pr-comments toggles (previews are no longer per-app)", () => {
    hasPermission.mockReturnValue(true);
    useAppContext.mockReturnValue(appWith({ require_pull_request: true }));

    render(<AppId savePrCommentsEnabled={savePrCommentsEnabled} />);

    const toggles = screen.getAllByTestId("policy-toggle");
    expect(toggles).toHaveLength(2);
    const reqPr = toggleByLabel("dashboard.developers.requirePullRequest");
    expect(reqPr?.getAttribute("data-init")).toBe("true");
    expect(reqPr?.getAttribute("data-canedit")).toBe("true");
    const prComments = toggleByLabel("dashboard.developers.prCommentsEnabled");
    expect(prComments?.getAttribute("data-init")).toBe("true");
    expect(prComments?.getAttribute("data-canedit")).toBe("true");
    expect(
      toggleByLabel("dashboard.developers.enablePrPreviewEnvs")
    ).toBeUndefined();
    expect(hasPermission).toHaveBeenCalledWith("app_policy.update");
    expect(hasPermission).toHaveBeenCalledWith("git_connection.update");
  });

  it("reflects a disabled pr_comments_enabled value on the toggle's initial state", () => {
    hasPermission.mockReturnValue(true);
    useAppContext.mockReturnValue(
      appWith({
        git_connection: [
          { repository: "owner/repo", provider: "github", pr_comments_enabled: false },
        ],
      })
    );

    render(<AppId savePrCommentsEnabled={savePrCommentsEnabled} />);

    const prComments = toggleByLabel("dashboard.developers.prCommentsEnabled");
    expect(prComments?.getAttribute("data-init")).toBe("false");
  });

  it("hides the require-pull-request toggle entirely when the user lacks app_policy.update, independent of the pr-comments toggle", () => {
    hasPermission.mockImplementation((perm: string) => perm !== "app_policy.update");
    useAppContext.mockReturnValue(appWith({}));

    render(<AppId savePrCommentsEnabled={savePrCommentsEnabled} />);

    // Not just disabled — restricted members must not see the policy at all.
    expect(toggleByLabel("dashboard.developers.requirePullRequest")).toBeUndefined();
    expect(
      toggleByLabel("dashboard.developers.prCommentsEnabled")?.getAttribute("data-canedit")
    ).toBe("true");
    expect(hasPermission).toHaveBeenCalledWith("app_policy.update");
  });

  it("hides the pr-comments toggle entirely when the user lacks git_connection.update, independent of the require-pull-request toggle", () => {
    hasPermission.mockImplementation((perm: string) => perm !== "git_connection.update");
    useAppContext.mockReturnValue(appWith({}));

    render(<AppId savePrCommentsEnabled={savePrCommentsEnabled} />);

    expect(toggleByLabel("dashboard.developers.prCommentsEnabled")).toBeUndefined();
    expect(
      toggleByLabel("dashboard.developers.requirePullRequest")?.getAttribute("data-canedit")
    ).toBe("true");
    expect(hasPermission).toHaveBeenCalledWith("git_connection.update");
  });

  it("renders no toggles when no repository is connected", () => {
    hasPermission.mockReturnValue(true);
    useAppContext.mockReturnValue(appWith({ git_connection: [] }));

    render(<AppId savePrCommentsEnabled={savePrCommentsEnabled} />);

    expect(screen.queryAllByTestId("policy-toggle")).toHaveLength(0);
  });
});
