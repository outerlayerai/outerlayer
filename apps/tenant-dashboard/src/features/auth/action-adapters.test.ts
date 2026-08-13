/**
 * Tests for `features/auth/action-adapters.ts` — the client-facing unwrap of
 * the pre-tenant `preTenantAction` envelope into the plain
 * `ServerActionResponse` shape the auth views render.
 *
 * The one thing worth pinning here that the raw-action tests don't already
 * cover: `checkTermsAgreement` and the invite trio share the same
 * `UNAUTHENTICATED` code but must resolve to two different literal strings —
 * a unifying refactor of this mapping would silently change copy on the
 * invite path.
 */
const mockCheckTermsAgreement = vi.hoisted(() => vi.fn());
const mockAcceptInvitation = vi.hoisted(() => vi.fn());
const mockDeclineInvitation = vi.hoisted(() => vi.fn());
const mockCheckTermsForInvitation = vi.hoisted(() => vi.fn());
const mockGetInvitationDetails = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  checkTermsAgreement: mockCheckTermsAgreement,
  acceptInvitation: mockAcceptInvitation,
  declineInvitation: mockDeclineInvitation,
  checkTermsForInvitation: mockCheckTermsForInvitation,
  getInvitationDetails: mockGetInvitationDetails,
}));

import { ActionErrorCodes } from "@/lib/action-kit/result";
import {
  checkTermsAgreementAction,
  acceptInvitationAction,
  declineInvitationAction,
  checkTermsForInvitationAction,
  getInvitationDetailsAction,
} from "./action-adapters";

beforeEach(() => {
  vi.clearAllMocks();
});

// proves AC-12
it("checkTermsAgreementAction maps UNAUTHENTICATED to 'Authentication required'", async () => {
  mockCheckTermsAgreement.mockResolvedValue({
    ok: false,
    error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
  });

  const result = await checkTermsAgreementAction();

  expect(result).toEqual({ error: "Authentication required" });
});

it("checkTermsAgreementAction forwards the wrapped data unchanged on success", async () => {
  mockCheckTermsAgreement.mockResolvedValue({
    ok: true,
    data: { data: { hasAgreed: true, needsCurrentVersion: false } },
  });

  const result = await checkTermsAgreementAction();

  expect(result).toEqual({ data: { hasAgreed: true, needsCurrentVersion: false } });
});

it("checkTermsAgreementAction redacts a thrown database-shaped error returned inside the envelope's success data", async () => {
  mockCheckTermsAgreement.mockResolvedValue({
    ok: true,
    data: { error: "Failed to get latest agreement: relation \"terms_agreement\" does not exist" },
  });

  const result = await checkTermsAgreementAction();

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

// proves AC-16
it("acceptInvitationAction maps UNAUTHENTICATED to 'Not authenticated', distinct from checkTermsAgreement's string", async () => {
  mockAcceptInvitation.mockResolvedValue({
    ok: false,
    error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
  });

  const result = await acceptInvitationAction("membership-1", true);

  expect(result).toEqual({ error: "Not authenticated" });
  expect(mockAcceptInvitation).toHaveBeenCalledWith({
    membershipId: "membership-1",
    agreedToTerms: true,
  });
});

it("declineInvitationAction maps UNAUTHENTICATED to 'Not authenticated'", async () => {
  mockDeclineInvitation.mockResolvedValue({
    ok: false,
    error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
  });

  const result = await declineInvitationAction("membership-1");

  expect(result).toEqual({ error: "Not authenticated" });
  expect(mockDeclineInvitation).toHaveBeenCalledWith({ membershipId: "membership-1" });
});

it("declineInvitationAction forwards the wrapped success data unchanged", async () => {
  mockDeclineInvitation.mockResolvedValue({ ok: true, data: { data: { success: true } } });

  const result = await declineInvitationAction("membership-1");

  expect(result).toEqual({ data: { success: true } });
});

it("declineInvitationAction redacts a thrown Postgres-shaped error surfaced via the INTERNAL code", async () => {
  mockDeclineInvitation.mockResolvedValue({
    ok: false,
    error: {
      code: ActionErrorCodes.INTERNAL,
      message: 'update or delete on table "membership" violates foreign key constraint',
    },
  });

  const result = await declineInvitationAction("membership-1");

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

it.each(["Invitation not found", "This invitation has already been accepted"])(
  "declineInvitationAction forwards the deliberate domain outcome %j unchanged",
  async (domainError) => {
    mockDeclineInvitation.mockResolvedValue({ ok: true, data: { error: domainError } });

    const result = await declineInvitationAction("membership-1");

    expect(result).toEqual({ error: domainError });
  },
);

it("declineInvitationAction redacts an unrecognized error string returned inside the envelope's success data", async () => {
  mockDeclineInvitation.mockResolvedValue({
    ok: true,
    data: { error: 'column "tenant_id" does not exist' },
  });

  const result = await declineInvitationAction("membership-1");

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

it("checkTermsForInvitationAction maps UNAUTHENTICATED to 'Not authenticated'", async () => {
  mockCheckTermsForInvitation.mockResolvedValue({
    ok: false,
    error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
  });

  const result = await checkTermsForInvitationAction();

  expect(result).toEqual({ error: "Not authenticated" });
});

it("getInvitationDetailsAction maps UNAUTHENTICATED to 'Not authenticated'", async () => {
  mockGetInvitationDetails.mockResolvedValue({
    ok: false,
    error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
  });

  const result = await getInvitationDetailsAction("membership-1");

  expect(result).toEqual({ error: "Not authenticated" });
  expect(mockGetInvitationDetails).toHaveBeenCalledWith({ membershipId: "membership-1" });
});

// proves the redaction boundary: an INTERNAL code carries err.message from
// whatever threw inside the handler (a raw database or driver message, never
// authored for display), so it must never reach the client verbatim.
it("acceptInvitationAction redacts a thrown Postgres-shaped error surfaced via the INTERNAL code", async () => {
  mockAcceptInvitation.mockResolvedValue({
    ok: false,
    error: {
      code: ActionErrorCodes.INTERNAL,
      message: 'duplicate key value violates unique constraint "membership_pkey"',
    },
  });

  const result = await acceptInvitationAction("membership-1");

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

it("getInvitationDetailsAction redacts a thrown Postgres-shaped error surfaced via the INTERNAL code", async () => {
  mockGetInvitationDetails.mockResolvedValue({
    ok: false,
    error: {
      code: ActionErrorCodes.INTERNAL,
      message: 'null value in column "tenant_id" violates not-null constraint',
    },
  });

  const result = await getInvitationDetailsAction("membership-1");

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

it("acceptInvitationAction redacts an unrecognized error string returned inside the envelope's success data", async () => {
  mockAcceptInvitation.mockResolvedValue({
    ok: true,
    data: { error: 'update or delete on table "membership" violates foreign key constraint' },
  });

  const result = await acceptInvitationAction("membership-1");

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

it("getInvitationDetailsAction redacts an unrecognized error string returned inside the envelope's success data", async () => {
  mockGetInvitationDetails.mockResolvedValue({
    ok: true,
    data: { error: 'column "tenant_id" does not exist' },
  });

  const result = await getInvitationDetailsAction("membership-1");

  expect(result).toEqual({ error: "Something went wrong. Please try again." });
});

it.each([
  "expired",
  "You have reached the maximum of 10 organizations. Leave an organization to accept this invitation.",
  "Invitation not found",
  "You are already a member of this organization",
])("acceptInvitationAction forwards the deliberate domain outcome %j unchanged", async (domainError) => {
  mockAcceptInvitation.mockResolvedValue({ ok: true, data: { error: domainError } });

  const result = await acceptInvitationAction("membership-1");

  expect(result).toEqual({ error: domainError });
});

it.each(["already_accepted", "Invitation not found"])(
  "getInvitationDetailsAction forwards the deliberate domain outcome %j unchanged",
  async (domainError) => {
    mockGetInvitationDetails.mockResolvedValue({ ok: true, data: { error: domainError } });

    const result = await getInvitationDetailsAction("membership-1");

    expect(result).toEqual({ error: domainError });
  },
);
