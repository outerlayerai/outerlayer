/**
 * Tests for `features/auth/actions.ts` — the pre-tenant auth server actions:
 * the caller's own terms-consent check, and the invite-acceptance trio. Every
 * export here runs before a tenant is resolved (the caller's own consent
 * record, or a membership that isn't active yet), so `preTenantAction`
 * withholds `db`/`tenantId` from every handler.
 *
 * Seams: `loadPreTenantActor` (`@/lib/adapters`) resolves the caller;
 * `createTermsAgreementService`, `recordTermsAgreementForUser`,
 * `acceptInvitationForUser`, `checkNeedsTermsAgreement`, and
 * `getInvitationDetailsForUser` are internal `lib/system` interfaces —
 * true seams, not the Supabase HTTP boundary underneath them (which their
 * own test files already cover under MSW).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockLoadPreTenantActor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantActor: mockLoadPreTenantActor,
}));

const mockCheckTermsStatus = vi.hoisted(() => vi.fn());
const mockCreateTermsAgreementService = vi.hoisted(() =>
  vi.fn(() => ({ checkTermsStatus: mockCheckTermsStatus })),
);
vi.mock("@/lib/system", () => ({
  createTermsAgreementService: mockCreateTermsAgreementService,
}));

const mockRecordTermsAgreementForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/terms-agreement", () => ({
  recordTermsAgreementForUser: mockRecordTermsAgreementForUser,
}));

const mockAcceptInvitationForUser = vi.hoisted(() => vi.fn());
const mockCheckNeedsTermsAgreement = vi.hoisted(() => vi.fn());
const mockGetInvitationDetailsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/org-actions-admin", () => ({
  acceptInvitationForUser: mockAcceptInvitationForUser,
  checkNeedsTermsAgreement: mockCheckNeedsTermsAgreement,
  getInvitationDetailsForUser: mockGetInvitationDetailsForUser,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

// Wraps the real `preTenantAction` so its behaviour (validate → resolve actor
// → handler → ok/fail) still runs, while recording each call's config so the
// `reason` table can be asserted on the config every export was actually
// built with, not inferred from behaviour.
const preTenantActionSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/action-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/action-kit")>();
  preTenantActionSpy.mockImplementation(actual.preTenantAction);
  return { ...actual, preTenantAction: preTenantActionSpy };
});

import { ActionErrorCodes } from "@/lib/action-kit";
import * as actionsModule from "./actions";
const { checkTermsAgreement, acceptInvitation, checkTermsForInvitation, getInvitationDetails } =
  actionsModule;

// Captured once, right after import: every export calls `preTenantAction`
// exactly once at module init, and `beforeEach`'s `vi.clearAllMocks()` would
// otherwise wipe that one-time call history before a test ever reads it.
const declaredReasons = preTenantActionSpy.mock.calls.map((call) => call[0].reason);

const ACTOR = { userId: "user-1", email: "user@example.com", raw: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPreTenantActor.mockResolvedValue(ACTOR);
});

// Every export here runs pre-tenant by construction, not by convention — a
// caller reading this file can see each action's tenant-less reason without
// tracing its handler, and a later edit that reaches for `authorizedAction`
// or drops the reason argument fails a test, not just a code review.
describe("module boundary", () => {
  it("declares each export's preTenantAction reason", () => {
    expect(declaredReasons).toEqual([
      "user-scoped", // checkTermsAgreement
      "pending-membership", // acceptInvitation
      "pending-membership", // checkTermsForInvitation
      "pending-membership", // getInvitationDetails
    ]);
  });

  it("does not import authorizedAction — every export here is tenant-less by design", () => {
    const source = readFileSync(join(__dirname, "actions.ts"), "utf8");
    const actionKitImport = source.match(/^import \{([^}]*)\} from "@\/lib\/action-kit";$/m);
    expect(actionKitImport).not.toBeNull();
    expect(actionKitImport![1]).not.toContain("authorizedAction");
  });

  it("does not export recordTermsAgreementForUser — it is a plain lib/system function, not a server action", () => {
    expect("recordTermsAgreementForUser" in actionsModule).toBe(false);
  });
});

describe("checkTermsAgreement", () => {
  it("returns unauthenticated and never resolves the terms service when the caller is unauthenticated", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await checkTermsAgreement(undefined);

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockCreateTermsAgreementService).not.toHaveBeenCalled();
  });

  it("returns terms status for the resolved actor", async () => {
    mockCheckTermsStatus.mockResolvedValue({ hasAgreed: true, needsCurrentVersion: false });

    const result = await checkTermsAgreement(undefined);

    expect(result).toEqual({
      ok: true,
      data: { data: { hasAgreed: true, needsCurrentVersion: false } },
    });
    expect(mockCheckTermsStatus).toHaveBeenCalledWith(ACTOR.userId, expect.any(String));
  });

  it("returns the service error as ServerActionResponse-shaped data, not a thrown handler error", async () => {
    mockCheckTermsStatus.mockRejectedValue(new Error("Service unavailable"));

    const result = await checkTermsAgreement(undefined);

    expect(result).toEqual({ ok: true, data: { error: "Service unavailable" } });
  });
});

describe("acceptInvitation", () => {
  it("returns unauthenticated and never calls acceptInvitationForUser when the caller is unauthenticated", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await acceptInvitation({ membershipId: "membership-1", agreedToTerms: false });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockAcceptInvitationForUser).not.toHaveBeenCalled();
  });

  it("accepts without recording terms when agreedToTerms is false — no consent record for a box that was never ticked", async () => {
    mockAcceptInvitationForUser.mockResolvedValue({
      success: true,
      tenantId: "tenant-1",
      companyName: "Acme Co",
    });

    const result = await acceptInvitation({ membershipId: "membership-1", agreedToTerms: false });

    expect(mockRecordTermsAgreementForUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: { data: { tenantId: "tenant-1", companyName: "Acme Co" } },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/orgs");
  });

  it("records terms for the actor before accepting when agreedToTerms is true", async () => {
    mockRecordTermsAgreementForUser.mockResolvedValue({
      data: { agreementId: "agreement-1", termsVersion: "v1" },
    });
    mockAcceptInvitationForUser.mockResolvedValue({
      success: true,
      tenantId: "tenant-1",
      companyName: "Acme Co",
    });

    const result = await acceptInvitation({ membershipId: "membership-1", agreedToTerms: true });

    expect(mockRecordTermsAgreementForUser).toHaveBeenCalledWith(ACTOR.userId);
    expect(mockAcceptInvitationForUser).toHaveBeenCalledWith(
      { userId: ACTOR.userId, email: ACTOR.email },
      "membership-1",
    );
    expect(result).toEqual({
      ok: true,
      data: { data: { tenantId: "tenant-1", companyName: "Acme Co" } },
    });
  });

  it("still accepts the invitation when terms recording fails", async () => {
    mockRecordTermsAgreementForUser.mockResolvedValue({ error: "Database error" });
    mockAcceptInvitationForUser.mockResolvedValue({
      success: true,
      tenantId: "tenant-1",
      companyName: "Acme Co",
    });

    const result = await acceptInvitation({ membershipId: "membership-1", agreedToTerms: true });

    expect(result).toEqual({
      ok: true,
      data: { data: { tenantId: "tenant-1", companyName: "Acme Co" } },
    });
  });

  it("passes through the service's failure message unchanged (e.g. expired)", async () => {
    mockAcceptInvitationForUser.mockResolvedValue({ success: false, error: "expired" });

    const result = await acceptInvitation({ membershipId: "membership-1", agreedToTerms: false });

    expect(result).toEqual({ ok: true, data: { error: "expired" } });
  });
});

describe("checkTermsForInvitation", () => {
  it("returns unauthenticated when the caller is unauthenticated", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await checkTermsForInvitation(undefined);

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockCheckNeedsTermsAgreement).not.toHaveBeenCalled();
  });

  it("fails closed toward needsAgreement:true when the underlying read throws", async () => {
    mockCheckNeedsTermsAgreement.mockRejectedValue(new Error("connection reset"));

    const result = await checkTermsForInvitation(undefined);

    expect(result).toEqual({
      ok: true,
      data: { data: { needsAgreement: true, currentVersion: expect.any(String) } },
    });
  });

  it("returns needsAgreement:false for an actor who has already agreed", async () => {
    mockCheckNeedsTermsAgreement.mockResolvedValue(false);

    const result = await checkTermsForInvitation(undefined);

    expect(result).toEqual({
      ok: true,
      data: { data: { needsAgreement: false, currentVersion: expect.any(String) } },
    });
    expect(mockCheckNeedsTermsAgreement).toHaveBeenCalledWith(ACTOR.userId);
  });
});

describe("getInvitationDetails", () => {
  it("returns unauthenticated and never calls getInvitationDetailsForUser when the caller is unauthenticated", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await getInvitationDetails({ membershipId: "membership-1" });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockGetInvitationDetailsForUser).not.toHaveBeenCalled();
  });

  it("returns the invitation details for the resolved actor", async () => {
    const details = {
      id: "membership-1",
      companyName: "Acme Co",
      organizationName: "acme",
      isExpired: false,
      expiresAt: null,
    };
    mockGetInvitationDetailsForUser.mockResolvedValue({ success: true, data: details });

    const result = await getInvitationDetails({ membershipId: "membership-1" });

    expect(result).toEqual({ ok: true, data: { data: details } });
    expect(mockGetInvitationDetailsForUser).toHaveBeenCalledWith(
      { userId: ACTOR.userId },
      "membership-1",
    );
  });

  it("passes through already_accepted unchanged — the view branches on this literal", async () => {
    mockGetInvitationDetailsForUser.mockResolvedValue({ success: false, error: "already_accepted" });

    const result = await getInvitationDetails({ membershipId: "membership-1" });

    expect(result).toEqual({ ok: true, data: { error: "already_accepted" } });
  });
});
