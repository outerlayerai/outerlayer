/**
 * Unit tests for the org-lifecycle action-adapters — the flat,
 * `ServerActionResponse`-returning functions the org switcher, the temp-access
 * banner, and the /orgs picker call. Each adapter wraps a real
 * `preTenantAction` (not mocked away): `loadPreTenantActor` and the
 * `switchActiveOrg`/`countActiveMemberships`/`createNewOrganization` service
 * adapters all live behind the same `@/lib/adapters` seam `actions.ts`
 * imports, so mocking that one module drives both the actor-resolution and
 * the service-call path.
 *
 * Tests cover:
 * - setLastActiveOrgAction: success, invalid org, no membership
 * - createOrganizationAction: success, limit enforcement, validation
 * - getMembershipCountAction: success, authentication failure
 * - getTempAccessStatusAction: success, no access, expired access
 *
 * The invite-acceptance trio (acceptInvitation, checkTermsForInvitation,
 * getInvitationDetails) and its terms-recording coverage live in
 * `src/features/auth/actions.test.ts` — they run pre-tenant now, wrapped in
 * `preTenantAction`, not as plain exports of this module.
 */

// Mock server-only module
vi.mock("server-only", () => ({}));

// Mock next/cache
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock the actor-resolution and service-call seams `actions.ts` reaches
// through the adapter layer; everything else in the barrel stays real.
const mockLoadPreTenantActor = vi.hoisted(() => vi.fn());
const mockSwitchActiveOrg = vi.hoisted(() => vi.fn());
const mockCountActiveMemberships = vi.hoisted(() => vi.fn());
const mockCreateNewOrganization = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantActor: mockLoadPreTenantActor,
  switchActiveOrg: mockSwitchActiveOrg,
  countActiveMemberships: mockCountActiveMemberships,
  createNewOrganization: mockCreateNewOrganization,
}));

vi.mock("@/lib/system/temp-access-grant", () => ({
  getActiveTempAccessGrant: vi.fn(),
}));

import type { MockedFunction } from "vitest";
import { revalidatePath } from "next/cache";
import { getActiveTempAccessGrant } from "@/lib/system/temp-access-grant";

// Import after mocks are set up
import {
  setLastActiveOrgAction,
  createOrganizationAction,
  getMembershipCountAction,
  getTempAccessStatusAction,
} from "./action-adapters";

describe("Organization Server Actions", () => {
  const mockRevalidatePath = revalidatePath as MockedFunction<typeof revalidatePath>;
  const mockGetActiveTempAccessGrant = getActiveTempAccessGrant as MockedFunction<
    typeof getActiveTempAccessGrant
  >;

  const mockUser = {
    id: "user-123",
    email: "test@example.com",
    app_metadata: { tenant_id: "tenant-1" },
    user_metadata: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: an authenticated actor whose `raw` is the full Supabase
    // user the legacy service signatures still take whole.
    mockLoadPreTenantActor.mockResolvedValue({
      userId: mockUser.id,
      email: mockUser.email,
      raw: mockUser,
    });
  });

  describe("setLastActiveOrg", () => {
    it("should return error when user is not authenticated", async () => {
      mockLoadPreTenantActor.mockResolvedValue(null);

      const result = await setLastActiveOrgAction("tenant-2");

      expect(result).toEqual({ error: "Not authenticated" });
    });

    it("should successfully switch organization", async () => {
      mockSwitchActiveOrg.mockResolvedValue({
        success: true,
        tenantId: "tenant-2",
      });

      const result = await setLastActiveOrgAction("tenant-2");

      expect(result).toEqual({ data: { tenantId: "tenant-2" } });
      expect(mockSwitchActiveOrg).toHaveBeenCalledWith({
        user: mockUser,
        tenantId: "tenant-2",
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/orgs");
    });

    it("should return error when user is not a member", async () => {
      mockSwitchActiveOrg.mockResolvedValue({
        success: false,
        error: "Not a member of this organization",
      });

      const result = await setLastActiveOrgAction("tenant-999");

      expect(result).toEqual({ error: "Not a member of this organization" });
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("should return error when the preference write fails", async () => {
      mockSwitchActiveOrg.mockResolvedValue({
        success: false,
        error: "pg: forbidden",
      });

      const result = await setLastActiveOrgAction("tenant-2");

      expect(result).toEqual({
        error: "pg: forbidden",
      });
    });
  });

  describe("createOrganization", () => {
    it("should return error when user is not authenticated", async () => {
      mockLoadPreTenantActor.mockResolvedValue(null);

      const result = await createOrganizationAction("Test Org", "Test Company");

      expect(result).toEqual({ error: "Not authenticated" });
    });

    it("should successfully create organization", async () => {
      mockCreateNewOrganization.mockResolvedValue({
        success: true,
        tenantId: "new-tenant-123",
        organizationName: "Test Org",
      });

      const result = await createOrganizationAction("Test Org", "Test Company");

      expect(result).toEqual({
        data: {
          tenantId: "new-tenant-123",
          organizationName: "Test Org",
        },
      });
      expect(mockCreateNewOrganization).toHaveBeenCalledWith({
        user: mockUser,
        organizationName: "Test Org",
        companyName: "Test Company",
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/orgs");
    });

    it("should return error when org limit is exceeded", async () => {
      mockCreateNewOrganization.mockResolvedValue({
        success: false,
        error: "You cannot belong to more than 10 organizations",
      });

      const result = await createOrganizationAction("Test Org", "Test Company");

      expect(result).toEqual({
        error: "You cannot belong to more than 10 organizations",
      });
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("should return error when organization name is taken", async () => {
      mockCreateNewOrganization.mockResolvedValue({
        success: false,
        error: "Organization name is already taken",
      });

      const result = await createOrganizationAction("Existing Org", "Test Company");

      expect(result).toEqual({
        error: "Organization name is already taken",
      });
    });

    it("should return error when Stripe customer creation fails", async () => {
      mockCreateNewOrganization.mockResolvedValue({
        success: false,
        error: "Failed to set up billing. Please try again.",
      });

      const result = await createOrganizationAction("Test Org", "Test Company");

      expect(result).toEqual({
        error: "Failed to set up billing. Please try again.",
      });
    });
  });

  describe("getMembershipCount", () => {
    it("should return error when user is not authenticated", async () => {
      mockLoadPreTenantActor.mockResolvedValue(null);

      const result = await getMembershipCountAction();

      expect(result).toEqual({ error: "Not authenticated" });
    });

    it("should successfully return membership count", async () => {
      mockCountActiveMemberships.mockResolvedValue({
        success: true,
        count: 5,
      });

      const result = await getMembershipCountAction();

      expect(result).toEqual({ data: 5 });
      expect(mockCountActiveMemberships).toHaveBeenCalledWith(mockUser);
    });

    it("should return error when service fails", async () => {
      mockCountActiveMemberships.mockResolvedValue({
        success: false,
        error: "Database query failed",
      });

      const result = await getMembershipCountAction();

      expect(result).toEqual({ error: "Database query failed" });
    });
  });

  describe("getTempAccessStatus", () => {
    it("should return error when user is not authenticated", async () => {
      mockLoadPreTenantActor.mockResolvedValue(null);

      const result = await getTempAccessStatusAction("tenant-123");

      expect(result).toEqual({ error: "Not authenticated" });
    });

    it("should return null when no active grant exists", async () => {
      mockGetActiveTempAccessGrant.mockResolvedValue(null);

      const result = await getTempAccessStatusAction("tenant-123");

      expect(result).toEqual({ data: null });
      expect(mockGetActiveTempAccessGrant).toHaveBeenCalledWith({
        tenantId: "tenant-123",
        userId: mockUser.id,
      });
    });

    it("should return access details when active grant exists", async () => {
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes from now
      mockGetActiveTempAccessGrant.mockResolvedValue({
        id: "grant-123",
        expiresAt,
        companyName: "Customer Company",
        organizationName: "Customer Org",
      });

      const result = await getTempAccessStatusAction("tenant-123");

      expect(result.data?.hasAccess).toBe(true);
      expect(result.data?.grantId).toBe("grant-123");
      expect(result.data?.organizationName).toBe("Customer Company");
      expect(result.data?.expiresAt).toBe(expiresAt);
      expect(result.data?.timeRemainingMinutes).toBeGreaterThan(0);
    });

    it("should use organization_name when company_name is null", async () => {
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      mockGetActiveTempAccessGrant.mockResolvedValue({
        id: "grant-123",
        expiresAt,
        companyName: null,
        organizationName: "Customer Org",
      });

      const result = await getTempAccessStatusAction("tenant-123");

      expect(result.data?.organizationName).toBe("Customer Org");
    });

    it("should calculate timeRemainingMinutes correctly", async () => {
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
      mockGetActiveTempAccessGrant.mockResolvedValue({
        id: "grant-123",
        expiresAt,
        companyName: "Customer Company",
        organizationName: "Customer Org",
      });

      const result = await getTempAccessStatusAction("tenant-123");

      expect(result.data?.timeRemainingMinutes).toBeGreaterThanOrEqual(14);
      expect(result.data?.timeRemainingMinutes).toBeLessThanOrEqual(16);
    });

    it("should return 0 for timeRemainingMinutes when expired", async () => {
      const expiresAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
      mockGetActiveTempAccessGrant.mockResolvedValue({
        id: "grant-123",
        expiresAt,
        companyName: "Customer Company",
        organizationName: "Customer Org",
      });

      const result = await getTempAccessStatusAction("tenant-123");

      expect(result.data?.timeRemainingMinutes).toBe(0);
    });
  });
});
