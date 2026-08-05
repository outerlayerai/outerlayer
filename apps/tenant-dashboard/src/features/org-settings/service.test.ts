/**
 * OrgSettingsService — the read + rename, exercised through the real
 * PostgREST query path against the MSW `tenant` table (no query-chain mocks).
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedMembershipMswState } from "@/test-helpers/msw-handlers";

import { orgSettingsService } from "./service";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = { userId: "user-1", role: "owner" };

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: TENANT_ID, actor: ACTOR };
}

describe("OrgSettingsService.getTenant", () => {
  it("returns the request tenant's org row", async () => {
    seedMembershipMswState({
      tenants: [{ tenant_id: TENANT_ID, company_name: "Acme Inc." }],
    });

    const org = await orgSettingsService.getTenant(ctx());
    expect(org).toEqual({ tenantId: TENANT_ID, companyName: "Acme Inc." });
  });

  it("returns null when the row isn't visible under RLS (unknown tenant)", async () => {
    seedMembershipMswState({ tenants: [] });

    const org = await orgSettingsService.getTenant(ctx());
    expect(org).toBeNull();
  });
});

describe("OrgSettingsService.updateCompanyName", () => {
  it("writes the new company name and returns the updated row", async () => {
    seedMembershipMswState({
      tenants: [{ tenant_id: TENANT_ID, company_name: "Old Name" }],
    });

    const updated = await orgSettingsService.updateCompanyName(ctx(), { companyName: "New Name" });
    expect(updated).toEqual({ tenantId: TENANT_ID, companyName: "New Name" });

    const reread = await orgSettingsService.getTenant(ctx());
    expect(reread).toEqual({ tenantId: TENANT_ID, companyName: "New Name" });
  });

  it("throws when the write matches no row — an RLS denial the caller must not read as success", async () => {
    seedMembershipMswState({
      tenants: [{ tenant_id: TENANT_ID, company_name: "Old Name" }],
      forceTenantUpdateNoMatch: true,
    });

    await expect(
      orgSettingsService.updateCompanyName(ctx(), { companyName: "New Name" }),
    ).rejects.toThrow(/tenant update failed/);

    const unchanged = await orgSettingsService.getTenant(ctx());
    expect(unchanged).toEqual({ tenantId: TENANT_ID, companyName: "Old Name" });
  });
});
