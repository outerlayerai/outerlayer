import { describe, it, expect } from "vitest";
import { iconForNotificationType } from "../notification-icons";

describe("iconForNotificationType", () => {
  it("maps each known type to its line glyph", () => {
    expect(iconForNotificationType("warning")).toBe("mdi:alert-outline");
    expect(iconForNotificationType("alert")).toBe("mdi:alert-outline");
    expect(iconForNotificationType("deploy")).toBe("mdi:rocket-launch-outline");
    expect(iconForNotificationType("billing")).toBe("mdi:credit-card-outline");
    expect(iconForNotificationType("info")).toBe("mdi:information-outline");
  });

  it("is case-insensitive on the type key", () => {
    expect(iconForNotificationType("WARNING")).toBe("mdi:alert-outline");
    expect(iconForNotificationType("Deploy")).toBe("mdi:rocket-launch-outline");
  });

  it("falls back to the default bell glyph for null, undefined, or unknown types", () => {
    expect(iconForNotificationType(null)).toBe("mdi:bell-outline");
    expect(iconForNotificationType(undefined)).toBe("mdi:bell-outline");
    expect(iconForNotificationType("")).toBe("mdi:bell-outline");
    expect(iconForNotificationType("totally-unknown")).toBe("mdi:bell-outline");
  });
});
