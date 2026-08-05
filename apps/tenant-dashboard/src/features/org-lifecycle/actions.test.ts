/**
 * Tests for `features/org-lifecycle/actions.ts` at the `preTenantAction`
 * layer itself: that every export declares the reason it has no tenant to
 * scope to, and that the handler receives the actor's raw Supabase `User`
 * (the legacy `OrganizationService` signatures still take it whole) rather
 * than only `userId`/`email`.
 *
 * Business-logic coverage (service success/failure branches, revalidation,
 * the auth-failure string) lives in `action-adapters.test.ts`, which drives
 * these same exports end to end through the flat adapter functions.
 */

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
  getActiveTempAccessGrant: vi.fn().mockResolvedValue(null),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

import * as actionsModule from "./actions";
const { setLastActiveOrg, getMembershipCount, createOrganization, getTempAccessStatus } =
  actionsModule;

// Captured once, right after import: every export calls `preTenantAction`
// exactly once at module init, and `beforeEach`'s `vi.clearAllMocks()` would
// otherwise wipe that one-time call history before a test ever reads it.
const declaredReasons = preTenantActionSpy.mock.calls.map((call) => call[0].reason);

const RAW_USER = { id: "user-1", email: "user@example.com", user_metadata: {} };
const ACTOR = { userId: "user-1", email: "user@example.com", raw: RAW_USER };

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
      "cross-tenant", // setLastActiveOrg
      "user-scoped", // getMembershipCount
      "no-tenant-yet", // createOrganization
      "cross-tenant", // getTempAccessStatus
    ]);
  });
});

describe("actor plumbing", () => {
  it("setLastActiveOrg passes the actor's raw Supabase user to the service, not only userId/email", async () => {
    mockSwitchActiveOrg.mockResolvedValue({ success: true, tenantId: "tenant-2" });

    const result = await setLastActiveOrg({ tenantId: "tenant-2" });

    expect(mockSwitchActiveOrg).toHaveBeenCalledWith({ user: RAW_USER, tenantId: "tenant-2" });
    expect(result).toEqual({ ok: true, data: { data: { tenantId: "tenant-2" } } });
  });

  it("getMembershipCount passes the actor's raw Supabase user to the service", async () => {
    mockCountActiveMemberships.mockResolvedValue({ success: true, count: 3 });

    const result = await getMembershipCount(undefined);

    expect(mockCountActiveMemberships).toHaveBeenCalledWith(RAW_USER);
    expect(result).toEqual({ ok: true, data: { data: 3 } });
  });
});

describe("unauthenticated caller", () => {
  it("every export fails with the wrapper's unauthenticated code when no actor resolves", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const results = await Promise.all([
      setLastActiveOrg({ tenantId: "tenant-2" }),
      getMembershipCount(undefined),
      createOrganization({ organizationName: "Acme", companyName: "Acme Inc" }),
      getTempAccessStatus({ tenantId: "tenant-2" }),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unauthenticated");
      }
    }
  });
});
