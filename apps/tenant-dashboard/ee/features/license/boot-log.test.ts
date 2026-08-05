import { describe, it, expect, vi } from "vitest";

import { licenseBootLogLine, logLicenseStateAtBoot } from "./boot-log";
import type { LicenseStatus } from "./types";

describe("licenseBootLogLine", () => {
  it("returns null when the surface is hidden (Cloud) — nothing to log", () => {
    expect(licenseBootLogLine({ visible: false })).toBeNull();
  });

  it("logs valid with org, expiry, and countdown", () => {
    const status: LicenseStatus = {
      visible: true,
      state: "valid",
      org: "Globex",
      plan: "enterprise",
      expiresAt: "2026-08-11T00:00:00.000Z",
      daysUntilExpiry: 30,
    };
    expect(JSON.parse(licenseBootLogLine(status)!)).toEqual({
      event: "ee_license_state",
      state: "valid",
      org: "Globex",
      expiresAt: "2026-08-11T00:00:00.000Z",
      daysUntilExpiry: 30,
    });
  });

  it("logs grace with the grace-end fields, not the expiry ones", () => {
    const status: LicenseStatus = {
      visible: true,
      state: "grace",
      org: "Acme Corp",
      plan: "enterprise",
      expiredAt: "2026-07-09T00:00:00.000Z",
      graceEndsAt: "2026-07-23T00:00:00.000Z",
      daysUntilGraceEnds: 11,
    };
    const parsed = JSON.parse(licenseBootLogLine(status)!);
    expect(parsed).toEqual({
      event: "ee_license_state",
      state: "grace",
      org: "Acme Corp",
      graceEndsAt: "2026-07-23T00:00:00.000Z",
      daysUntilGraceEnds: 11,
    });
    expect(parsed).not.toHaveProperty("daysUntilExpiry");
  });

  it("logs unlicensed as state-only (no org/expiry leaked)", () => {
    expect(JSON.parse(licenseBootLogLine({ visible: true, state: "unlicensed" })!)).toEqual({
      event: "ee_license_state",
      state: "unlicensed",
    });
  });
});

describe("logLicenseStateAtBoot", () => {
  it("emits the line to the injected sink on self-host", async () => {
    const log = vi.fn();
    await logLicenseStateAtBoot(log, { OUTERLAYER_SELF_HOSTED: "true" });
    // Unlicensed self-host → one state-only line.
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] ?? [];
    expect(JSON.parse(line as string)).toEqual({
      event: "ee_license_state",
      state: "unlicensed",
    });
  });

  it("logs nothing on Cloud (no self-host flag)", async () => {
    const log = vi.fn();
    await logLicenseStateAtBoot(log, {});
    expect(log).not.toHaveBeenCalled();
  });

  it("never throws even if the sink itself throws", async () => {
    const log = vi.fn(() => {
      throw new Error("sink exploded");
    });
    await expect(
      logLicenseStateAtBoot(log, { OUTERLAYER_SELF_HOSTED: "true" }),
    ).resolves.toBeUndefined();
  });
});
