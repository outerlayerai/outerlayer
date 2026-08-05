import { describe, it, expect } from "vitest";
import { ENV_SELECTOR_HEADER, PR_NUMBER_HEADER } from "../trace-headers";

/**
 * Pins the gateway's trace-ingest header names to the lowercase form of the
 * SDK's emitted headers. The SDK emits PascalCase `X-Outerlayer-Environment` /
 * `X-Outerlayer-Pr-Number`; Hono lowercases on read, so the gateway reads
 * the lowercase form. Renaming either side without the other breaks env
 * selection silently — the relationship is asserted here against the exact SDK
 * literal so a one-sided gateway rename fails this test.
 */
describe("trace-ingest header contract (SDK ↔ gateway)", () => {
  it("reads the lowercase of the SDK's X-Outerlayer-Environment header", () => {
    expect(ENV_SELECTOR_HEADER).toBe("X-Outerlayer-Environment".toLowerCase());
  });

  it("reads the lowercase of the SDK's X-Outerlayer-Pr-Number header", () => {
    expect(PR_NUMBER_HEADER).toBe("X-Outerlayer-Pr-Number".toLowerCase());
  });

  it("uses the lowercase form Hono produces on read (no uppercase chars)", () => {
    expect(ENV_SELECTOR_HEADER).toBe(ENV_SELECTOR_HEADER.toLowerCase());
    expect(PR_NUMBER_HEADER).toBe(PR_NUMBER_HEADER.toLowerCase());
  });
});
