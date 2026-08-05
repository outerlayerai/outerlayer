import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveErrorReportingConfig,
  warnLegacyDsnOnce,
  resetLegacyWarningLatch,
} from "../config";

describe("resolveErrorReportingConfig", () => {
  it("enables Sentry from the vendor-neutral server DSN", () => {
    expect(
      resolveErrorReportingConfig({ ERROR_REPORTING_DSN: "https://k@host/1" })
    ).toEqual({
      enabled: true,
      dsn: "https://k@host/1",
      backend: "sentry",
      usedLegacyDsn: false,
    });
  });

  it("enables from the NEXT_PUBLIC vendor-neutral DSN", () => {
    expect(
      resolveErrorReportingConfig({
        NEXT_PUBLIC_ERROR_REPORTING_DSN: "https://pub@host/2",
      })
    ).toEqual({
      enabled: true,
      dsn: "https://pub@host/2",
      backend: "sentry",
      usedLegacyDsn: false,
    });
  });

  it("is disabled (no-op) when nothing is configured", () => {
    expect(resolveErrorReportingConfig({})).toEqual({
      enabled: false,
      dsn: undefined,
      backend: "sentry",
      usedLegacyDsn: false,
    });
  });

  it("falls back to the legacy gateway DSN and flags it", () => {
    expect(
      resolveErrorReportingConfig({
        BETTERSTACK_ERRORS_DSN: "https://legacy@host/3",
      })
    ).toEqual({
      enabled: true,
      dsn: "https://legacy@host/3",
      backend: "sentry",
      usedLegacyDsn: true,
    });
  });

  it("falls back to the legacy dashboard DSN and flags it", () => {
    const config = resolveErrorReportingConfig({
      NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN: "https://legacy-pub@host/4",
    });
    expect(config.dsn).toBe("https://legacy-pub@host/4");
    expect(config.enabled).toBe(true);
    expect(config.usedLegacyDsn).toBe(true);
  });

  it("prefers the vendor-neutral DSN over the legacy one when both are set", () => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://new@host/1",
      BETTERSTACK_ERRORS_DSN: "https://old@host/9",
    });
    expect(config.dsn).toBe("https://new@host/1");
    expect(config.usedLegacyDsn).toBe(false);
  });

  it("prefers the server DSN over its NEXT_PUBLIC twin", () => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://server@host/1",
      NEXT_PUBLIC_ERROR_REPORTING_DSN: "https://public@host/2",
    });
    expect(config.dsn).toBe("https://server@host/1");
  });

  it("force-disables when backend is none, even with a DSN", () => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://k@host/1",
      ERROR_REPORTING_BACKEND: "none",
    });
    expect(config.enabled).toBe(false);
    expect(config.backend).toBe("none");
    // DSN still resolved — only `enabled` is clamped.
    expect(config.dsn).toBe("https://k@host/1");
  });

  it("force-disables when ERROR_REPORTING_ENABLED=false, even with a DSN", () => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://k@host/1",
      ERROR_REPORTING_ENABLED: "false",
    });
    expect(config.enabled).toBe(false);
  });

  it("cannot enable without a DSN even when ENABLED=true", () => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_ENABLED: "true",
    });
    expect(config.enabled).toBe(false);
    expect(config.dsn).toBeUndefined();
  });

  it("treats whitespace-only DSN values as absent", () => {
    const config = resolveErrorReportingConfig({ ERROR_REPORTING_DSN: "   " });
    expect(config.enabled).toBe(false);
    expect(config.dsn).toBeUndefined();
  });

  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["off", false],
    ["", false],
  ])("parses ENABLED=%j as enabled=%s (DSN present)", (raw, expected) => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://k@host/1",
      ERROR_REPORTING_ENABLED: raw,
    });
    expect(config.enabled).toBe(expected);
  });

  it("ignores an unrecognised ENABLED value and uses the DSN default", () => {
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://k@host/1",
      ERROR_REPORTING_ENABLED: "maybe",
    });
    expect(config.enabled).toBe(true);
  });
});

describe("warnLegacyDsnOnce", () => {
  beforeEach(() => {
    resetLegacyWarningLatch();
    vi.restoreAllMocks();
  });

  it("warns exactly once for a legacy DSN, then stays silent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveErrorReportingConfig({
      BETTERSTACK_ERRORS_DSN: "https://legacy@host/3",
    });

    expect(warnLegacyDsnOnce(config)).toBe(true);
    expect(warnLegacyDsnOnce(config)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("BETTERSTACK_ERRORS_DSN")
    );
  });

  it("never warns when the vendor-neutral DSN was used", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveErrorReportingConfig({
      ERROR_REPORTING_DSN: "https://new@host/1",
    });

    expect(warnLegacyDsnOnce(config)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
