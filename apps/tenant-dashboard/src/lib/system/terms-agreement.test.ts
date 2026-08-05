/**
 * Unit Tests for TermsAgreementService
 *
 * These tests verify service logic with mocked Supabase client.
 */

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const mockGetAdminDataClient = vi.hoisted(() => vi.fn());
vi.mock("./admin-client", () => ({
  getAdminDataClient: mockGetAdminDataClient,
}));

// Mock the serverLogger so its `await` calls don't trip on a missing
// implementation. We only assert on the operation-identifying message a
// thrown error carries, not on what the logger was called with.
vi.mock("@/lib/adapters", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/adapters")>()),
  serverLogger: {
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

import { headers } from "next/headers";
import { TermsAgreementService, recordTermsAgreementForUser } from "./terms-agreement";

// Mock Supabase client factory
function createMockSupabaseClient(overrides: {
  selectData?: any;
  selectError?: any;
  insertData?: any;
  insertError?: any;
  fromOverrides?: Record<string, any>;
} = {}) {
  const mockSelect = vi.fn().mockReturnThis();
  const mockInsert = vi.fn().mockReturnThis();
  const mockEq = vi.fn().mockReturnThis();
  const mockLimit = vi.fn().mockReturnThis();
  const mockOrder = vi.fn().mockReturnThis();
  const mockSingle = vi.fn().mockResolvedValue({
    data: overrides.selectData ?? null,
    error: overrides.selectError ?? null,
  });
  const mockMaybeSingle = vi.fn().mockResolvedValue({
    data: overrides.selectData ?? null,
    error: overrides.selectError ?? null,
  });
  const mockNot = vi.fn().mockReturnThis();

  // Chain builder
  const chainBuilder = {
    select: mockSelect,
    insert: mockInsert,
    eq: mockEq,
    limit: mockLimit,
    order: mockOrder,
    single: mockSingle,
    maybeSingle: mockMaybeSingle,
    not: mockNot,
  };

  // Make all methods return the chain builder for chaining
  mockSelect.mockImplementation(() => {
    if (overrides.insertData) {
      return {
        ...chainBuilder,
        single: vi.fn().mockResolvedValue({
          data: overrides.insertData,
          error: overrides.insertError ?? null,
        }),
      };
    }
    return chainBuilder;
  });
  mockInsert.mockReturnValue(chainBuilder);
  mockEq.mockReturnValue(chainBuilder);
  mockLimit.mockReturnValue(chainBuilder);
  mockOrder.mockReturnValue(chainBuilder);
  mockNot.mockReturnValue(chainBuilder);

  const mockFrom = vi.fn().mockReturnValue(chainBuilder);

  return {
    from: mockFrom,
    _mocks: {
      from: mockFrom,
      select: mockSelect,
      insert: mockInsert,
      eq: mockEq,
      limit: mockLimit,
      order: mockOrder,
      single: mockSingle,
      maybeSingle: mockMaybeSingle,
    },
  } as any;
}

describe("TermsAgreementService", () => {
  describe("recordAgreement", () => {
    it("should create agreement record with all provided fields", async () => {
      const mockRecord = {
        id: "agreement-123",
        user_id: "user-456",
        terms_version: "2026-01-10",
        agreed_at: "2026-01-18T10:00:00Z",
        ip_address: "192.168.1.1",
        user_agent: "Mozilla/5.0",
        consent_type: "explicit",
        created_at: "2026-01-18T10:00:00Z",
        created_by: "user-456",
      };

      const mockClient = createMockSupabaseClient({ insertData: mockRecord });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.recordAgreement({
        userId: "user-456",
        termsVersion: "2026-01-10",
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      });

      expect(result.id).toBe("agreement-123");
      expect(result.userId).toBe("user-456");
      expect(result.termsVersion).toBe("2026-01-10");
      expect(result.ipAddress).toBe("192.168.1.1");
      expect(result.userAgent).toBe("Mozilla/5.0");
      expect(result.consentType).toBe("explicit");
    });

    it("should default consentType to 'explicit' when not provided", async () => {
      const mockClient = createMockSupabaseClient({
        insertData: {
          id: "agreement-123",
          user_id: "user-456",
          terms_version: "2026-01-10",
          agreed_at: "2026-01-18T10:00:00Z",
          consent_type: "explicit",
          created_at: "2026-01-18T10:00:00Z",
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.recordAgreement({
        userId: "user-456",
        termsVersion: "2026-01-10",
      });

      expect(result.consentType).toBe("explicit");
      expect(mockClient._mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ consent_type: "explicit" })
      );
    });

    it("should use provided consentType when specified as 'implicit'", async () => {
      const mockClient = createMockSupabaseClient({
        insertData: {
          id: "agreement-123",
          user_id: "user-456",
          terms_version: "2026-01-10",
          agreed_at: "2026-01-18T10:00:00Z",
          consent_type: "implicit",
          created_at: "2026-01-18T10:00:00Z",
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.recordAgreement({
        userId: "user-456",
        termsVersion: "2026-01-10",
        consentType: "implicit",
      });

      expect(result.consentType).toBe("implicit");
      expect(mockClient._mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ consent_type: "implicit" })
      );
    });

    it("should throw descriptive error when user already agreed to version", async () => {
      // Create a custom mock that returns error from insert chain
      const mockClient = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: null,
                error: { code: "23505", message: "duplicate key value" },
              }),
            }),
          }),
        }),
      } as any;
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      await expect(
        service.recordAgreement({
          userId: "user-456",
          termsVersion: "2026-01-10",
        })
      ).rejects.toThrow("User has already agreed to terms version 2026-01-10");
    });

    it("throws a stable message without the driver's error text on a non-duplicate failure", async () => {
      // Create a custom mock that returns error from insert chain
      const mockClient = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: null,
                error: { code: "PGRST000", message: "Connection refused" },
              }),
            }),
          }),
        }),
      } as any;
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      let thrown: unknown;
      try {
        await service.recordAgreement({ userId: "user-456", termsVersion: "2026-01-10" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Failed to record terms agreement");
    });

    it("should set ip_address to null when not provided", async () => {
      const mockClient = createMockSupabaseClient({
        insertData: {
          id: "agreement-123",
          user_id: "user-456",
          terms_version: "2026-01-10",
          agreed_at: "2026-01-18T10:00:00Z",
          ip_address: null,
          consent_type: "explicit",
          created_at: "2026-01-18T10:00:00Z",
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      await service.recordAgreement({
        userId: "user-456",
        termsVersion: "2026-01-10",
      });

      expect(mockClient._mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ ip_address: null })
      );
    });
  });

  describe("hasAnyAgreement", () => {
    it("should return true when user has any agreement regardless of version", async () => {
      const mockClient = createMockSupabaseClient({
        selectData: { id: "agreement-123" },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.hasAnyAgreement("user-456");

      expect(result).toBe(true);
    });

    it("should return false when user has no agreements", async () => {
      const mockClient = createMockSupabaseClient({ selectData: null });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.hasAnyAgreement("user-456");

      expect(result).toBe(false);
    });

    it("throws a stable message without the driver's error text on a query failure", async () => {
      const mockClient = createMockSupabaseClient({
        selectError: { message: "Connection timeout" },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      let thrown: unknown;
      try {
        await service.hasAnyAgreement("user-456");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Failed to check terms agreement");
    });

    it("should use limit(1) for efficient query", async () => {
      const mockClient = createMockSupabaseClient({ selectData: null });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      await service.hasAnyAgreement("user-456");

      expect(mockClient._mocks.limit).toHaveBeenCalledWith(1);
    });
  });

  describe("checkTermsStatus", () => {
    it("should return needsCurrentVersion=true when user has no agreement", async () => {
      // Mock getLatestAgreement to return null
      const mockClient = createMockSupabaseClient({ selectData: null });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.checkTermsStatus("user-456", "2026-01-10");

      // Assert full expected shape for "no agreement" case
      expect(result).toEqual({
        hasAgreed: false,
        needsCurrentVersion: true,
      });
    });

    it("should return needsCurrentVersion=false when user has any agreement (non-blocking policy)", async () => {
      const mockClient = createMockSupabaseClient({
        selectData: {
          id: "agreement-123",
          user_id: "user-456",
          terms_version: "2020-01-01", // Old version
          agreed_at: "2020-01-01T10:00:00Z",
          consent_type: "explicit",
          created_at: "2020-01-01T10:00:00Z",
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.checkTermsStatus("user-456", "2026-01-10");

      expect(result.hasAgreed).toBe(true);
      expect(result.needsCurrentVersion).toBe(false);
      expect(result.agreedVersion).toBe("2020-01-01");
      expect(result.consentType).toBe("explicit");
    });

    it("should include agreedAt date when agreement exists", async () => {
      const agreedDate = "2025-06-15T14:30:00.000Z";
      const mockClient = createMockSupabaseClient({
        selectData: {
          id: "agreement-123",
          user_id: "user-456",
          terms_version: "2025-06-01",
          agreed_at: agreedDate,
          consent_type: "implicit",
          created_at: agreedDate,
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.checkTermsStatus("user-456", "2026-01-10");

      expect(result.agreedAt).toBeInstanceOf(Date);
      expect(result.agreedAt?.toISOString()).toBe(agreedDate);
    });

    it("should return consentType from latest agreement", async () => {
      const mockClient = createMockSupabaseClient({
        selectData: {
          id: "agreement-123",
          user_id: "user-456",
          terms_version: "2026-01-10",
          agreed_at: "2026-01-18T10:00:00Z",
          consent_type: "implicit",
          created_at: "2026-01-18T10:00:00Z",
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.checkTermsStatus("user-456", "2026-01-10");

      expect(result.consentType).toBe("implicit");
    });
  });

  describe("getLatestAgreement", () => {
    it("should return null when user has no agreements", async () => {
      const mockClient = createMockSupabaseClient({ selectData: null });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.getLatestAgreement("user-456");

      expect(result).toBeNull();
    });

    it("should return the most recent agreement", async () => {
      const mockClient = createMockSupabaseClient({
        selectData: {
          id: "latest-agreement",
          user_id: "user-456",
          terms_version: "2026-01-10",
          agreed_at: "2026-01-18T10:00:00Z",
          ip_address: "10.0.0.1",
          user_agent: "Chrome",
          consent_type: "implicit",
          created_at: "2026-01-18T10:00:00Z",
          created_by: "user-456",
        },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.getLatestAgreement("user-456");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("latest-agreement");
      expect(result?.termsVersion).toBe("2026-01-10");
      expect(result?.consentType).toBe("implicit");
    });

    it("throws a stable message without the driver's error text on a query failure", async () => {
      const mockClient = createMockSupabaseClient({
        selectError: { message: "Timeout" },
      });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      let thrown: unknown;
      try {
        await service.getLatestAgreement("user-456");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Failed to get latest agreement");
    });

    it("should order by agreed_at descending and limit to 1", async () => {
      const mockClient = createMockSupabaseClient({ selectData: null });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      await service.getLatestAgreement("user-456");

      expect(mockClient._mocks.order).toHaveBeenCalledWith("agreed_at", {
        ascending: false,
      });
      expect(mockClient._mocks.limit).toHaveBeenCalledWith(1);
    });
  });


  describe("mapToRecord (via public methods)", () => {
    it("should correctly map database row to TermsAgreementRecord", async () => {
      const dbRow = {
        id: "record-id",
        user_id: "user-id",
        terms_version: "2026-01-10",
        agreed_at: "2026-01-18T10:00:00.000Z",
        ip_address: "127.0.0.1",
        user_agent: "Test Agent",
        consent_type: "explicit",
        created_at: "2026-01-18T10:00:00.000Z",
        created_by: "user-id",
      };

      const mockClient = createMockSupabaseClient({ selectData: dbRow });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.getLatestAgreement("user-id");

      expect(result).toEqual({
        id: "record-id",
        userId: "user-id",
        termsVersion: "2026-01-10",
        agreedAt: new Date("2026-01-18T10:00:00.000Z"),
        ipAddress: "127.0.0.1",
        userAgent: "Test Agent",
        consentType: "explicit",
        createdAt: new Date("2026-01-18T10:00:00.000Z"),
        createdBy: "user-id",
      });
    });

    it("should handle null optional fields", async () => {
      const dbRow = {
        id: "record-id",
        user_id: "user-id",
        terms_version: "2026-01-10",
        agreed_at: "2026-01-18T10:00:00.000Z",
        ip_address: null,
        user_agent: null,
        consent_type: "implicit",
        created_at: "2026-01-18T10:00:00.000Z",
        created_by: null,
      };

      const mockClient = createMockSupabaseClient({ selectData: dbRow });
      const service = new TermsAgreementService({ supabaseAdmin: mockClient });

      const result = await service.getLatestAgreement("user-id");

      expect(result?.ipAddress).toBeNull();
      expect(result?.userAgent).toBeNull();
      expect(result?.createdBy).toBeNull();
    });
  });
});

function makeHeaderStore(values: Record<string, string | null>) {
  const headerStore = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (value !== null) {
      headerStore.set(name, value);
    }
  }
  return headerStore;
}

describe("recordTermsAgreementForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(
      makeHeaderStore({
        "x-forwarded-for": "192.168.1.100",
        "x-real-ip": null,
        "user-agent": "Test Browser/1.0",
      }) as any
    );
  });

  it("returns an error when userId is empty", async () => {
    const result = await recordTermsAgreementForUser("");

    expect(result).toEqual({ error: "User ID is required" });
  });

  it("records the agreement and returns the agreementId on success", async () => {
    mockGetAdminDataClient.mockReturnValue(
      createMockSupabaseClient({
        insertData: { id: "agreement-123", terms_version: "2026-01-10" },
      })
    );

    const result = await recordTermsAgreementForUser("user-456");

    expect(result).toEqual({
      data: {
        agreementId: "agreement-123",
        termsVersion: "2026-01-10",
      },
    });
  });

  it("extracts the IP from x-forwarded-for and passes it to the insert", async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaderStore({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }) as any
    );
    const mockClient = createMockSupabaseClient({
      insertData: { id: "agreement-123", terms_version: "2026-01-10" },
    });
    mockGetAdminDataClient.mockReturnValue(mockClient);

    await recordTermsAgreementForUser("user-456");

    expect(mockClient._mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ip_address: "10.0.0.1" })
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is not present", async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaderStore({ "x-forwarded-for": null, "x-real-ip": "172.16.0.1" }) as any
    );
    const mockClient = createMockSupabaseClient({
      insertData: { id: "agreement-123", terms_version: "2026-01-10" },
    });
    mockGetAdminDataClient.mockReturnValue(mockClient);

    await recordTermsAgreementForUser("user-456");

    expect(mockClient._mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ip_address: "172.16.0.1" })
    );
  });

  it("passes the user-agent header through to the insert", async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaderStore({ "user-agent": "Mozilla/5.0 Test" }) as any
    );
    const mockClient = createMockSupabaseClient({
      insertData: { id: "agreement-123", terms_version: "2026-01-10" },
    });
    mockGetAdminDataClient.mockReturnValue(mockClient);

    await recordTermsAgreementForUser("user-456");

    expect(mockClient._mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_agent: "Mozilla/5.0 Test" })
    );
  });

  // proves AC-11
  it("returns success with agreementId 'existing' when the user already agreed", async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: "23505", message: "duplicate key value" },
            }),
          }),
        }),
      }),
    } as any;
    mockGetAdminDataClient.mockReturnValue(mockClient);

    const result = await recordTermsAgreementForUser("user-456");

    expect(result).toEqual({
      data: {
        agreementId: "existing",
        termsVersion: expect.any(String),
      },
    });
  });

  it("returns an error and logs for a non-duplicate failure", async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: "PGRST000", message: "Connection refused" },
            }),
          }),
        }),
      }),
    } as any;
    mockGetAdminDataClient.mockReturnValue(mockClient);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await recordTermsAgreementForUser("user-456");

    expect(result.error).toBe("Failed to record terms agreement");
    consoleSpy.mockRestore();
  });

  // proves AC-14 — pins today's behaviour: recordTermsAgreementForUser trusts
  // the supplied userId with no session cross-check. This is deliberately
  // NOT the desired end state; it exists so a future fix that adds a check
  // shows up as a deliberate diff against this test rather than an accident.
  it("records the agreement for the supplied userId with no session cross-check", async () => {
    const mockClient = createMockSupabaseClient({
      insertData: { id: "agreement-123", terms_version: "2026-01-10" },
    });
    mockGetAdminDataClient.mockReturnValue(mockClient);

    await recordTermsAgreementForUser("other-user-123");

    expect(mockClient._mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "other-user-123" })
    );
  });
});
