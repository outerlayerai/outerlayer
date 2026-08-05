import { updateOrganizationInput } from "./schemas";

describe("updateOrganizationInput", () => {
  it("accepts a non-empty company name", () => {
    const result = updateOrganizationInput.safeParse({ companyName: "Acme Inc." });
    expect(result).toMatchObject({ success: true, data: { companyName: "Acme Inc." } });
  });

  it("rejects an empty company name", () => {
    const result = updateOrganizationInput.safeParse({ companyName: "" });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys rather than rejecting them", () => {
    const result = updateOrganizationInput.safeParse({ companyName: "Acme", tenantId: "t-1" });
    expect(result).toMatchObject({ success: true, data: { companyName: "Acme" } });
    expect(result.success && "tenantId" in result.data).toBe(false);
  });
});
