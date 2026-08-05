// @vitest-environment jsdom
/**
 * The platform-admin boundary's reload gate and error-reporting gate.
 *
 * It is a nested boundary, so it catches a deploy landing mid-navigation BEFORE
 * the root boundary can — which is why it has to make the same triage rather
 * than blaming platform-admin for it. The `source` it reports under is what
 * separates its faults from every other boundary's at triage.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

const loggerErrorSpy = vi.fn();

vi.mock("@/hooks/use-client-logger", () => ({
  useClientLogger: () => ({ error: loggerErrorSpy, info: vi.fn() }),
}));

import { resetPageLoadRecoveryState } from "../../deployment-skew";
import PlatformAdminError from "../error";

beforeEach(() => {
  loggerErrorSpy.mockClear();
  sessionStorage.clear();
  // Page-load-scoped in production, where a reload replaces the JS context;
  // this file shares one module instance across cases.
  resetPageLoadRecoveryState();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Spies must be restored here, not at the end of the test that installs them:
  // an assertion failing first would skip an inline restore and leak a throwing
  // `setItem`/`getItem` into later cases, silently moving them onto a different
  // branch. `clearAllMocks` resets calls but leaves the implementation in place.
  vi.restoreAllMocks();

  vi.useRealTimers();
});

describe("PlatformAdminError", () => {
  it("reloads a chunk-load failure away instead of blaming platform-admin for it", async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal("location", { reload: reloadSpy });
    const error = Object.assign(new Error("Loading chunk 42 failed"), {
      name: "ChunkLoadError",
    });

    const { queryByText } = render(<PlatformAdminError error={error} reset={vi.fn()} />);

    expect(queryByText("Something went wrong")).toBeNull();
    await vi.runAllTimersAsync();

    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it("reports a genuine fault under its own source, with the digest", async () => {
    const error = Object.assign(new Error("Feature flag read failed"), { digest: "pa-77" });

    const { getByText } = render(<PlatformAdminError error={error} reset={vi.fn()} />);

    await vi.runAllTimersAsync();

    getByText("Something went wrong");
    expect(loggerErrorSpy).toHaveBeenCalledWith(error, {
      digest: "pa-77",
      source: "platform-admin-error-boundary",
    });
  });

  it("admits the reloads failed once the budget is spent, rather than promising a new version", async () => {
    // Two reloads already ran and the same error came back, so telling this user
    // a release is waiting for them points at a fix that has already failed.
    sessionStorage.setItem("deployment-skew-reload-attempted", `${Date.now()}:2`);

    const { getByRole, queryByRole } = render(
      <PlatformAdminError error={new Error("Loading chunk 42 failed")} reset={vi.fn()} />,
    );

    await vi.runAllTimersAsync();

    expect(getByRole("heading").textContent).toBe("This page still is not loading");
    getByRole("button", { name: "Refresh page" });
    expect(queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("asks for a refresh instead of a retry when the reload guard cannot be written", async () => {
    // A dropped stamp cannot bound a retry, so no reload is attempted at all.
    // Offering "Try again" would hand the user a button that re-renders the same
    // bundle and cannot fetch the missing chunk.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    const reset = vi.fn();

    const { getByRole, queryByRole } = render(
      <PlatformAdminError error={new Error("Connection closed.")} reset={reset} />,
    );

    await vi.runAllTimersAsync();

    expect(queryByRole("button", { name: "Try again" })).toBeNull();
    getByRole("button", { name: "Refresh page" });
    expect(reset).not.toHaveBeenCalled();
  });
});
