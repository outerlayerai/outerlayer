/**
 * Service-layer tests: the Team-plan entitlement gate, the admin-client-owning
 * factory (the `check-data-access-boundary` gate confines that construction
 * to the service layer) and the lazy-deactivate branch (an active config on a
 * downgraded tenant auto-deactivates on read). Permission gating lives in
 * actions.test.ts.
 */

const mockGetAdminDataClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/admin-client", () => ({
  getAdminDataClient: mockGetAdminDataClient,
}));

const mockSSOConfigServiceCtor = vi.hoisted(() => vi.fn());
vi.mock("./sso-config-service", () => ({
  SSOConfigService: mockSSOConfigServiceCtor,
}));

const mockCanAccess = vi.hoisted(() => vi.fn());
const mockEntitlementServiceCtor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/entitlement-service", () => ({
  EntitlementService: mockEntitlementServiceCtor,
}));

import {
  getSSOConfig,
  saveSSOConfig,
  toggleSSOActive,
  toggleSSOEnforcement,
  testSSOConnection,
  deleteSSOConfig,
  getSSOMembers,
} from "./service";
import type { SSOConfig } from "@/types/sso";

const fakeAdminDb = { from: () => ({}), __admin: true } as never;

const fakeDb = {} as never;

function makeSSOConfig(overrides: Partial<SSOConfig> = {}): SSOConfig {
  return {
    id: "sso-config-001",
    tenant_id: "tenant-001",
    supabase_provider_id: "provider-abc",
    metadata_url: "https://idp.example.com/saml/metadata",
    entity_id: "https://idp.example.com",
    allowed_domains: ["example.com"],
    enforcement_enabled: false,
    is_active: true,
    last_validated_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    created_by: "user-001",
    updated_at: "2026-01-01T00:00:00Z",
    updated_by: "user-001",
    ...overrides,
  };
}

function setupSSOConfigService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const mockSSOService = {
    getConfig: vi.fn().mockResolvedValue(null),
    saveConfig: vi.fn().mockResolvedValue(makeSSOConfig()),
    toggleActive: vi.fn().mockResolvedValue(undefined),
    toggleEnforcement: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({}),
    deleteConfig: vi.fn().mockResolvedValue(undefined),
    getSSOMembers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  mockSSOConfigServiceCtor.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockSSOService);
  });
  return mockSSOService;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminDataClient.mockReturnValue(fakeAdminDb);
  mockEntitlementServiceCtor.mockImplementation(function (this: Record<string, unknown>) {
    this.canAccess = mockCanAccess;
  });
});

describe("admin-client wiring — the data-access-boundary gate's whole reason for confining this factory here", () => {
  it("constructs SSOConfigService with the caller's db and the resolved admin client, not the caller's db twice", async () => {
    setupSSOConfigService();
    mockCanAccess.mockResolvedValue(true);

    await getSSOConfig(fakeDb, "tenant-001");

    expect(mockSSOConfigServiceCtor).toHaveBeenCalledWith({ db: fakeDb, adminDb: fakeAdminDb });
  });

  it("resolves the custom_sso entitlement for the given tenant", async () => {
    setupSSOConfigService();
    mockCanAccess.mockResolvedValue(true);

    await getSSOConfig(fakeDb, "tenant-001");

    expect(mockCanAccess).toHaveBeenCalledWith("tenant-001", "custom_sso");
  });
});

describe("getSSOConfig — lazy-deactivate branch", () => {
  it("does not deactivate an already-inactive config on a non-enterprise tenant", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService({
      getConfig: vi.fn().mockResolvedValue(makeSSOConfig({ is_active: false })),
    });

    const result = await getSSOConfig(fakeDb, "tenant-001");

    expect(svc.toggleActive).not.toHaveBeenCalled();
    expect(result.config?.is_active).toBe(false);
    expect(result.isEnterprise).toBe(false);
  });

  // proves AC-072-04
  it("auto-deactivates an active config and clears enforcement when the tenant is downgraded", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService({
      getConfig: vi.fn().mockResolvedValue(makeSSOConfig({ is_active: true, enforcement_enabled: true })),
    });

    const result = await getSSOConfig(fakeDb, "tenant-001");

    expect(svc.toggleActive).toHaveBeenCalledWith("tenant-001", false);
    expect(result.config?.is_active).toBe(false);
    expect(result.config?.enforcement_enabled).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("leaves an active config untouched when the tenant is still enterprise", async () => {
    mockCanAccess.mockResolvedValue(true);
    const svc = setupSSOConfigService({
      getConfig: vi.fn().mockResolvedValue(makeSSOConfig({ is_active: true })),
    });

    const result = await getSSOConfig(fakeDb, "tenant-001");

    expect(svc.toggleActive).not.toHaveBeenCalled();
    expect(result.config?.is_active).toBe(true);
    expect(result.isEnterprise).toBe(true);
  });

  it("surfaces an error and preserves the stale config when deactivation itself fails", async () => {
    mockCanAccess.mockResolvedValue(false);
    setupSSOConfigService({
      getConfig: vi.fn().mockResolvedValue(makeSSOConfig({ is_active: true })),
      toggleActive: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getSSOConfig(fakeDb, "tenant-001");

    expect(result.error).toBe(
      "SSO could not be automatically deactivated after plan change. Please contact support.",
    );
    consoleErrorSpy.mockRestore();
  });

  it("catches an unexpected read failure and reports it without throwing", async () => {
    mockCanAccess.mockResolvedValue(true);
    setupSSOConfigService({ getConfig: vi.fn().mockRejectedValue(new Error("DB timeout")) });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getSSOConfig(fakeDb, "tenant-001");

    expect(result).toEqual({ config: null, isEnterprise: false, error: "DB timeout" });
    consoleErrorSpy.mockRestore();
  });
});

describe("entitlement gate on writes — blocks the privileged call on a non-enterprise plan", () => {
  const saveInput = { metadataUrl: "https://idp.example.com/saml/metadata", allowedDomains: ["example.com"] };
  const DENIED = "SSO is available on the Team plan or above";

  // proves AC-072-02
  it("saveSSOConfig", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService();

    const result = await saveSSOConfig(fakeDb, "tenant-001", saveInput);

    expect(result).toEqual({ error: DENIED });
    expect(svc.saveConfig).not.toHaveBeenCalled();
  });

  it("toggleSSOActive", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService();

    const result = await toggleSSOActive(fakeDb, "tenant-001", true);

    expect(result).toEqual({ success: false, error: DENIED });
    expect(svc.toggleActive).not.toHaveBeenCalled();
  });

  it("toggleSSOEnforcement", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService();

    const result = await toggleSSOEnforcement(fakeDb, "tenant-001", true);

    expect(result).toEqual({ success: false, error: DENIED });
    expect(svc.toggleEnforcement).not.toHaveBeenCalled();
  });

  it("testSSOConnection", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService();

    const result = await testSSOConnection(fakeDb, "tenant-001");

    expect(result).toEqual({ error: DENIED });
    expect(svc.testConnection).not.toHaveBeenCalled();
  });

  it("deleteSSOConfig", async () => {
    mockCanAccess.mockResolvedValue(false);
    const svc = setupSSOConfigService();

    const result = await deleteSSOConfig(fakeDb, "tenant-001");

    expect(result).toEqual({ success: false, error: DENIED });
    expect(svc.deleteConfig).not.toHaveBeenCalled();
  });
});

describe("write/read call-through on the happy path", () => {
  it("saveSSOConfig passes tenant + input and returns the saved config", async () => {
    mockCanAccess.mockResolvedValue(true);
    const config = makeSSOConfig();
    const svc = setupSSOConfigService({ saveConfig: vi.fn().mockResolvedValue(config) });
    const input = { metadataUrl: "https://idp.example.com/saml/metadata", allowedDomains: ["example.com"] };

    const result = await saveSSOConfig(fakeDb, "tenant-001", input);

    expect(result).toEqual({ config });
    expect(svc.saveConfig).toHaveBeenCalledWith("tenant-001", input);
  });

  it("getSSOMembers is not entitlement-gated (read-only, no plan-locked mutation)", async () => {
    const svc = setupSSOConfigService({ getSSOMembers: vi.fn().mockResolvedValue([]) });

    const result = await getSSOMembers(fakeDb, "tenant-001");

    expect(result).toEqual({ members: [] });
    expect(svc.getSSOMembers).toHaveBeenCalledWith("tenant-001");
    expect(mockEntitlementServiceCtor).not.toHaveBeenCalled();
  });
});

describe("underlying service failures are caught and returned as data, never left to escape as a throw", () => {
  const saveInput = { metadataUrl: "https://idp.example.com/saml/metadata", allowedDomains: ["example.com"] };

  const CASES: Array<{
    name: string;
    serviceMethod: string;
    invoke: () => ReturnType<typeof saveSSOConfig | typeof toggleSSOActive>;
    expected: { error?: string; success?: boolean; members?: unknown[] };
  }> = [
    {
      name: "saveSSOConfig",
      serviceMethod: "saveConfig",
      invoke: () => saveSSOConfig(fakeDb, "tenant-001", saveInput),
      expected: { error: "boom" },
    },
    {
      name: "toggleSSOActive",
      serviceMethod: "toggleActive",
      invoke: () => toggleSSOActive(fakeDb, "tenant-001", true),
      expected: { success: false, error: "boom" },
    },
    {
      name: "toggleSSOEnforcement",
      serviceMethod: "toggleEnforcement",
      invoke: () => toggleSSOEnforcement(fakeDb, "tenant-001", true),
      expected: { success: false, error: "boom" },
    },
    {
      name: "testSSOConnection",
      serviceMethod: "testConnection",
      invoke: () => testSSOConnection(fakeDb, "tenant-001"),
      expected: { error: "boom" },
    },
    {
      name: "deleteSSOConfig",
      serviceMethod: "deleteConfig",
      invoke: () => deleteSSOConfig(fakeDb, "tenant-001"),
      expected: { success: false, error: "boom" },
    },
    {
      name: "getSSOMembers",
      serviceMethod: "getSSOMembers",
      invoke: () => getSSOMembers(fakeDb, "tenant-001"),
      expected: { members: [], error: "boom" },
    },
  ];

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s returns the error as data instead of throwing when the underlying service call rejects",
    async (_name, testCase) => {
      mockCanAccess.mockResolvedValue(true);
      setupSSOConfigService({ [testCase.serviceMethod]: vi.fn().mockRejectedValue(new Error("boom")) });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await testCase.invoke();

      expect(result).toEqual(testCase.expected);
      consoleErrorSpy.mockRestore();
    },
  );
});
