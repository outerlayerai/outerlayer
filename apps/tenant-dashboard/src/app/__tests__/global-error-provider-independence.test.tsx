// @vitest-environment jsdom
/**
 * `global-error` replaces the root layout, so NOTHING the app normally provides
 * is mounted around it — no theme, no auth provider, no app context. It is the
 * last-resort boundary: if it throws, the user gets a blank page and the fault
 * is never reported.
 *
 * The sibling suite mocks `useClientLogger`, which is exactly the dependency
 * that could break this. Here it stays REAL, and nothing is wrapped around the
 * component, so the transitive chain is the thing under test: `GlobalError` →
 * `useErrorBoundaryRecovery` → `useClientLogger` → `useLogger` +
 * `useAuthContext` + `useContext(AppContext)`.
 *
 * `useAuthContext` throws when its context is falsy, and it survives out here
 * only because `AuthContext` is created with a `{}` default, which makes that
 * guard unreachable. That default is deliberate, not incidental: changing it
 * to `null` — which the guard's wording invites — crashes this boundary.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The shared setup mocks `auth/hooks` app-wide so components render without an
// AuthProvider. That mock is precisely what would hide this regression, so this
// file opts out and resolves the real `useAuthContext` against the real context.
vi.unmock("../../auth/hooks");

import { resetPageLoadRecoveryState } from "../deployment-skew";
import GlobalError from "../global-error";

beforeEach(() => {
  sessionStorage.clear();
  resetPageLoadRecoveryState();
  vi.useFakeTimers();
  // The real logger writes to the console on every path; keep the run readable
  // without mocking the module under examination.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GlobalError outside every provider", () => {
  it("renders the updating state for skew with the real client logger and no providers mounted", () => {
    // A reloadable error drives the full hook path — guard read, stamp write,
    // reload scheduling — with the real logger resolved through contexts that
    // have no provider above them.
    vi.stubGlobal("location", { reload: vi.fn() });
    const skew = Object.assign(new Error("Loading chunk 42 failed"), {
      name: "ChunkLoadError",
    });

    render(<GlobalError error={skew} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Updating application...",
    );
  });

  it("reports a genuine fault through the real logger without a provider to resolve context from", () => {
    // The reporting path is the one that actually touches auth and app context,
    // via the metadata the logger builds. A missing provider must not turn a
    // reportable fault into a crash inside the boundary meant to catch it.
    const fault = Object.assign(new Error("ClickHouse unavailable"), { digest: "abc123" });

    render(<GlobalError error={fault} />);

    expect(console.error).toHaveBeenCalledWith(
      "[ERROR]",
      "ClickHouse unavailable",
      expect.any(Object),
    );
  });
});
