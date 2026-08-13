/**
 * `checkNeedsTermsAgreement` — pins the "any agreement blocks, none needs
 * one" policy from the doc comment (mirrors `TermsAgreementService.
 * checkTermsStatus`'s non-blocking read) and the fail-safe error path.
 *
 * `acceptInvitationForUser`/`getInvitationDetailsForUser` seam-mock
 * `OrganizationService` directly rather than going through MSW — same
 * rationale as `organization-service.test.ts`: the class takes its deps in
 * the constructor, so mocking the class is the injectable seam, not the
 * Supabase transport underneath it.
 */
import { seedSupabaseMswState } from "@/test-helpers/msw-handlers";

const mockAcceptInvitation = vi.hoisted(() => vi.fn());
const mockDeclineInvitation = vi.hoisted(() => vi.fn());
const mockGetInvitationDetails = vi.hoisted(() => vi.fn());
const MockOrganizationService = vi.hoisted(() =>
  vi.fn().mockImplementation(function () {
    return {
      acceptInvitation: mockAcceptInvitation,
      declineInvitation: mockDeclineInvitation,
      getInvitationDetails: mockGetInvitationDetails,
    };
  }),
);
vi.mock("./organization-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./organization-service")>()),
  OrganizationService: MockOrganizationService,
}));

vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  createBillingService: vi.fn(() => ({})),
  resolveBillingConfig: vi.fn(() => ({ enabled: true })),
  serverLogger: {
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  checkNeedsTermsAgreement,
  acceptInvitationForUser,
  declineInvitationForUser,
  getInvitationDetailsForUser,
} from "./org-actions-admin";

const USER_ID = "user-1";

describe("checkNeedsTermsAgreement", () => {
  it("returns false when the user has an existing agreement", async () => {
    seedSupabaseMswState({
      termsAgreements: [{ id: "agreement-1", user_id: USER_ID, version: "v1" }],
    });

    await expect(checkNeedsTermsAgreement(USER_ID)).resolves.toBe(false);
  });

  it("returns true when the user has no agreement row", async () => {
    seedSupabaseMswState({ termsAgreements: [] });

    await expect(checkNeedsTermsAgreement(USER_ID)).resolves.toBe(true);
  });

  it("returns true for a user with only a different user's agreement on record", async () => {
    seedSupabaseMswState({
      termsAgreements: [{ id: "agreement-2", user_id: "user-2", version: "v1" }],
    });

    await expect(checkNeedsTermsAgreement(USER_ID)).resolves.toBe(true);
  });

  it("throws (fail-safe) instead of returning a boolean when the read errors, without the driver's error text", async () => {
    seedSupabaseMswState({
      termsAgreements: [],
      tableErrors: { terms_agreement_select: { message: "connection reset" } },
    });

    let thrown: unknown;
    try {
      await checkNeedsTermsAgreement(USER_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Failed to check terms agreement");
  });
});

describe("acceptInvitationForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds the user object from the explicit subject, not a wider actor shape", async () => {
    mockAcceptInvitation.mockResolvedValue({
      success: true,
      tenantId: "tenant-1",
      companyName: "Acme Co",
    });

    const result = await acceptInvitationForUser(
      { userId: USER_ID, email: "user@example.com" },
      "membership-1",
    );

    expect(mockAcceptInvitation).toHaveBeenCalledWith({
      user: { id: USER_ID, email: "user@example.com" },
      membershipId: "membership-1",
    });
    expect(result).toEqual({ success: true, tenantId: "tenant-1", companyName: "Acme Co" });
  });

  it("passes through a failure (e.g. expired) unchanged", async () => {
    mockAcceptInvitation.mockResolvedValue({ success: false, error: "expired" });

    const result = await acceptInvitationForUser({ userId: USER_ID, email: null }, "membership-1");

    expect(result).toEqual({ success: false, error: "expired" });
  });

  // pins the deliberate `supabaseServer: null` choice — this constructor
  // never receives a session client, by design (see organization-service.ts)
  it("constructs OrganizationService with supabaseServer: null, not omitted", async () => {
    mockAcceptInvitation.mockResolvedValue({ success: true });

    await acceptInvitationForUser({ userId: USER_ID, email: null }, "membership-1");

    expect(MockOrganizationService).toHaveBeenCalledWith(
      expect.objectContaining({ supabaseServer: null }),
    );
  });
});

describe("declineInvitationForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds the user object from the explicit subject, not a wider actor shape", async () => {
    mockDeclineInvitation.mockResolvedValue({ success: true });

    const result = await declineInvitationForUser(
      { userId: USER_ID, email: "user@example.com" },
      "membership-1",
    );

    expect(mockDeclineInvitation).toHaveBeenCalledWith({
      user: { id: USER_ID, email: "user@example.com" },
      membershipId: "membership-1",
    });
    expect(result).toEqual({ success: true });
  });

  it("passes through a failure (e.g. already accepted) unchanged", async () => {
    mockDeclineInvitation.mockResolvedValue({
      success: false,
      error: "This invitation has already been accepted",
    });

    const result = await declineInvitationForUser({ userId: USER_ID, email: null }, "membership-1");

    expect(result).toEqual({
      success: false,
      error: "This invitation has already been accepted",
    });
  });

  it("constructs OrganizationService with supabaseServer: null, not omitted", async () => {
    mockDeclineInvitation.mockResolvedValue({ success: true });

    await declineInvitationForUser({ userId: USER_ID, email: null }, "membership-1");

    expect(MockOrganizationService).toHaveBeenCalledWith(
      expect.objectContaining({ supabaseServer: null }),
    );
  });
});

describe("getInvitationDetailsForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds the user object from the explicit subject and returns the service's data", async () => {
    const details = {
      id: "membership-1",
      companyName: "Acme Co",
      organizationName: "acme",
      isExpired: false,
      expiresAt: null,
    };
    mockGetInvitationDetails.mockResolvedValue({ success: true, data: details });

    const result = await getInvitationDetailsForUser({ userId: USER_ID }, "membership-1");

    expect(mockGetInvitationDetails).toHaveBeenCalledWith({
      user: { id: USER_ID },
      membershipId: "membership-1",
    });
    expect(result).toEqual({ success: true, data: details });
  });
});
