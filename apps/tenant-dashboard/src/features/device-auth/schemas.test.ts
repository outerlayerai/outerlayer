import { approveDeviceAuthInput, denyDeviceAuthInput } from "./schemas";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("approveDeviceAuthInput", () => {
  it("accepts a well-formed requestId/appId pair, unchanged", () => {
    const result = approveDeviceAuthInput.safeParse({ requestId: VALID_UUID, appId: "app-1" });
    expect(result).toEqual({ success: true, data: { requestId: VALID_UUID, appId: "app-1" } });
  });

  it("rejects a non-UUID requestId with a uuid-shaped issue on the requestId path", () => {
    const result = approveDeviceAuthInput.safeParse({ requestId: "not-a-uuid", appId: "app-1" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]).toMatchObject({ path: ["requestId"], code: "invalid_format", format: "uuid" });
  });

  it("rejects a missing appId", () => {
    const result = approveDeviceAuthInput.safeParse({ requestId: VALID_UUID });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]).toMatchObject({ path: ["appId"], code: "invalid_type" });
  });

  it("rejects a missing requestId", () => {
    const result = approveDeviceAuthInput.safeParse({ appId: "app-1" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]).toMatchObject({ path: ["requestId"], code: "invalid_type" });
  });

  it("rejects a numeric appId — the schema demands a string, not merely a truthy value", () => {
    const result = approveDeviceAuthInput.safeParse({ requestId: VALID_UUID, appId: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(approveDeviceAuthInput.safeParse({}).success).toBe(false);
  });
});

describe("denyDeviceAuthInput", () => {
  it("accepts a well-formed requestId, unchanged", () => {
    const result = denyDeviceAuthInput.safeParse({ requestId: VALID_UUID });
    expect(result).toEqual({ success: true, data: { requestId: VALID_UUID } });
  });

  it("rejects a non-UUID requestId", () => {
    const result = denyDeviceAuthInput.safeParse({ requestId: "nope" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]).toMatchObject({ path: ["requestId"], code: "invalid_format", format: "uuid" });
  });

  it("rejects a missing requestId", () => {
    const result = denyDeviceAuthInput.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]).toMatchObject({ path: ["requestId"], code: "invalid_type" });
  });

  it("rejects a non-string requestId even when it looks numeric", () => {
    expect(denyDeviceAuthInput.safeParse({ requestId: 12345 }).success).toBe(false);
  });
});
