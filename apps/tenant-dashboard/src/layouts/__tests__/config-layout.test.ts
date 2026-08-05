import { describe, it, expect } from "vitest";
import { POPOVER } from "../config-layout";

describe("POPOVER overlay width constants", () => {
  it("pins the three chrome-popover widths so a width swap cannot land silently", () => {
    expect(POPOVER).toEqual({
      ACCOUNT_WIDTH: 240,
      NOTIFICATIONS_WIDTH: 360,
      TEMP_ACCESS_WIDTH: 320,
    });
  });
});
