/**
 * `listMembers` delegates to `lib/system/listTenantMembers` (covered by its
 * own suite) — pinned here only as a passthrough. `listAppsForInvite` is this
 * file's own logic: an RLS-scoped read via the caller-supplied `db`, so it's
 * tested against a minimal query-builder double rather than the real wire.
 */
import { listTenantMembers } from "@/lib/system";
import { listMembers, listAppsForInvite } from "./service";

vi.mock("@/lib/system", () => ({
  listTenantMembers: vi.fn(),
}));

describe("listMembers", () => {
  it("forwards the tenantId to listTenantMembers and returns its result unchanged", async () => {
    const rows = [{ id: "u1" }] as never;
    vi.mocked(listTenantMembers).mockResolvedValue(rows);

    const result = await listMembers("tenant-1");

    expect(result).toBe(rows);
    expect(listTenantMembers).toHaveBeenCalledWith("tenant-1");
  });
});

describe("listAppsForInvite", () => {
  function makeDb(data: unknown) {
    const order = vi.fn().mockResolvedValue({ data });
    const select = vi.fn().mockReturnValue({ order });
    const from = vi.fn().mockReturnValue({ select });
    return { db: { from } as never, from, select, order };
  }

  it("reads id+name from the app table ordered by name", async () => {
    const { db, from, select, order } = makeDb([
      { id: "app-2", name: "Beta" },
      { id: "app-1", name: "Alpha" },
    ]);

    const result = await listAppsForInvite(db);

    expect(result).toEqual([
      { id: "app-2", name: "Beta" },
      { id: "app-1", name: "Alpha" },
    ]);
    expect(from).toHaveBeenCalledWith("app");
    expect(select).toHaveBeenCalledWith("id, name");
    expect(order).toHaveBeenCalledWith("name");
  });

  it("returns [] when the read yields no data", async () => {
    const { db } = makeDb(null);

    const result = await listAppsForInvite(db);

    expect(result).toEqual([]);
  });
});
