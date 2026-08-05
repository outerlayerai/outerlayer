/**
 * The transition input schema is the boundary that rejects a bogus target
 * status before any DB round-trip — the "400 bad status" the deleted route
 * enforced, now enforced at the action's validation seam.
 */

import { transitionEscalationInput } from "./schemas";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const ESCALATION_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("transitionEscalationInput", () => {
  it("accepts the two legal transition targets", () => {
    for (const status of ["acked", "resolved"] as const) {
      const parsed = transitionEscalationInput.safeParse({
        appId: APP_ID,
        escalationId: ESCALATION_ID,
        status,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects `open` as a target — a row is born open, never transitioned to it", () => {
    const parsed = transitionEscalationInput.safeParse({
      appId: APP_ID,
      escalationId: ESCALATION_ID,
      status: "open",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-uuid app or escalation id", () => {
    expect(
      transitionEscalationInput.safeParse({ appId: "app-1", escalationId: ESCALATION_ID, status: "acked" }).success,
    ).toBe(false);
    expect(
      transitionEscalationInput.safeParse({ appId: APP_ID, escalationId: "nope", status: "acked" }).success,
    ).toBe(false);
  });
});
