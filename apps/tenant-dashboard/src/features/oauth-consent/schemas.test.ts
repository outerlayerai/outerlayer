import { decideOAuthConsentInput } from "./schemas";

describe("decideOAuthConsentInput", () => {
  it("accepts an approve decision with a non-empty authorizationId", () => {
    const result = decideOAuthConsentInput.safeParse({ authorizationId: "auth-1", decision: "approve" });
    expect(result).toEqual({ success: true, data: { authorizationId: "auth-1", decision: "approve" } });
  });

  it("accepts a deny decision", () => {
    const result = decideOAuthConsentInput.safeParse({ authorizationId: "auth-1", decision: "deny" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty authorizationId", () => {
    const result = decideOAuthConsentInput.safeParse({ authorizationId: "", decision: "approve" });
    expect(result.success).toBe(false);
  });

  it("rejects a decision outside approve/deny", () => {
    const result = decideOAuthConsentInput.safeParse({ authorizationId: "auth-1", decision: "revoke" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing authorizationId", () => {
    const result = decideOAuthConsentInput.safeParse({ decision: "approve" });
    expect(result.success).toBe(false);
  });
});
