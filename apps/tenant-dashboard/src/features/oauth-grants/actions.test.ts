/**
 * Tests for `features/oauth-grants/actions.ts` — the single `revokeOAuthGrantAction`
 * pre-tenant action. `user-scoped`: a connector grant belongs to the signed-in
 * user, not any one tenant.
 *
 * Seam: `preTenantAction` resolves the actor via `loadPreTenantActor`
 * (mocked so the wrapper's own auth gate always passes); the handler calls
 * `oauthGrantsService.revoke` with that actor's `userId` — the RPC behind
 * it now takes the target user id as a parameter rather than reading
 * `auth.uid()` internally, so the id MUST come from the resolved session
 * actor, never from the action's own input.
 */
const mockLoadPreTenantActor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantActor: mockLoadPreTenantActor,
}));

const mockRevoke = vi.hoisted(() => vi.fn());
vi.mock("./service", () => ({
  oauthGrantsService: { revoke: mockRevoke },
}));

const mockRevalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

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
const { revokeOAuthGrantAction } = actionsModule;

const declaredReasons = preTenantActionSpy.mock.calls.map((call) => call[0].reason);
// Captured before beforeEach's clearAllMocks wipes load-time calls.
const authorizedActionLoadCalls = authorizedActionSpy.mock.calls.length;

const ACTOR = { userId: "user-1", email: "user@example.com", raw: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPreTenantActor.mockResolvedValue(ACTOR);
});

describe("module boundary", () => {
  it("declares a user-scoped preTenantAction reason", () => {
    expect(declaredReasons).toEqual(["user-scoped"]);
  });

  it("builds no export with authorizedAction — this action is tenant-less by design", () => {
    // The wrapper spies record every action built at module load; a
    // tenant-scoped wrapper appearing here means the action gained an org
    // dependency it must not have. The reasons assertion above already pins
    // that preTenantAction built every export.
    expect(authorizedActionLoadCalls).toBe(0);
  });
});

describe("revokeOAuthGrantAction", () => {
  it("fails unauthenticated and never calls revoke when the actor cannot be resolved", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await revokeOAuthGrantAction({ sessionId: "session-1" });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("revokes with the resolved actor's userId and the given sessionId, then revalidates the settings layout", async () => {
    mockRevoke.mockResolvedValue(true);

    const result = await revokeOAuthGrantAction({ sessionId: "session-1" });

    expect(mockRevoke).toHaveBeenCalledWith("user-1", "session-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(result).toEqual({ ok: true, data: { revoked: true } });
  });

  it("ignores a userId on the action's own input — the id always comes from the resolved session actor", async () => {
    mockRevoke.mockResolvedValue(true);

    await revokeOAuthGrantAction({ sessionId: "session-1", userId: "attacker-supplied-id" } as never);

    expect(mockRevoke).toHaveBeenCalledWith("user-1", "session-1");
  });

  it("reports revoked:false unchanged when the grant wasn't the caller's own — but still revalidates", async () => {
    mockRevoke.mockResolvedValue(false);

    const result = await revokeOAuthGrantAction({ sessionId: "session-1" });

    expect(result).toEqual({ ok: true, data: { revoked: false } });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("rejects an empty sessionId before resolving any actor", async () => {
    const result = await revokeOAuthGrantAction({ sessionId: "" });

    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe(ActionErrorCodes.VALIDATION);
    expect(mockLoadPreTenantActor).not.toHaveBeenCalled();
  });
});
