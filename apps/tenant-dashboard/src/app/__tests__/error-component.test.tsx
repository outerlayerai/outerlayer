// @vitest-environment jsdom
/**
 * The route Error boundary's reload gate and error-reporting gate, driven
 * through the rendered component so its wiring to the recovery hook is covered
 * as well as the hook's own decisions.
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
import { render, screen } from "@testing-library/react";

const loggerErrorSpy = vi.fn();

vi.mock("@/hooks/use-client-logger", () => ({
  useClientLogger: () => ({ error: loggerErrorSpy, info: vi.fn() }),
}));

// Keep deployment-skew helpers real — we want to exercise the guard's actual
// isReloadable path, not a mock of it.
import { resetPageLoadRecoveryState } from "../deployment-skew";
import RouteError from "../error";

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

describe("Error boundary — reload gate", () => {
  it("reloads the page once for a stream-close error (first occurrence)", async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal("location", { reload: reloadSpy });

    render(<RouteError error={new Error("Connection closed.")} reset={vi.fn()} />);

    await vi.runAllTimersAsync();

    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});

describe("Error boundary — Sentry logging gate", () => {
  it("logs a regular application error to Sentry", async () => {
    render(<RouteError error={new Error("Database exploded")} reset={vi.fn()} />);

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

    render(<RouteError error={new Error("Connection closed.")} reset={vi.fn()} />);

    await vi.runAllTimersAsync();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Connection closed." }),
      expect.objectContaining({
        source: "route-error-boundary",
        unrecoveredSkew: false,
        reloadableClass: "rsc-stream-closed",
      }),
    );
  });
});

describe("Error boundary — refuse-to-reload UI", () => {
  it("offers a refresh rather than Try again once the reloads are spent", async () => {
    // `reset()` re-renders against the bundle that just failed two reloads, and
    // every press throws a new Error whose identity defeats the report dedupe.
    const reset = vi.fn();
    sessionStorage.setItem("deployment-skew-reload-attempted", `${Date.now()}:2`);

    render(<RouteError error={new Error("Loading chunk 42 failed")} reset={reset} />);

    await vi.runAllTimersAsync();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This page still is not loading",
    );
    expect(screen.getByRole("button").textContent).toBe("Refresh page");
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("asks for a refresh instead of a retry when the reload guard cannot be written", async () => {
    // A dropped stamp cannot bound a retry, so no reload is attempted at all.
    // `reset()` re-renders the same bundle, so the default "Try again" cannot
    // fetch a chunk that is missing.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    const reset = vi.fn();

    const { getByRole, queryByRole } = render(
      <RouteError error={new Error("Connection closed.")} reset={reset} />,
    );

    await vi.runAllTimersAsync();

    expect(queryByRole("button", { name: "Try again" })).toBeNull();
    getByRole("button", { name: "Refresh page" });
    expect(reset).not.toHaveBeenCalled();
  });
});
