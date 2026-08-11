/**
 * Tests for `features/oauth-consent/actions.ts` — the single `decideOAuthConsentAction`
 * pre-tenant action. `cross-tenant`: the action authorizes a connector client as the
 * user, not as any one tenant's member.
 *
 * Seams: `preTenantAction` resolves the outer actor via `loadPreTenantActor`
 * (mocked so the wrapper's own auth gate always passes); the handler itself
 * separately resolves `loadPreTenantActorSession` for the raw access token
 * `oauthConsentService.submitConsent` needs to hit Supabase Auth's OAuth
 * server directly.
 */
const mockLoadPreTenantActor = vi.hoisted(() => vi.fn());
const mockLoadPreTenantActorSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantActor: mockLoadPreTenantActor,
  loadPreTenantActorSession: mockLoadPreTenantActorSession,
}));

const mockSubmitConsent = vi.hoisted(() => vi.fn());
vi.mock("./service", () => ({
  oauthConsentService: { submitConsent: mockSubmitConsent },
}));

const preTenantActionSpy = vi.hoisted(() => vi.fn());
const authorizedActionSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/action-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/action-kit")>();
  preTenantActionSpy.mockImplementation(actual.preTenantAction);
  authorizedActionSpy.mockImplementation(actual.authorizedAction);
  return { ...actual, preTenantAction: preTenantActionSpy, authorizedAction: authorizedActionSpy };
});

import { ActionErrorCodes } from "@/lib/action-kit";
import * as actionsModule from "./actions";
const { decideOAuthConsentAction } = actionsModule;

const declaredReasons = preTenantActionSpy.mock.calls.map((call) => call[0].reason);
// Captured before beforeEach's clearAllMocks wipes load-time calls.
const authorizedActionLoadCalls = authorizedActionSpy.mock.calls.length;

const ACTOR = { userId: "user-1", email: "user@example.com", raw: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPreTenantActor.mockResolvedValue(ACTOR);
});

describe("module boundary", () => {
  it("declares a cross-tenant preTenantAction reason", () => {
    expect(declaredReasons).toEqual(["cross-tenant"]);
  });

  it("builds no export with authorizedAction — this action is tenant-less by design", () => {
    // The wrapper spies record every action built at module load; a
    // tenant-scoped wrapper appearing here means the action gained an org
    // dependency it must not have. The reasons assertion above already pins
    // that preTenantAction built every export.
    expect(authorizedActionLoadCalls).toBe(0);
  });
});

describe("decideOAuthConsentAction", () => {
  it("fails unauthenticated and never calls submitConsent when the outer actor cannot be resolved", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await decideOAuthConsentAction({ authorizationId: "auth-1", decision: "approve" });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockSubmitConsent).not.toHaveBeenCalled();
  });

  it("fails with the internal error 'Not authenticated' when the handler's own session lookup returns null, even though the outer actor resolved", async () => {
    mockLoadPreTenantActorSession.mockResolvedValue(null);

    const result = await decideOAuthConsentAction({ authorizationId: "auth-1", decision: "approve" });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.INTERNAL, message: "Not authenticated" },
    });
    expect(mockSubmitConsent).not.toHaveBeenCalled();
  });

  it("submits the decision with the session's own access token and the parsed input", async () => {
    mockLoadPreTenantActorSession.mockResolvedValue({ actor: ACTOR, accessToken: "token-abc" });
    mockSubmitConsent.mockResolvedValue({ redirectUrl: "https://connector.example.com/callback" });

    const result = await decideOAuthConsentAction({ authorizationId: "auth-1", decision: "deny" });

    expect(mockSubmitConsent).toHaveBeenCalledWith(
      expect.any(String),
      "token-abc",
      "auth-1",
      "deny",
    );
    expect(result).toEqual({
      ok: true,
      data: { redirectUrl: "https://connector.example.com/callback" },
    });
  });

  it("rejects an invalid decision value before resolving any actor", async () => {
    const result = await decideOAuthConsentAction({ authorizationId: "auth-1", decision: "maybe" });

    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe(ActionErrorCodes.VALIDATION);
    expect(mockLoadPreTenantActor).not.toHaveBeenCalled();
  });
});
