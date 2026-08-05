/**
 * Unit Tests for Get User Permissions
 *
 * Tests permission fetching logic with mocked Supabase clients.
 *
 * Key invariant: role is read from membership table (always current),
 * NOT from app_metadata.role (which can be stale after role promotion).
 * The tenant comes solely from the request (the URL org the middleware
 * derived).
 */

// Mock server-only before any imports
vi.mock("server-only", () => ({}));

// Unmock getCurrentUserPermissions since it's globally mocked in test setup
vi.unmock("../get-user-permissions");

const headersGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], get: () => undefined }),
  headers: () => ({ get: headersGet }),
}));

import * as supabaseAdminClientModule from "../../supabaseAdminClient";
import * as supabaseServerClientModule from "../../supabaseServerClient";
import { getCurrentUserPermissions } from "../get-user-permissions";

const mockCreateAdminClient = vi.spyOn(supabaseAdminClientModule, "createSupabaseAdminClient");
const mockCreateServerClient = vi.spyOn(supabaseServerClientModule, "createSupabaseServerClient");

describe("getCurrentUserPermissions", () => {
  /**
   * Helper to build a server client mock with the given user.
   */
  function makeServerClient(user: any) {
    return {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user } }),
      },
    } as any;
  }

  /**
   * Helper to build an admin client mock that handles both table queries:
   * - membership: returns membershipData via .eq().eq().eq().single()
   * - role_permissions: returns permissionsData via .select().match()
   */
  function makeAdminClient(membershipData: any, permissionsData: any) {
    const mockSingle = vi.fn().mockResolvedValue({ data: membershipData });
    const mockMembershipEq3 = vi.fn().mockReturnValue({ single: mockSingle });
    const mockMembershipEq2 = vi.fn().mockReturnValue({ eq: mockMembershipEq3 });
    const mockMembershipEq1 = vi.fn().mockReturnValue({ eq: mockMembershipEq2 });
    const mockMembershipSelect = vi.fn().mockReturnValue({ eq: mockMembershipEq1 });

    const mockMatch = vi.fn().mockResolvedValue({ data: permissionsData });
    const mockPermissionsSelect = vi.fn().mockReturnValue({ match: mockMatch });

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === "membership") {
        return { select: mockMembershipSelect };
      }
      return { select: mockPermissionsSelect };
    });

    return {
      client: { from: mockFrom } as any,
      mockFrom,
      mockMembershipSelect,
      mockMembershipEq1,
      mockMembershipEq2,
      mockMembershipEq3,
      mockSingle,
      mockPermissionsSelect,
      mockMatch,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    headersGet.mockReset();
  });

  it("should return empty array when user is null", async () => {
    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient(null));
    mockCreateAdminClient.mockReturnValue({} as any);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual([]);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("should return empty array when there is no request tenant, regardless of the user's JWT claim", async () => {
    headersGet.mockReturnValue(null);
    mockCreateServerClient.mockResolvedValue(
      makeServerClient({ id: "user-123", app_metadata: { tenant_id: "tenant-abc" } })
    );
    mockCreateAdminClient.mockReturnValue({} as any);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual([]);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("should return empty array when membership not found", async () => {
    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-123" }));

    const { client } = makeAdminClient(null, []);
    mockCreateAdminClient.mockReturnValue(client);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual([]);
  });

  it("should return owner permissions read from membership (not app_metadata)", async () => {
    // Simulate a user promoted to owner AFTER invitation:
    // app_metadata.role is stale ('write') but membership.role is 'owner'
    const ownerPermissions = [
      { id: 1, role: "owner", permission: "api_key.delete" },
      { id: 2, role: "owner", permission: "api_key.read" },
      { id: 3, role: "owner", permission: "app.read" },
    ];

    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(
      makeServerClient({
        id: "user-123",
        app_metadata: { role: "write" }, // stale!
      })
    );

    const { client, mockFrom, mockMatch } = makeAdminClient(
      { role: "owner" },
      ownerPermissions
    );
    mockCreateAdminClient.mockReturnValue(client);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual(ownerPermissions);
    // Must query membership, not rely on app_metadata.role
    expect(mockFrom).toHaveBeenCalledWith("membership");
    expect(mockFrom).toHaveBeenCalledWith("role_permissions");
    expect(mockMatch).toHaveBeenCalledWith({ role: "owner" });
  });

  it("should query membership by user_id, tenant_id, and active status", async () => {
    headersGet.mockReturnValue("tenant-xyz");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-456" }));

    const {
      client,
      mockMembershipEq1,
      mockMembershipEq2,
      mockMembershipEq3,
    } = makeAdminClient({ role: "write" }, []);
    mockCreateAdminClient.mockReturnValue(client);

    await getCurrentUserPermissions();

    expect(mockMembershipEq1).toHaveBeenCalledWith("user_id", "user-456");
    expect(mockMembershipEq2).toHaveBeenCalledWith("tenant_id", "tenant-xyz");
    expect(mockMembershipEq3).toHaveBeenCalledWith("status", "active");
  });

  it("should return permissions for user with write role", async () => {
    const writePermissions = [
      { id: 5, role: "write", permission: "app.read" },
      { id: 6, role: "write", permission: "template.read" },
    ];

    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-456" }));

    const { client, mockMatch } = makeAdminClient({ role: "write" }, writePermissions);
    mockCreateAdminClient.mockReturnValue(client);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual(writePermissions);
    expect(mockMatch).toHaveBeenCalledWith({ role: "write" });
  });

  it("should return permissions for user with read role", async () => {
    const readPermissions = [
      { id: 7, role: "read", permission: "app.read" },
    ];

    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-789" }));

    const { client, mockMatch } = makeAdminClient({ role: "read" }, readPermissions);
    mockCreateAdminClient.mockReturnValue(client);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual(readPermissions);
    expect(mockMatch).toHaveBeenCalledWith({ role: "read" });
  });

  it("should return empty array when role_permissions query returns null", async () => {
    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-123" }));

    const { client } = makeAdminClient({ role: "owner" }, null);
    mockCreateAdminClient.mockReturnValue(client);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual([]);
  });

  it("should return empty array when role_permissions query returns undefined", async () => {
    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-123" }));

    const { client } = makeAdminClient({ role: "owner" }, undefined);
    mockCreateAdminClient.mockReturnValue(client);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual([]);
  });

  it("should use admin client for both membership and role_permissions queries", async () => {
    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-123" }));

    const { client, mockFrom } = makeAdminClient({ role: "owner" }, []);
    mockCreateAdminClient.mockReturnValue(client);

    await getCurrentUserPermissions();

    expect(mockCreateAdminClient).toHaveBeenCalledWith();
    expect(mockFrom).toHaveBeenCalledWith("membership");
    expect(mockFrom).toHaveBeenCalledWith("role_permissions");
  });

  it("should return custom role permissions when membership has custom_role_id", async () => {
    const customRolePerms = [
      { custom_role_id: "cr-1", permission: "app.read" },
      { custom_role_id: "cr-1", permission: "template.read" },
    ];

    headersGet.mockReturnValue("tenant-abc");
    mockCreateServerClient.mockResolvedValue(makeServerClient({ id: "user-custom" }));

    // Membership with custom_role_id
    const mockSingle = vi.fn().mockResolvedValue({
      data: { role: "read", custom_role_id: "cr-1" },
    });
    const mockMembershipEq3 = vi.fn().mockReturnValue({ single: mockSingle });
    const mockMembershipEq2 = vi.fn().mockReturnValue({ eq: mockMembershipEq3 });
    const mockMembershipEq1 = vi.fn().mockReturnValue({ eq: mockMembershipEq2 });
    const mockMembershipSelect = vi.fn().mockReturnValue({ eq: mockMembershipEq1 });

    // custom_role_permission query chain: .select().eq()
    const mockCustomPermEq = vi.fn().mockResolvedValue({ data: customRolePerms });
    const mockCustomPermSelect = vi.fn().mockReturnValue({ eq: mockCustomPermEq });

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === "membership") return { select: mockMembershipSelect };
      if (table === "custom_role_permission") return { select: mockCustomPermSelect };
      return { select: vi.fn().mockReturnValue({ match: vi.fn().mockResolvedValue({ data: [] }) }) };
    });

    mockCreateAdminClient.mockReturnValue({ from: mockFrom } as any);

    const result = await getCurrentUserPermissions();

    expect(result).toEqual([
      { id: "cr-1", role: "read", permission: "app.read" },
      { id: "cr-1", role: "read", permission: "template.read" },
    ]);
    expect(mockFrom).toHaveBeenCalledWith("custom_role_permission");
    // Should NOT query role_permissions for custom roles
    expect(mockFrom).not.toHaveBeenCalledWith("role_permissions");
  });

  it("should use server client to get authenticated user", async () => {
    headersGet.mockReturnValue(null);
    const mockGetUser = vi.fn().mockResolvedValue({
      data: { user: null },
    });
    mockCreateServerClient.mockResolvedValue({
      auth: { getUser: mockGetUser },
    } as any);

    mockCreateAdminClient.mockReturnValue({} as any);

    await getCurrentUserPermissions();

    // The request tenant is passed through explicitly, even as `undefined`
    // when absent — it is the only source of tenancy.
    expect(mockCreateServerClient).toHaveBeenCalledWith(undefined);
    expect(mockGetUser).toHaveBeenCalledWith();
  });
});
