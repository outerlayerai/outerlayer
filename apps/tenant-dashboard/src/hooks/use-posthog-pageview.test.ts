// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import posthog from "posthog-js";
import { usePostHogPageview } from "./use-posthog-pageview";

// Mock posthog
vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
  capture: vi.fn(),
}));

// Mock next/navigation
let mockPathname = "/";
let mockParams: Record<string, string> = {};
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useParams: () => mockParams,
}));

// Mock auth context
let mockUser: { activeTenant: { tenant_id: string } | null } | null = null;
vi.mock("../auth/hooks", () => ({
  useAuthContext: () => ({ user: mockUser }),
}));

describe("usePostHogPageview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      activeTenant: { tenant_id: "tenant-123" },
    };
  });

  describe("path normalization", () => {
    it("should replace dynamic orgName segment with [orgName]", () => {
      mockPathname = "/orgs/acme-corp/apps";
      mockParams = { orgName: "acme-corp" };

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/orgs/[orgName]/apps",
        tenant_id: "tenant-123",
        param_orgName: "acme-corp",
      });
    });

    it("should replace multiple dynamic segments", () => {
      mockPathname = "/orgs/acme-corp/apps/my-app/logs";
      mockParams = { orgName: "acme-corp", appName: "my-app" };

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/orgs/[orgName]/apps/[appName]/logs",
        tenant_id: "tenant-123",
        param_orgName: "acme-corp",
        param_appName: "my-app",
      });
    });

    it("should handle paths without dynamic segments", () => {
      mockPathname = "/settings";
      mockParams = {};

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/settings",
        tenant_id: "tenant-123",
      });
    });

    it("should handle deeply nested dynamic segments", () => {
      mockPathname = "/orgs/acme-corp/apps/my-app/templates/prompt-1/edit";
      mockParams = {
        orgName: "acme-corp",
        appName: "my-app",
        templateId: "prompt-1",
      };

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/orgs/[orgName]/apps/[appName]/templates/[templateId]/edit",
        tenant_id: "tenant-123",
        param_orgName: "acme-corp",
        param_appName: "my-app",
        param_templateId: "prompt-1",
      });
    });
  });

  describe("platform admin exclusion", () => {
    it("should not track platform admin routes", () => {
      mockPathname = "/platform-admin/users";
      mockParams = {};

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).not.toHaveBeenCalled();
    });

    it("should not track nested platform admin routes", () => {
      mockPathname = "/platform-admin/organizations/123";
      mockParams = { orgId: "123" };

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).not.toHaveBeenCalled();
    });
  });

  describe("tenant_id handling", () => {
    it("should include tenant_id when user has active tenant", () => {
      mockPathname = "/dashboard";
      mockParams = {};
      mockUser = {
        activeTenant: { tenant_id: "tenant-456" },
      };

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/dashboard",
        tenant_id: "tenant-456",
      });
    });

    it("should handle missing active tenant", () => {
      mockPathname = "/dashboard";
      mockParams = {};
      mockUser = { activeTenant: null };

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/dashboard",
        tenant_id: undefined,
      });
    });

    it("should handle missing user", () => {
      mockPathname = "/dashboard";
      mockParams = {};
      mockUser = null;

      renderHook(() => usePostHogPageview());

      expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
        page_path: "/dashboard",
        tenant_id: undefined,
      });
    });
  });
});
