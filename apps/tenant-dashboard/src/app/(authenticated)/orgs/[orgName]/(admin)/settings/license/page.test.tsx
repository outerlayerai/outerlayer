import { describe, it, expect, vi, beforeEach } from "vitest";

// notFound() halts rendering by throwing in Next; mimic that so the Cloud
// (hidden) path is observable.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const resolve = vi.hoisted(() => ({ status: undefined as unknown }));
vi.mock("@ee/features/license/service", () => ({
  resolveLicenseStatus: vi.fn(async () => resolve.status),
}));

// Keep the MUI panel tree out of this routing test.
vi.mock("@ee/features/license/components/license-status-panel", () => ({
  LicenseStatusPanel: ({ status }: { status: { state: string } }) => `PANEL:${status.state}`,
}));

import LicenseSettingsPage from "./page";
import { notFound } from "next/navigation";

beforeEach(() => {
  (notFound as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("LicenseSettingsPage — self-host gate", () => {
  it("renders the panel for a visible (self-host) status", async () => {
    resolve.status = { visible: true, state: "grace" };
    const el = await LicenseSettingsPage();
    expect(notFound).not.toHaveBeenCalled();
    // The mocked panel returns a string element carrying the state.
    expect((el as { type: (p: unknown) => string }).type({ status: { state: "grace" } })).toBe(
      "PANEL:grace",
    );
  });

  it("calls notFound() (404) when the surface is hidden (Cloud)", async () => {
    resolve.status = { visible: false };
    await expect(LicenseSettingsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
