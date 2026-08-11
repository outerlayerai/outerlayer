/**
 * Tests for `features/oauth-grants/actions.ts` — the single `revokeOAuthGrantAction`
 * pre-tenant action. `user-scoped`: a connector grant belongs to the signed-in
 * user, not any one tenant.
 *
 * Seams: `preTenantAction` resolves the outer actor via `loadPreTenantActor`
 * (mocked so the wrapper's own auth gate always passes); the handler itself
 * separately resolves `loadPreTenantDb`, the no-tenant client the revoke RPC
 * runs through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockLoadPreTenantActor = vi.hoisted(() => vi.fn());
const mockLoadPreTenantDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantActor: mockLoadPreTenantActor,
  loadPreTenantDb: mockLoadPreTenantDb,
}));

const mockRevoke = vi.hoisted(() => vi.fn());
vi.mock("./service", () => ({
  oauthGrantsService: { revoke: mockRevoke },
}));

const mockRevalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

const preTenantActionSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/action-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/action-kit")>();
  preTenantActionSpy.mockImplementation(actual.preTenantAction);
  return { ...actual, preTenantAction: preTenantActionSpy };
});

import { ActionErrorCodes } from "@/lib/action-kit";
import * as actionsModule from "./actions";
const { revokeOAuthGrantAction } = actionsModule;

const declaredReasons = preTenantActionSpy.mock.calls.map((call) => call[0].reason);

const ACTOR = { userId: "user-1", email: "user@example.com", raw: { id: "user-1" } };
const FAKE_DB = { marker: "db" };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPreTenantActor.mockResolvedValue(ACTOR);
});

describe("module boundary", () => {
  it("declares a user-scoped preTenantAction reason", () => {
    expect(declaredReasons).toEqual(["user-scoped"]);
  });

  it("does not import authorizedAction — this action is tenant-less by design", () => {
    const source = readFileSync(join(__dirname, "actions.ts"), "utf8");
    const actionKitImport = source.match(/^import \{([^}]*)\} from "@\/lib\/action-kit";$/m);
    expect(actionKitImport).not.toBeNull();
    expect(actionKitImport![1]).not.toContain("authorizedAction");
  });
});

describe("revokeOAuthGrantAction", () => {
  it("fails unauthenticated and never calls revoke when the outer actor cannot be resolved", async () => {
    mockLoadPreTenantActor.mockResolvedValue(null);

    const result = await revokeOAuthGrantAction({ sessionId: "session-1" });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: "Not authenticated" },
    });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("fails with the internal error 'Not authenticated' when the handler's own db lookup returns null, even though the outer actor resolved", async () => {
    mockLoadPreTenantDb.mockResolvedValue(null);

    const result = await revokeOAuthGrantAction({ sessionId: "session-1" });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.INTERNAL, message: "Not authenticated" },
    });
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("revokes with the resolved db and the given sessionId, then revalidates the settings layout", async () => {
    mockLoadPreTenantDb.mockResolvedValue(FAKE_DB);
    mockRevoke.mockResolvedValue(true);

    const result = await revokeOAuthGrantAction({ sessionId: "session-1" });

    expect(mockRevoke).toHaveBeenCalledWith(FAKE_DB, "session-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(result).toEqual({ ok: true, data: { revoked: true } });
  });

  it("reports revoked:false unchanged when the grant wasn't the caller's own — but still revalidates", async () => {
    mockLoadPreTenantDb.mockResolvedValue(FAKE_DB);
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
