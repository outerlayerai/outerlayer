/**
 * `loadOAuthGrants` — the read behind the Grants settings tab. Fails closed
 * (`unresolved`) rather than an empty list when there's no session to scope
 * to, since an empty list reads as "no connectors" — a different claim from
 * "couldn't check".
 */
const mockLoadPreTenantDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantDb: mockLoadPreTenantDb,
}));

const mockList = vi.hoisted(() => vi.fn());
vi.mock("./service", () => ({
  oauthGrantsService: { list: mockList },
}));

import { loadOAuthGrants } from "./read";

const FAKE_DB = { marker: "db" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadOAuthGrants", () => {
  it("returns unresolved, not an empty list, and never calls list when there is no session", async () => {
    mockLoadPreTenantDb.mockResolvedValue(null);

    const result = await loadOAuthGrants();

    expect(result).toEqual({ unresolved: true });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns the grants list from the resolved db", async () => {
    mockLoadPreTenantDb.mockResolvedValue(FAKE_DB);
    const grants = [
      {
        sessionId: "session-1",
        clientId: "client-1",
        clientName: "Claude",
        scopes: ["mcp:read"],
        createdAt: "2026-08-01T00:00:00Z",
        refreshedAt: null,
      },
    ];
    mockList.mockResolvedValue(grants);

    const result = await loadOAuthGrants();

    expect(mockList).toHaveBeenCalledWith(FAKE_DB);
    expect(result).toEqual({ grants });
  });

  it("returns an empty grants array (not unresolved) when the caller genuinely has none", async () => {
    mockLoadPreTenantDb.mockResolvedValue(FAKE_DB);
    mockList.mockResolvedValue([]);

    const result = await loadOAuthGrants();

    expect(result).toEqual({ grants: [] });
  });
});
