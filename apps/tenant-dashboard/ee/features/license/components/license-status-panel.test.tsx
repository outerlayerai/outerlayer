// @vitest-environment jsdom
/**
 * <LicenseStatusPanel> — the self-host Settings -> License surface. Renders one
 * of three states from an already-resolved status. These pin the operator-
 * visible copy per state (a wrong state → wrong reassurance/alarm) and the
 * date/countdown formatting.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { LicenseStatusPanel } from "./license-status-panel";
import type { LicenseStatus } from "../types";

type Visible = Extract<LicenseStatus, { visible: true }>;

describe("<LicenseStatusPanel>", () => {
  it("valid: shows Active, the org, and a formatted expiry with day countdown", () => {
    const status: Visible = {
      visible: true,
      state: "valid",
      org: "Globex",
      plan: "enterprise",
      expiresAt: "2026-08-11T00:00:00.000Z",
      daysUntilExpiry: 30,
    };
    render(<LicenseStatusPanel status={status} />);

    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
    expect(screen.getByText(/Aug 1[01], 2026 \(in 30 days\)/)).toBeInTheDocument();
    // Not expiring soon (>14d) → no renewal warning.
    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument();
  });

  it("valid but expiring within 14 days: surfaces the renewal warning", () => {
    const status: Visible = {
      visible: true,
      state: "valid",
      org: "Globex",
      plan: "enterprise",
      expiresAt: "2026-07-19T00:00:00.000Z",
      daysUntilExpiry: 7,
    };
    render(<LicenseStatusPanel status={status} />);

    expect(screen.getByText(/expires in 7 days/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /renew now/i })).toBeInTheDocument();
  });

  it("grace: shows In grace period, the grace-end date, and the deactivation countdown", () => {
    const status: Visible = {
      visible: true,
      state: "grace",
      org: "Acme Corp",
      plan: "enterprise",
      expiredAt: "2026-07-09T00:00:00.000Z",
      graceEndsAt: "2026-07-23T00:00:00.000Z",
      daysUntilGraceEnds: 11,
    };
    render(<LicenseStatusPanel status={status} />);

    expect(screen.getByText("In grace period")).toBeInTheDocument();
    expect(screen.getByText(/keep working for 11 days/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /renew to avoid interruption/i })).toBeInTheDocument();
  });

  it("unlicensed: shows the locked state and how to unlock, no org row", () => {
    const status: Visible = { visible: true, state: "unlicensed" };
    render(<LicenseStatusPanel status={status} />);

    expect(screen.getByText("Unlicensed")).toBeInTheDocument();
    expect(screen.getByText(/no enterprise license/i)).toBeInTheDocument();
    expect(screen.getByText(/OUTERLAYER_EE_LICENSE_KEY/)).toBeInTheDocument();
    expect(screen.queryByText("Licensed to")).not.toBeInTheDocument();
  });
});
