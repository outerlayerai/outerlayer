"use client";

import { useEffect, useRef, useState } from "react";
import { useClientLogger } from "@/hooks/use-client-logger";
import {
  isDeploymentSkewError,
  isRscStreamClosedError,
  inspectReloadGuard,
  isReloadScheduled,
  markReloadAttempted,
  noteReloadScheduled,
} from "@/app/deployment-skew";

/** Long enough for the "Updating…" message to be readable before the reload. */
const RELOAD_DELAY_MS = 500;

/**
 * Reports where the automatic recovery has stopped carry `automaticRecovery` in
 * their metadata, and Sentry's `beforeSend` keys off it to leave the event at
 * `error`. Without that marker these land as `warning`, tagged as a self-healing
 * condition, because the underlying exception still looks like ordinary skew —
 * so the one signal meaning "reloads ran and the bundle is still broken" would
 * be filed as the thing it disproves.
 */

/**
 * Why the automatic recovery gave up, for boundaries to word their prompt
 * honestly. The two cases are not interchangeable: one has not reloaded at all,
 * the other has reloaded and stayed broken, and telling the second user "a new
 * version was released" sends them to refresh for a fix that already failed.
 *
 * Neither prompt may state a deploy as fact. Both are reachable for an aborted
 * React Server Component (RSC) stream with no deploy involved, so the copy says what we know — refreshing
 * may help — rather than inventing a release.
 */
type ManualRefreshReason = "guard-unverifiable" | "reloads-spent";

/**
 * The triage every error boundary owes a caught error: decide whether it is a
 * recoverable transport failure (deployment skew, RSC stream closed mid-flight)
 * that a single reload fixes, or a genuine fault worth reporting.
 *
 * Nested boundaries need this as much as the root one does. A boundary on a
 * route segment catches the error BEFORE it can unwind, so without this triage
 * it shows a crash card for a deploy the user could not have avoided and ships
 * the noise to error reporting — the exact class the root boundary suppresses
 * on purpose.
 *
 * Callers own their own UI: the returned `isReloading` says "render the
 * updating state", `needsManualRefresh` says "the automatic recovery was
 * refused, so tell the user to refresh", and boundaries differ in what chrome
 * they can assume is mounted around them.
 */
export function useErrorBoundaryRecovery(
  error: Error & { digest?: string },
  source: string,
): {
  isReloading: boolean;
  needsManualRefresh: boolean;
  manualRefreshReason: ManualRefreshReason | null;
} {
  const logger = useClientLogger();
  const [isReloading, setIsReloading] = useState(false);
  const [manualRefreshReason, setManualRefreshReason] = useState<ManualRefreshReason | null>(null);
  // `useClientLogger` returns a fresh object every render, so the effect re-runs
  // on any re-render of a boundary that is showing a fault. Without this the
  // same error is reported again on each one.
  const reportedError = useRef<Error | null>(null);

  useEffect(() => {
    const report = (metadata: Record<string, unknown>) => {
      if (reportedError.current === error) return;
      reportedError.current = error;
      logger.error(error, metadata);
    };

    // Both classes are fixed by refetching, so both are reloadable — but only
    // one of them means a deploy happened. An RSC stream can close on a network
    // hiccup or a navigation that aborts it mid-flight, so labelling that as
    // deployment skew would invent broken deploys out of ordinary transport
    // noise, in exactly the signal that exists to detect real ones.
    const isSkew = isDeploymentSkewError(error);
    const isReloadable = isSkew || isRscStreamClosedError(error);

    if (isReloadable) {
      // Someone already took this page load's reload — either another boundary
      // that tripped in the same commit, or this instance before the
      // `setIsReloading` re-render re-ran the effect. Join it: the stamp behind
      // it is our own doing, not evidence that an earlier reload failed, and a
      // crash card would flash for the half-second until the reload fires.
      if (isReloadScheduled()) {
        setIsReloading(true);
        return;
      }

      const guard = inspectReloadGuard();

      // Storage unreadable. Reporting this as unrecovered skew would be a lie —
      // it may well be the user's first — so it carries its own marker, or a
      // storage-partitioned session becomes indistinguishable from a broken
      // deploy in exactly the signal that reversal exists to create. The
      // discriminator separates the user's browser config from our own code
      // exhausting the quota, which are different bugs owned by different people.
      if (!guard.readable) {
        report({
          digest: error.digest,
          source,
          reloadGuardUnverifiable: true,
          guardFailure: "read",
          automaticRecovery: "unverifiable",
        });
        setManualRefreshReason("guard-unverifiable");
        return;
      }

      if (guard.attemptsExhausted) {
        // The incident spent its whole budget and the same class of error came
        // back, so this is a broken deploy rather than skew a reload can fix.
        // Suppressing it would leave the user cycling on "Updating application…"
        // with zero signal anywhere.
        report({
          digest: error.digest,
          source,
          unrecoveredSkew: isSkew,
          reloadableClass: isSkew ? "deployment-skew" : "rsc-stream-closed",
          msSinceLastReload: guard.msSinceLastReload,
          reloadAttempts: guard.attempts,
          automaticRecovery: "exhausted",
        });
        // The stale bundle is proven here — reloads ran and the same chunk is
        // still missing — so `reset()` is the one action that cannot possibly
        // help. It re-renders against that same bundle, and each click throws a
        // fresh Error whose new identity defeats the report dedupe, sending
        // another report per press.
        setManualRefreshReason("reloads-spent");
        return;
      }

      // Only a stamp that actually landed authorizes a reload. A write that is
      // dropped leaves nothing to bound the retry — the next page reads no
      // stamp, reloads again, and loops with no in-memory state surviving to
      // stop it. Show the error instead, which is the bounded failure.
      if (!markReloadAttempted(guard.attempts)) {
        report({
          digest: error.digest,
          source,
          reloadGuardUnverifiable: true,
          guardFailure: "write",
          automaticRecovery: "unverifiable",
        });
        setManualRefreshReason("guard-unverifiable");
        return;
      }

      noteReloadScheduled();
      setIsReloading(true);

      // No cleanup: the reload must survive the unmount that a re-render of
      // the boundary causes, and the attempt budget already bounds the retry.
      setTimeout(() => {
        window.location.reload();
      }, RELOAD_DELAY_MS);

      return;
    }

    report({ digest: error.digest, source });
  }, [error, logger, source]);

  // Derived rather than stored alongside the reason, so the two cannot disagree.
  return { isReloading, needsManualRefresh: manualRefreshReason !== null, manualRefreshReason };
}
