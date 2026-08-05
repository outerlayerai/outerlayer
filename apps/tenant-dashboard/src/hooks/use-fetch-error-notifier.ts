"use client";

import { useEffect, useRef } from "react";
import { useSnackbar } from "notistack";

import { useClientLogger } from "./use-client-logger";
import { isTransientNetworkFetchError } from "./shared/api-error";

/**
 * Shared SWR-error notifier for list pages (traces, sessions).
 *
 * Reports every distinct error to the client logger (which owns the
 * Sentry-vs-Logtail routing policy) and toasts it — EXCEPT transient
 * network failures while rows are already on screen: a background poll
 * that lost its connection heals on the next SWR tick, and toasting it
 * over a populated table just teaches users to ignore red snackbars.
 * When the table is empty (initial load failed), the toast is the only
 * signal the user gets, so it always fires.
 *
 * Each distinct error message notifies once until the error clears
 * (SWR re-surfaces the same Error object on every poll while a failure
 * persists; without the dedupe ref the user would get a toast every
 * refresh tick).
 */
export function useFetchErrorNotifier({
  error,
  rowsShown,
  source,
}: {
  error: Error | null | undefined;
  /** Number of rows currently rendered — gates the transient-error toast. */
  rowsShown: number;
  /** Logger metadata, e.g. "useTraces" / "useSessions". */
  source: string;
}): void {
  const { enqueueSnackbar } = useSnackbar();
  const logger = useClientLogger();
  const lastNotifiedError = useRef<string | null>(null);

  useEffect(() => {
    if (error && error.message !== lastNotifiedError.current) {
      lastNotifiedError.current = error.message;
      logger.error(error, { source });
      if (!isTransientNetworkFetchError(error) || rowsShown === 0) {
        enqueueSnackbar(error.message, { variant: "error" });
      }
    }
    if (!error) {
      lastNotifiedError.current = null;
    }
  }, [error, enqueueSnackbar, logger, rowsShown, source]);
}
