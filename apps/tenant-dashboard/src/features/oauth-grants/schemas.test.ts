import { revokeOAuthGrantInput } from "./schemas";

describe("revokeOAuthGrantInput", () => {
  it("accepts a non-empty sessionId", () => {
    const result = revokeOAuthGrantInput.safeParse({ sessionId: "session-1" });
    expect(result).toEqual({ success: true, data: { sessionId: "session-1" } });
  });

  it("rejects an empty sessionId", () => {
    const result = revokeOAuthGrantInput.safeParse({ sessionId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing sessionId", () => {
    const result = revokeOAuthGrantInput.safeParse({});
    expect(result.success).toBe(false);
  });
});
