import { approveDeviceAuthInput, denyDeviceAuthInput } from "./schemas";

describe("approveDeviceAuthInput", () => {
  it("accepts a well-formed requestId/appId pair", () => {
    const result = approveDeviceAuthInput.safeParse({
      requestId: "11111111-1111-4111-8111-111111111111",
      appId: "app-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID requestId", () => {
    const result = approveDeviceAuthInput.safeParse({ requestId: "not-a-uuid", appId: "app-1" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing appId", () => {
    const result = approveDeviceAuthInput.safeParse({ requestId: "11111111-1111-4111-8111-111111111111" });
    expect(result.success).toBe(false);
  });
});

describe("denyDeviceAuthInput", () => {
  it("accepts a well-formed requestId", () => {
    expect(denyDeviceAuthInput.safeParse({ requestId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
  });

  it("rejects a non-UUID requestId", () => {
    expect(denyDeviceAuthInput.safeParse({ requestId: "nope" }).success).toBe(false);
  });
});
