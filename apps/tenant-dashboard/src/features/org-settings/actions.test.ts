/**
 * updateOrganizationAction — the glue around `authorizedAction`: gated
 * tenant.update, writes through the resolved request context (never a
 * client-supplied tenant id), and re-seeds the general-settings React Server Component (RSC) on
 * success. The context + permission seams are mocked; the write runs for
 * real against the MSW `tenant` table.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedMembershipMswState } from "@/test-helpers/msw-handlers";

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { updateOrganizationAction } from "./actions";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const GENERAL_SETTINGS_PATH = "/orgs/[orgName]/settings/general";

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: TENANT_ID,
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

it("renames the request-context tenant, authorizes on tenant.update, and revalidates", async () => {
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT_ID, company_name: "Old Name" }] });

  const res = await updateOrganizationAction({ companyName: "New Name" });

  expect(res).toEqual({ ok: true, data: { tenantId: TENANT_ID, companyName: "New Name" } });
  expect(checkPermMock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user-1" }),
    "tenant.update",
    undefined,
  );
  expect(revalidateMock).toHaveBeenCalledWith(GENERAL_SETTINGS_PATH, "page");
});

it("ignores a client-supplied tenantId — the write always targets the resolved request tenant", async () => {
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT_ID, company_name: "Old Name" }] });

  const res = await updateOrganizationAction({ companyName: "New Name", tenantId: "some-other-tenant" });

  expect(res).toEqual({ ok: true, data: { tenantId: TENANT_ID, companyName: "New Name" } });
  expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), "tenant.update", undefined);
  const written = (
    await createMswRestClient().from("tenant").select("tenant_id, company_name").eq("tenant_id", TENANT_ID).single()
  ).data;
  expect(written).toEqual({ tenant_id: TENANT_ID, company_name: "New Name" });
});

it("denies an actor lacking tenant.update, writing nothing and not revalidating", async () => {
  checkPermMock.mockResolvedValue(false);
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT_ID, company_name: "Old Name" }] });

  const res = await updateOrganizationAction({ companyName: "New Name" });

  expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "Permission denied: tenant.update" } });
  expect(revalidateMock).not.toHaveBeenCalled();
  const stillOld = (await createMswRestClient().from("tenant").select("company_name").eq("tenant_id", TENANT_ID).single()).data;
  expect(stillOld?.company_name).toBe("Old Name");
});

it("rejects an empty company name before touching the context (validation error)", async () => {
  const res = await updateOrganizationAction({ companyName: "" });

  expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(loadCtxMock).not.toHaveBeenCalled();
});

it("surfaces an RLS-denied write as a typed failure instead of a silent success", async () => {
  seedMembershipMswState({
    tenants: [{ tenant_id: TENANT_ID, company_name: "Old Name" }],
    forceTenantUpdateNoMatch: true,
  });

  const res = await updateOrganizationAction({ companyName: "New Name" });

  expect(res).toEqual({ ok: false, error: { code: "internal_error", message: "tenant update failed: no rows" } });
  expect(revalidateMock).not.toHaveBeenCalled();
});
