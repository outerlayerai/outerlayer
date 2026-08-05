import {
  createCheckoutSessionInput,
  upgradeSubscriptionInput,
  createPortalSessionInput,
} from "./schemas";

describe("createCheckoutSessionInput", () => {
  it("accepts a redirect URL and a known tier", () => {
    const result = createCheckoutSessionInput.safeParse({ redirectTo: "https://x.test", tierId: "growth" });
    expect(result).toMatchObject({ success: true, data: { redirectTo: "https://x.test", tierId: "growth" } });
  });

  it("rejects an unknown tier", () => {
    const result = createCheckoutSessionInput.safeParse({ redirectTo: "https://x.test", tierId: "not-a-tier" });
    expect(result.success).toBe(false);
  });
});

describe("upgradeSubscriptionInput", () => {
  it("accepts a known tier", () => {
    const result = upgradeSubscriptionInput.safeParse({ tierId: "team" });
    expect(result).toMatchObject({ success: true, data: { tierId: "team" } });
  });
});

describe("createPortalSessionInput", () => {
  it("accepts a redirect URL", () => {
    const result = createPortalSessionInput.safeParse({ redirectTo: "https://x.test" });
    expect(result).toMatchObject({ success: true, data: { redirectTo: "https://x.test" } });
  });

  it("rejects a missing redirect URL", () => {
    const result = createPortalSessionInput.safeParse({});
    expect(result.success).toBe(false);
  });
});
