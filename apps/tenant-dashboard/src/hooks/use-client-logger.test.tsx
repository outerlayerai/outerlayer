// @vitest-environment jsdom
/**
 * useClientLogger tests — regression guard for the SWR-fetcher filter.
 *
 * The hook's key property in production is **selective Sentry
 * reporting**: errors that carry an HTTP `status` of 401, 403, or 404 are
 * policy outcomes (session expired, lost access, deleted resource) and must
 * NOT page on-call; every other error MUST reach `Sentry.captureException`.
 *
 * This filter only has something to act on if the per-hook SWR fetchers
 * attach `status` to the thrown error in the first place (see the fetcher in
 * `use-traces.ts`) — without that, an idle session expiry would surface a
 * 401 → snackbar (correct) AND a Sentry/BetterStack alert (wrong). This test
 * pins both halves so that failure mode can't return silently.
 */

import React from "react";
import { act, renderHook } from "@testing-library/react";
import * as Sentry from "@/lib/observability/error-reporting/sentry";
import type { MockInstance } from "vitest";

import { AppContext } from "@/lib/app-shell/app-context/app-context";

// ---- Mocks ----------------------------------------------------------------
// True seams (per apps/tenant-dashboard/CLAUDE.md): Sentry and @logtail/next
// are stable SDKs, useAuthContext is an owned internal hook with a stable
// signature. None of these are HTTP boundaries, so vi.mock is the correct
// tool — not MSW. AppContext is NOT mocked: we render the real Provider so
// the test isn't coupled to React's internal useContext implementation.

vi.mock("@/lib/observability/error-reporting/sentry", () => ({
  setContext: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
}));

// Stable singleton so tests can assert Logtail routing (the transient
// network-error class lands here at `warn` instead of in Sentry).
const logtailMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@logtail/next/hooks", () => ({
  useLogger: () => logtailMock,
}));

let mockUser: {
  id?: string;
  tenant?: { tenant_id: string };
  activeTenant?: { tenant_id: string };
} | null = null;
vi.mock("../auth/hooks", () => ({
  useAuthContext: () => ({ user: mockUser }),
}));

// ---- Imports under test ---------------------------------------------------
// Import AFTER mocks so the hook picks up the mocked modules.
import { useClientLogger } from "./use-client-logger";

// ---- Helpers --------------------------------------------------------------

function setNodeEnv(value: string) {
  (process.env as { NODE_ENV: string }).NODE_ENV = value;
}

/**
 * Build an Error shaped like what an SWR fetcher throws after attaching
 * `status` to the thrown Error (see `use-traces.ts` fetcher).
 */
function errorWithStatus(message: string, status: number): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Wrap renderHook with the real AppContext.Provider so `useContext(AppContext)`
 * resolves to a controllable app fixture without mocking React internals.
 */
function makeWrapper(appId: string | null) {
  // `useClientLogger` reads only `appContext?.app?.id` — a minimal stub keeps
  // the Provider value type-clean without dragging in Supabase query types.
  const value = {
    app: appId ? ({ id: appId } as never) : null,
    loading: false,    hasCreatedTrace: false,
    markTraceSeen: () => {},
  };
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
  };
}

// ---- Tests ----------------------------------------------------------------

describe("useClientLogger", () => {
  let consoleErrorSpy: MockInstance;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Default fixtures: logged-in user inside an app.
    mockUser = {
      id: "user-1",
      activeTenant: { tenant_id: "tenant-1" },
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    setNodeEnv(originalEnv || "test");
  });

  describe("error() in production", () => {
    /**
     * Positive control — proves the wiring works. A genuine 500 must reach
     * Sentry; if this ever stops being true, the test below ("filters policy
     * outcomes") would pass for the wrong reason (i.e. Sentry mock silently
     * never being called for ANY status).
     */
    it("captures a non-policy error (5xx) to Sentry", () => {
      setNodeEnv("production");

      const { result } = renderHook(() => useClientLogger(), {
        wrapper: makeWrapper("app-1"),
      });
      const err = errorWithStatus("Internal Server Error", 500);

      act(() => {
        result.current.error(err, { source: "useTraces" });
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
    });

    /**
     * Guards against this failure mode:
     *
     *   Idle session → SWR poll → 401 → useClientLogger.error → Sentry alert
     *
     * Two things must both hold to prevent it:
     *   (a) fetchers attach `status` to the thrown Error  (see apiFetch)
     *   (b) the logger skips Sentry for 401/403/404       (see use-client-logger.ts)
     *
     * This test pins (b). It also pins that errors WITHOUT a status are
     * still reported — real bugs that lack a `status` field must not be
     * accidentally suppressed by the filter.
     *
     * The composite shape (single `toHaveBeenCalledTimes` + identity-pinned
     * `toHaveBeenCalledWith`) is intentional per CLAUDE.md → "Test Quality":
     * it catches "filter inverted" (would be 0 calls), "filter dropped"
     * (would be 4), "filter widened to 5xx" (1 call but wrong error), and
     * "wrong error survived" (1 call, wrong identity) — all with one
     * setup, no fragmentation. If a future change adds 429 to the skip
     * list, this test breaks loudly until the fixtures are updated, which
     * is the correct forcing function.
     */
    it("filters policy outcomes (401/403/404) but still reports unknown errors", () => {
      setNodeEnv("production");

      const { result } = renderHook(() => useClientLogger(), {
        wrapper: makeWrapper("app-1"),
      });

      const e401 = errorWithStatus("Not authenticated", 401);
      const e403 = errorWithStatus("Forbidden", 403);
      const e404 = errorWithStatus("Not found", 404);
      const eNoStatus = new Error("Something exploded"); // no status field

      act(() => {
        result.current.error(e401, { source: "useTraces" });
        result.current.error(e403, { source: "useTraces" });
        result.current.error(e404, { source: "useTraces" });
        result.current.error(eNoStatus, { source: "useTraces" });
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(eNoStatus);
    });

    /**
     * The OTHER non-bug class: transport-level fetch failures (the request
     * died without an HTTP response — connection drop, navigation/teardown
     * abort, offline blip). At a 5-10s SWR poll cadence every laptop sleep
     * or E2E page teardown would otherwise manufacture a Sentry "error" for
     * what is, in practice, entirely E2E harness reload-aborts.
     * These route to Logtail at `warn` for trend visibility, never Sentry.
     */
    it("routes transport-level fetch failures to Logtail warn, never Sentry", () => {
      setNodeEnv("production");

      const { result } = renderHook(() => useClientLogger(), {
        wrapper: makeWrapper("app-1"),
      });

      const chrome = new TypeError("Failed to fetch");
      const firefox = new TypeError(
        "NetworkError when attempting to fetch resource.",
      );
      const safari = new TypeError("Load failed");
      const abort = new DOMException(
        "The user aborted a request.",
        "AbortError",
      );

      act(() => {
        result.current.error(chrome, { source: "useTraces" });
        result.current.error(firefox, { source: "useTraces" });
        result.current.error(safari, { source: "useTraces" });
        result.current.error(abort as unknown as Error, {
          source: "useTraces",
        });
      });

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logtailMock.warn).toHaveBeenCalledTimes(4);
      expect(logtailMock.warn).toHaveBeenCalledWith(
        "Failed to fetch",
        expect.objectContaining({
          tenantId: "tenant-1",
          userId: "user-1",
          appId: "app-1",
          source: "useTraces",
        }),
      );
    });

    /**
     * tenant is a full-row fetch that only refreshes on auth events; right
     * after a pure-navigation org switch it still names the PREVIOUS org.
     * activeTenant re-derives from the URL on every render and is current —
     * the logged tenantId must come from it, not from a stale tenant object
     * that happens to still be present.
     */
    it("tags logs with the URL-active tenant, not a stale tenant snapshot", () => {
      setNodeEnv("production");
      mockUser = {
        id: "user-1",
        tenant: { tenant_id: "stale-tenant" },
        activeTenant: { tenant_id: "tenant-1" },
      };

      const { result } = renderHook(() => useClientLogger(), {
        wrapper: makeWrapper("app-1"),
      });

      act(() => {
        result.current.error(new TypeError("Failed to fetch"), {
          source: "useTraces",
        });
      });

      expect(logtailMock.warn).toHaveBeenCalledWith(
        "Failed to fetch",
        expect.objectContaining({ tenantId: "tenant-1" }),
      );
    });

    /**
     * The classification is message-keyed, not type-keyed: a TypeError from
     * a real bug (`undefined is not a function` and friends) MUST still page.
     * Kills the `instanceof TypeError → true` mutant.
     */
    it("still reports TypeErrors that are not network failures", () => {
      setNodeEnv("production");

      const { result } = renderHook(() => useClientLogger(), {
        wrapper: makeWrapper("app-1"),
      });
      const realBug = new TypeError(
        "Cannot read properties of undefined (reading 'id')",
      );

      act(() => {
        result.current.error(realBug, { source: "useTraces" });
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(realBug);
      expect(logtailMock.warn).not.toHaveBeenCalled();
    });

    /**
     * Guards against this hook calling `Sentry.setUser({ id })` before
     * capture, clobbering the `{ id, email }` set by auth-provider at login.
     * With the email gone, `tagSentryEvent`'s email-suffix check could never
     * fire, so E2E harness noise would report as real-user production
     * errors. The user scope belongs to auth-provider alone — this hook must
     * never touch it.
     */
    it("never overwrites the Sentry user scope (auth-provider owns { id, email })", () => {
      setNodeEnv("production");

      const { result } = renderHook(() => useClientLogger(), {
        wrapper: makeWrapper("app-1"),
      });

      act(() => {
        result.current.error(new Error("boom"), { source: "useTraces" });
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.setUser).not.toHaveBeenCalled();
    });
  });
});
