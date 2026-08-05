import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveSentryOptions } from "./index";
import { resetLegacyWarningLatch } from "@repo/error-reporting-core";
import type { Env } from "@repo/gateway-core/types";

// resolveSentryOptions only reads the error-reporting env fields; cast a partial
// env so tests don't have to construct the entire worker Env.
function envWith(fields: Partial<Env>): Env {
  return fields as Env;
}

describe("resolveSentryOptions (gateway error-reporting toggle)", () => {
  beforeEach(() => {
    resetLegacyWarningLatch();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enables with the vendor-neutral DSN and the standard options", () => {
    const options = resolveSentryOptions(
      envWith({ ERROR_REPORTING_DSN: "https://k@host/1" })
    );
    expect(options).toEqual({
      dsn: "https://k@host/1",
      release: "unknown",
      sendDefaultPii: true,
      skipOpenTelemetrySetup: true,
    });
  });

  it("falls back to the legacy BetterStack DSN", () => {
    const options = resolveSentryOptions(
      envWith({ BETTERSTACK_ERRORS_DSN: "https://legacy@host/2" })
    );
    expect(options.dsn).toBe("https://legacy@host/2");
  });

  it("prefers the vendor-neutral DSN over the legacy one", () => {
    const options = resolveSentryOptions(
      envWith({
        ERROR_REPORTING_DSN: "https://new@host/1",
        BETTERSTACK_ERRORS_DSN: "https://old@host/9",
      })
    );
    expect(options.dsn).toBe("https://new@host/1");
  });

  it("disables (dsn undefined) when no DSN is configured", () => {
    const options = resolveSentryOptions(envWith({}));
    expect(options.dsn).toBeUndefined();
    // Static options remain so the SDK still initializes (as a no-op client).
    expect(options.sendDefaultPii).toBe(true);
    expect(options.skipOpenTelemetrySetup).toBe(true);
  });

  it("disables when ERROR_REPORTING_ENABLED=false despite a DSN", () => {
    const options = resolveSentryOptions(
      envWith({
        ERROR_REPORTING_DSN: "https://k@host/1",
        ERROR_REPORTING_ENABLED: "false",
      })
    );
    expect(options.dsn).toBeUndefined();
  });

  it("disables when ERROR_REPORTING_BACKEND=none despite a DSN", () => {
    const options = resolveSentryOptions(
      envWith({
        ERROR_REPORTING_DSN: "https://k@host/1",
        ERROR_REPORTING_BACKEND: "none",
      })
    );
    expect(options.dsn).toBeUndefined();
  });

  it("warns once when the legacy DSN supplied the value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveSentryOptions(envWith({ BETTERSTACK_ERRORS_DSN: "https://legacy@host/2" }));
    resolveSentryOptions(envWith({ BETTERSTACK_ERRORS_DSN: "https://legacy@host/2" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BETTERSTACK_ERRORS_DSN"));
  });
});
