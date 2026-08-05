import { updateAiCostConfigInput } from "./schemas";

describe("updateAiCostConfigInput", () => {
  it("accepts non-negative integer seats and a non-negative cost", () => {
    const result = updateAiCostConfigInput.safeParse({ seatCount: 12, costPerSeatUsd: 30 });
    expect(result).toMatchObject({ success: true, data: { seatCount: 12, costPerSeatUsd: 30 } });
  });

  it("rejects a negative seat count", () => {
    const result = updateAiCostConfigInput.safeParse({ seatCount: -3, costPerSeatUsd: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer seat count", () => {
    const result = updateAiCostConfigInput.safeParse({ seatCount: 2.5, costPerSeatUsd: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative cost per seat", () => {
    const result = updateAiCostConfigInput.safeParse({ seatCount: 5, costPerSeatUsd: -1 });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys rather than rejecting them", () => {
    const result = updateAiCostConfigInput.safeParse({
      seatCount: 5,
      costPerSeatUsd: 20,
      tenantId: "some-other-tenant",
    });
    expect(result).toMatchObject({ success: true, data: { seatCount: 5, costPerSeatUsd: 20 } });
    expect(result.success && "tenantId" in result.data).toBe(false);
  });
});
