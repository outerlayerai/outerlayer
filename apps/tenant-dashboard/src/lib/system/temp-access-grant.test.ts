/**
 * `getActiveTempAccessGrant` — cross-admin/cross-tenant confinement is
 * pinned end-to-end against real data in
 * `apps/integration-tests/src/tests/org-lifecycle/temp-access-grant-confinement.acceptance.test.ts`.
 * This file covers the response-shaping branches the acceptance suite's
 * well-formed seed rows never exercise: PostgREST's array-vs-object embed
 * shape for the joined `tenant` resource, and the null-tenant fallback.
 */
import { seedSupabaseMswState } from "@/test-helpers/msw-handlers";

import { getActiveTempAccessGrant } from "./temp-access-grant";

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const EXPIRES_AT = new Date(Date.now() + 30 * 60 * 1000).toISOString();

describe("getActiveTempAccessGrant", () => {
  it("resolves the joined tenant when PostgREST returns it as an object", async () => {
    seedSupabaseMswState({
      tempAccessGrants: [
        {
          id: "grant-1",
          created_by: USER_ID,
          tenant_id: TENANT_ID,
          expires_at: EXPIRES_AT,
          tenant: { organization_name: "Customer Org", company_name: "Customer Company" },
        },
      ],
    });

    const grant = await getActiveTempAccessGrant({ tenantId: TENANT_ID, userId: USER_ID });

    expect(grant).toEqual({
      id: "grant-1",
      expiresAt: EXPIRES_AT,
      companyName: "Customer Company",
      organizationName: "Customer Org",
    });
  });

  it("resolves the joined tenant when PostgREST returns it as a single-element array", async () => {
    seedSupabaseMswState({
      tempAccessGrants: [
        {
          id: "grant-2",
          created_by: USER_ID,
          tenant_id: TENANT_ID,
          expires_at: EXPIRES_AT,
          tenant: [{ organization_name: "Customer Org", company_name: "Customer Company" }],
        },
      ],
    });

    const grant = await getActiveTempAccessGrant({ tenantId: TENANT_ID, userId: USER_ID });

    expect(grant?.organizationName).toBe("Customer Org");
    expect(grant?.companyName).toBe("Customer Company");
  });

  it("falls back to \"Unknown\" when the tenant embed is null", async () => {
    seedSupabaseMswState({
      tempAccessGrants: [
        {
          id: "grant-3",
          created_by: USER_ID,
          tenant_id: TENANT_ID,
          expires_at: EXPIRES_AT,
          tenant: null,
        },
      ],
    });

    const grant = await getActiveTempAccessGrant({ tenantId: TENANT_ID, userId: USER_ID });

    expect(grant?.organizationName).toBe("Unknown");
    expect(grant?.companyName).toBeNull();
  });

  it("returns null when the table is empty", async () => {
    seedSupabaseMswState({ tempAccessGrants: [] });

    const grant = await getActiveTempAccessGrant({ tenantId: TENANT_ID, userId: USER_ID });

    expect(grant).toBeNull();
  });

  it("returns null for a real, active grant that belongs to a different caller", async () => {
    seedSupabaseMswState({
      tempAccessGrants: [
        {
          id: "grant-4",
          created_by: "user-2",
          tenant_id: TENANT_ID,
          expires_at: EXPIRES_AT,
          tenant: { organization_name: "Customer Org", company_name: "Customer Company" },
        },
      ],
    });

    const grant = await getActiveTempAccessGrant({ tenantId: TENANT_ID, userId: USER_ID });

    expect(grant).toBeNull();
  });

  it("returns null for a real, active grant of the caller's against a different tenant", async () => {
    seedSupabaseMswState({
      tempAccessGrants: [
        {
          id: "grant-5",
          created_by: USER_ID,
          tenant_id: "tenant-2",
          expires_at: EXPIRES_AT,
          tenant: { organization_name: "Customer Org", company_name: "Customer Company" },
        },
      ],
    });

    const grant = await getActiveTempAccessGrant({ tenantId: TENANT_ID, userId: USER_ID });

    expect(grant).toBeNull();
  });
});
