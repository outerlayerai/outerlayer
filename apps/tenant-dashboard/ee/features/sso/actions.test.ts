/**
 * Action-layer tests: input validation, permission gating, and the exact
 * call-through shape. The action-kit seams are mocked; the real
 * `authorizedAction` wrapper runs. Service-level behavior (entitlement gate,
 * lazy-deactivate branch) is covered in service.test.ts.
 */

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

const mockGetSSOConfig = vi.hoisted(() => vi.fn());
const mockSaveSSOConfig = vi.hoisted(() => vi.fn());
const mockToggleSSOActive = vi.hoisted(() => vi.fn());
const mockToggleSSOEnforcement = vi.hoisted(() => vi.fn());
const mockTestSSOConnection = vi.hoisted(() => vi.fn());
const mockDeleteSSOConfig = vi.hoisted(() => vi.fn());
const mockGetSSOMembers = vi.hoisted(() => vi.fn());
vi.mock("./service", () => ({
  getSSOConfig: mockGetSSOConfig,
  saveSSOConfig: mockSaveSSOConfig,
  toggleSSOActive: mockToggleSSOActive,
  toggleSSOEnforcement: mockToggleSSOEnforcement,
  testSSOConnection: mockTestSSOConnection,
  deleteSSOConfig: mockDeleteSSOConfig,
  getSSOMembers: mockGetSSOMembers,
}));

import { Permissions } from "@/utils/permissions";
import {
  getSSOConfigAction,
  saveSSOConfigAction,
  toggleSSOActiveAction,
  toggleSSOEnforcementAction,
  testSSOConnectionAction,
  deleteSSOConfigAction,
  getSSOMembersAction,
} from "./actions";

const fakeDb = { from: () => ({}) };
const actor = { userId: "user-1", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue({ db: fakeDb, tenantId: "tenant-req", actor });
  mockCheckPerm.mockResolvedValue(true);
});

describe("SSO read actions require sso_config.read", () => {
  it("getSSOConfigAction denies and never reaches the service when the caller lacks sso_config.read", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await getSSOConfigAction({});

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: sso_config.read" },
    });
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_READ, undefined);
    expect(mockGetSSOConfig).not.toHaveBeenCalled();
  });

  it("getSSOConfigAction calls the service with the request tenant on the happy path", async () => {
    mockGetSSOConfig.mockResolvedValue({ config: null, isEnterprise: true });

    const result = await getSSOConfigAction({});

    expect(result).toEqual({ ok: true, data: { config: null, isEnterprise: true } });
    expect(mockGetSSOConfig).toHaveBeenCalledWith(fakeDb, "tenant-req");
  });

  it("testSSOConnectionAction denies without sso_config.read", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await testSSOConnectionAction({});

    expect(result.ok).toBe(false);
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_READ, undefined);
    expect(mockTestSSOConnection).not.toHaveBeenCalled();
  });

  it("testSSOConnectionAction calls the service with the request tenant on the happy path", async () => {
    mockTestSSOConnection.mockResolvedValue({ diagnostics: undefined });

    const result = await testSSOConnectionAction({});

    expect(result).toEqual({ ok: true, data: { diagnostics: undefined } });
    expect(mockTestSSOConnection).toHaveBeenCalledWith(fakeDb, "tenant-req");
  });

  it("getSSOMembersAction denies without sso_config.read", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await getSSOMembersAction({});

    expect(result.ok).toBe(false);
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_READ, undefined);
    expect(mockGetSSOMembers).not.toHaveBeenCalled();
  });

  it("getSSOMembersAction calls the service with the request tenant on the happy path", async () => {
    mockGetSSOMembers.mockResolvedValue({ members: [] });

    const result = await getSSOMembersAction({});

    expect(result).toEqual({ ok: true, data: { members: [] } });
    expect(mockGetSSOMembers).toHaveBeenCalledWith(fakeDb, "tenant-req");
  });
});

describe("SSO write actions require sso_config.update and never write when denied", () => {
  const saveInput = { metadataUrl: "https://idp.example.com/saml/metadata", allowedDomains: ["example.com"] };

  it("saveSSOConfigAction", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await saveSSOConfigAction(saveInput);

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: sso_config.update" },
    });
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_UPDATE, undefined);
    expect(mockSaveSSOConfig).not.toHaveBeenCalled();
  });

  it("saveSSOConfigAction rejects invalid input before touching the service or the permission seam", async () => {
    const result = await saveSSOConfigAction({ metadataUrl: "", allowedDomains: [] });

    expect(result.ok).toBe(false);
    expect(mockSaveSSOConfig).not.toHaveBeenCalled();
  });

  it("saveSSOConfigAction calls the service with the parsed input on the happy path", async () => {
    mockSaveSSOConfig.mockResolvedValue({ config: undefined });

    const result = await saveSSOConfigAction(saveInput);

    expect(result).toEqual({ ok: true, data: { config: undefined } });
    expect(mockSaveSSOConfig).toHaveBeenCalledWith(fakeDb, "tenant-req", saveInput);
  });

  it("toggleSSOActiveAction", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await toggleSSOActiveAction({ active: true });

    expect(result.ok).toBe(false);
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_UPDATE, undefined);
    expect(mockToggleSSOActive).not.toHaveBeenCalled();
  });

  it("toggleSSOActiveAction passes the boolean through on the happy path", async () => {
    mockToggleSSOActive.mockResolvedValue({ success: true });

    const result = await toggleSSOActiveAction({ active: false });

    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(mockToggleSSOActive).toHaveBeenCalledWith(fakeDb, "tenant-req", false);
  });

  it("toggleSSOEnforcementAction", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await toggleSSOEnforcementAction({ enforced: true });

    expect(result.ok).toBe(false);
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_UPDATE, undefined);
    expect(mockToggleSSOEnforcement).not.toHaveBeenCalled();
  });

  it("toggleSSOEnforcementAction passes the caller's boolean through on the happy path", async () => {
    mockToggleSSOEnforcement.mockResolvedValue({ success: true });

    const result = await toggleSSOEnforcementAction({ enforced: false });

    expect(result).toEqual({ ok: true, data: { success: true } });
    // A handler that hardcoded `true` instead of forwarding `input.enforced`
    // would still pass every other assertion here — this call-arg pin is
    // what catches it.
    expect(mockToggleSSOEnforcement).toHaveBeenCalledWith(fakeDb, "tenant-req", false);
  });
});

describe("deleteSSOConfigAction requires the owner-only sso_config.delete", () => {
  it("denies and never deletes when the caller lacks sso_config.delete", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await deleteSSOConfigAction({});

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: sso_config.delete" },
    });
    expect(mockCheckPerm).toHaveBeenCalledWith(actor, Permissions.SSO_CONFIG_DELETE, undefined);
    expect(mockDeleteSSOConfig).not.toHaveBeenCalled();
  });

  it("deletes on the happy path", async () => {
    mockDeleteSSOConfig.mockResolvedValue({ success: true });

    const result = await deleteSSOConfigAction({});

    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(mockDeleteSSOConfig).toHaveBeenCalledWith(fakeDb, "tenant-req");
  });
});

describe("request-context resolution failure — the wrapper's error envelope, no permission check, no service call", () => {
  it.each([
    ["Not authenticated" as const],
    ["No tenant for request" as const],
  ])("getSSOConfigAction surfaces %s without checking permission or calling the service", async (message) => {
    mockLoadCtx.mockRejectedValue(new Error(message));

    const result = await getSSOConfigAction({});

    expect(result).toEqual({
      ok: false,
      error: { code: "internal_error", message },
    });
    expect(mockCheckPerm).not.toHaveBeenCalled();
    expect(mockGetSSOConfig).not.toHaveBeenCalled();
  });

  it("saveSSOConfigAction surfaces the same envelope on an unauthenticated caller", async () => {
    mockLoadCtx.mockRejectedValue(new Error("Not authenticated"));

    const result = await saveSSOConfigAction({
      metadataUrl: "https://idp.example.com/saml/metadata",
      allowedDomains: [],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "internal_error", message: "Not authenticated" },
    });
    expect(mockSaveSSOConfig).not.toHaveBeenCalled();
  });
});
