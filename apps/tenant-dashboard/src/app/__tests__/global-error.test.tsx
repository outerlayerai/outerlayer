// @vitest-environment jsdom
/**
 * GlobalError's reload gate and error-reporting gate.
 *
 * Bug classes pinned:
 * - Reporting a reloadable error on its FIRST occurrence would flood error
 *   reporting with transient stream-close noise while the reload is already
 *   fixing it.
 * - Suppressing one that outlived its reload budget would leave a broken deploy
 *   with no client-side signal at all.
 * - Dropping the reload path would leave the user on a crash card for an error
 *   a reload fixes by itself.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

const loggerErrorSpy = vi.fn();

vi.mock("@/hooks/use-client-logger", () => ({
  useClientLogger: () => ({ error: loggerErrorSpy, info: vi.fn() }),
}));

vi.mock("next/error", () => ({
  default: () => <div data-testid="next-error" />,
}));

// Keep deployment-skew helpers real — we want to exercise the guard's actual
// isReloadable path, not a mock of it.
import { resetPageLoadRecoveryState } from "../deployment-skew";
import GlobalError from "../global-error";

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

  // Unconditional, so a failing expect inside a fake-timer test cannot leak
  // them into the rest of the file.
  vi.useRealTimers();
});

describe("GlobalError — reload gate", () => {
  it("reloads the page once for a stream-close error (first occurrence)", async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal("location", { reload: reloadSpy });

    render(<GlobalError error={new Error("Connection closed.")} />);

    await vi.runAllTimersAsync();

    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});

describe("GlobalError — Sentry logging gate", () => {
  it("logs a regular application error to Sentry", async () => {
    render(<GlobalError error={new Error("Database exploded")} />);

    await vi.runAllTimersAsync();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Database exploded" }),
      expect.any(Object),
    );
  });

  it("logs an unrecovered stream close as its own class, not as a deployment skew", async () => {
    // The budget is spent, so the same error arriving again is no longer the
    // transient a reload was meant to clear. It is still not evidence of a
    // deploy: an aborted Flight stream reaches here on a network hiccup too, so
    // labelling it skew would invent broken deploys out of transport noise.
    sessionStorage.setItem("deployment-skew-reload-attempted", `${Date.now()}:2`);

    render(<GlobalError error={new Error("Connection closed.")} />);

    await vi.runAllTimersAsync();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Connection closed." }),
      expect.objectContaining({
        source: "global-error-boundary",
        unrecoveredSkew: false,
        reloadableClass: "rsc-stream-closed",
      }),
    );
  });
});

describe("GlobalError — refuse-to-reload UI", () => {
  it("admits the reloads failed once the budget is spent, without mounting a provider", async () => {
    // The last-resort boundary has no chrome to fall back on, so its wording is
    // the only signal the user gets — and it must not promise a release that two
    // reloads already failed to deliver.
    sessionStorage.setItem("deployment-skew-reload-attempted", `${Date.now()}:2`);

    const { getByRole } = render(<GlobalError error={new Error("Loading chunk 42 failed")} />);

    await vi.runAllTimersAsync();

    expect(getByRole("heading", { level: 1 }).textContent).toBe("This page still is not loading");
    getByRole("button", { name: "Refresh page" });
  });

  it("asks for a refresh when the reload guard cannot be written, without mounting a provider", async () => {
    // This boundary replaces the root layout, so the refresh prompt has to be
    // plain HTML — the generic Next.js error page cannot say "you are stale".
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});

    const { getByRole, queryByTestId } = render(
      <GlobalError error={new Error("Connection closed.")} />,
    );

    await vi.runAllTimersAsync();

    getByRole("button", { name: "Refresh page" });
    expect(queryByTestId("next-error")).toBeNull();
  });
});
