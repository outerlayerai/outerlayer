// @vitest-environment jsdom
/**
 * useFetchErrorNotifier tests — the snackbar policy for SWR list pages.
 *
 * The properties pinned here:
 *  1. Every distinct error reaches the client logger exactly once with its
 *     `source` (the logger owns Sentry-vs-Logtail routing — tested in
 *     use-client-logger.test.tsx; here we only pin the handoff).
 *  2. Transient network failures (aborted/connection-dropped fetches) do NOT toast
 *     while rows are on screen — a background poll heals on the next SWR
 *     tick, and toasting it teaches users to ignore red snackbars. They DO
 *     toast over an empty table, where they're the user's only signal.
 *  3. A persisting error toasts once, not once per poll tick, and re-arms
 *     after the error clears.
 */

import { renderHook } from "@testing-library/react";

// True seams (per apps/tenant-dashboard/CLAUDE.md): notistack and the owned
// useClientLogger hook have stable signatures and are not HTTP boundaries.
// isTransientNetworkFetchError is NOT mocked — the real classifier runs
// against real browser-shaped errors, so these tests also pin the
// classifier ↔ notifier contract.

const enqueueSnackbar = vi.hoisted(() => vi.fn());
vi.mock("notistack", () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("./use-client-logger", () => ({
  // Fresh object per call mirrors the real hook (new identity every render);
  // the stable `loggerError` spy is what the assertions track.
  useClientLogger: () => ({ info: vi.fn(), error: loggerError }),
}));

import { useFetchErrorNotifier } from "./use-fetch-error-notifier";

const networkError = () => new TypeError("Failed to fetch");
const httpError = (message = "Request failed with status 500") =>
  Object.assign(new Error(message), { status: 500 });

type Props = {
  error: Error | null | undefined;
  rowsShown: number;
  source: string;
};

function renderNotifier(initial: Props) {
  return renderHook((props: Props) => useFetchErrorNotifier(props), {
    initialProps: initial,
  });
}

describe("useFetchErrorNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs and toasts an HTTP error even when rows are shown", () => {
    const err = httpError();

    renderNotifier({ error: err, rowsShown: 25, source: "useTraces" });

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(err, { source: "useTraces" });
    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(enqueueSnackbar).toHaveBeenCalledWith(
      "Request failed with status 500",
      { variant: "error" },
    );
  });

  it("logs but does NOT toast a transient network error while rows are shown", () => {
    const err = networkError();

    renderNotifier({ error: err, rowsShown: 25, source: "useTraces" });

    // Still logged — the logger routes it to Logtail, keeping the trend
    // visible. The user just isn't interrupted over a populated table.
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(err, { source: "useTraces" });
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });

  it("toasts a transient network error when the table is empty", () => {
    renderNotifier({ error: networkError(), rowsShown: 0, source: "useSessions" });

    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(enqueueSnackbar).toHaveBeenCalledWith("Failed to fetch", {
      variant: "error",
    });
  });

  it("notifies a persisting error once, then re-arms after it clears", () => {
    const err = httpError();
    const { rerender } = renderNotifier({
      error: err,
      rowsShown: 10,
      source: "useTraces",
    });

    // Same error surfaced again by the next poll tick → no duplicate toast.
    rerender({ error: err, rowsShown: 10, source: "useTraces" });
    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);

    // Error clears (poll healed) → dedupe re-arms.
    rerender({ error: null, rowsShown: 10, source: "useTraces" });
    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);

    // The SAME failure returning later is a new incident → notify again.
    rerender({ error: httpError(), rowsShown: 10, source: "useTraces" });
    expect(enqueueSnackbar).toHaveBeenCalledTimes(2);
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  it("treats a different error message as a new notification without clearing", () => {
    const first = httpError("Request failed with status 500");
    const { rerender } = renderNotifier({
      error: first,
      rowsShown: 10,
      source: "useTraces",
    });

    const second = httpError("Request failed with status 502");
    rerender({ error: second, rowsShown: 10, source: "useTraces" });

    expect(enqueueSnackbar).toHaveBeenCalledTimes(2);
    expect(enqueueSnackbar).toHaveBeenNthCalledWith(
      1,
      "Request failed with status 500",
      { variant: "error" },
    );
    expect(enqueueSnackbar).toHaveBeenNthCalledWith(
      2,
      "Request failed with status 502",
      { variant: "error" },
    );
  });
});
