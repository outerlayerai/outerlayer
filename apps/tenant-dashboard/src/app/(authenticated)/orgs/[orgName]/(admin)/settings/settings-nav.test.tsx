// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/orgs/acme/settings/general" }));
vi.mock("@/components/iconify", () => ({ default: () => null }));

import { SettingsNav } from "./settings-nav";

const baseProps = {
  orgName: "acme",
  showRolesTab: false,
  showSsoTab: false,
  showBillingTab: false,
  showAuditLogTab: false,
  showAiCostsTab: false,
  showManagementApiKeysTab: false,
};

describe("SettingsNav — License tab (self-host gate)", () => {
  it("shows the License tab, linked to the license route, when showLicenseTab is true", () => {
    render(<SettingsNav {...baseProps} showLicenseTab={true} />);
    const link = screen.getByRole("link", { name: /license/i });
    expect(link).toHaveAttribute("href", "/orgs/acme/settings/license");
  });

  it("hides the License tab when showLicenseTab is false (Cloud)", () => {
    render(<SettingsNav {...baseProps} showLicenseTab={false} />);
    expect(screen.queryByRole("link", { name: /license/i })).not.toBeInTheDocument();
  });
});

describe("SettingsNav — AI costs tab (permission gate)", () => {
  it("shows the AI costs tab, linked to the ai-costs route, when showAiCostsTab is true", () => {
    render(<SettingsNav {...baseProps} showLicenseTab={false} showAiCostsTab={true} />);
    const link = screen.getByRole("link", { name: /ai costs/i });
    expect(link).toHaveAttribute("href", "/orgs/acme/settings/ai-costs");
  });

  it("hides the AI costs tab when showAiCostsTab is false (member without ai_cost_config.read)", () => {
    render(<SettingsNav {...baseProps} showLicenseTab={false} showAiCostsTab={false} />);
    expect(screen.queryByRole("link", { name: /ai costs/i })).not.toBeInTheDocument();
  });
});

describe("SettingsNav — Management API keys tab (permission gate)", () => {
  it("shows the Management API keys tab, linked to the management-api-keys route, when showManagementApiKeysTab is true", () => {
    render(<SettingsNav {...baseProps} showLicenseTab={false} showManagementApiKeysTab={true} />);
    const link = screen.getByRole("link", { name: /management api keys/i });
    expect(link).toHaveAttribute("href", "/orgs/acme/settings/management-api-keys");
  });

  it("hides the Management API keys tab when showManagementApiKeysTab is false (member without management_api_key.read)", () => {
    render(<SettingsNav {...baseProps} showLicenseTab={false} showManagementApiKeysTab={false} />);
    expect(screen.queryByRole("link", { name: /management api keys/i })).not.toBeInTheDocument();
  });
});
