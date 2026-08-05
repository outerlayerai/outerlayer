// Recovery for deployment version skew.
//
// When a new deployment goes live mid-session, the browser is still running
// the previous build's JS. Its Server Action IDs and React Server Component (RSC) payload format no
// longer match the server, so the next action invocation rejects with
// "An unexpected response was received from the server." (Next.js returns a
// 200 HTML re-render instead of a Flight payload when it can't resolve the
// action ID). Stale builds can also fail to lazy-load chunks that no longer
// exist. Neither is recoverable in-place — the only fix is fetching the new
// build, i.e. a full page reload.
//
// Vercel Skew Protection narrows the window where this happens, but sessions
// older than the protection window still hit it. This module is the fallback:
// reload once, guarded against loops.

import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/**
 * Error signatures that indicate the client build no longer matches the
 * deployed server build. The Sentry `beforeSend` hook reuses them via
 * {@link isVersionSkewError} so reported events are tagged consistently.
 */
const VERSION_SKEW_PATTERNS: readonly RegExp[] = [
  // Server Action POST answered with a non-Flight response (action ID from an
  // older deployment).
  /unexpected response was received from the server/i,
  // Server-side variant surfaced to the client.
  /failed to find server action/i,
  // Stale build requesting a chunk that no longer exists.
  /loading chunk [^ ]+ failed/i,
  /chunkloaderror/i,
];

const RELOAD_GUARD_KEY = "am:version-skew-reloaded-at";

/** Minimum gap between automatic reloads. If skew "persists" faster than
 * this, the error is not skew (or the new build is also broken) and reloading
 * again would just loop — let the error propagate to Sentry instead. */
const RELOAD_GUARD_WINDOW_MS = 60_000;

export function isVersionSkewError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const haystack = `${reason.name}: ${reason.message}`;
  return VERSION_SKEW_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * React "recoverable" errors — React already recovered by client-rendering the
 * affected Suspense boundary (or the root), so the user saw at most a flash of
 * fallback UI. React 19 reports them via `onRecoverableError` → `reportError()`
 * → `window.onerror`, so they arrive at Sentry as unhandled error-level events
 * even though nothing crashed. The codes:
 *
 *   418 — hydration mismatch; tree regenerated on the client
 *   419 — server couldn't finish a Suspense boundary; switched to client rendering
 *   421 — boundary updated before it finished hydrating; switched to client rendering
 *   422 — error while hydrating; recovered from the nearest Suspense boundary
 *   423 — error while hydrating; recovered by client-rendering the entire root
 *
 * When the underlying cause is a real SSR exception (the #419 case), the server
 * captures the original error with its digest independently via
 * `onRequestError` in instrumentation.ts — downgrading the client echo loses no
 * signal. Production builds emit "Minified React error #NNN; …"; dev builds
 * emit the full prose, so both forms are matched.
 */
const REACT_RECOVERABLE_PATTERNS: readonly RegExp[] = [
  // Production: "Minified React error #419; visit https://react.dev/errors/419 …"
  /minified react error #4(?:18|19|21|22|23)\b/i,
  // Dev #418: "Hydration failed because the server rendered HTML didn't match …"
  /hydration failed because/i,
  // Dev #422/#423: "There was an error while hydrating but React was able to recover …"
  /error while hydrating/i,
  // Dev #419: "… Switched to client rendering." / #421: "… switch to client rendering."
  /switch(?:ed)? to client rendering/i,
];

/**
 * Unlike {@link isVersionSkewError} (which gates a page reload and therefore
 * only trusts real `Error` instances), this gates pure metadata, so it also
 * accepts plain-string reasons — `window.onerror` delivers a bare message
 * string when no Error object is available (e.g. cross-origin frames).
 */
export function isReactRecoverableError(reason: unknown): boolean {
  let message: string;
  if (reason instanceof Error) {
    message = reason.message;
  } else if (typeof reason === "string") {
    message = reason;
  } else {
    return false;
  }
  return REACT_RECOVERABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * RSC stream teardown — React's Flight client rejects its pending stream
 * reader with "Connection closed." when the connection carrying an RSC
 * payload is severed before the stream finishes (page closed or navigated
 * away mid-stream, network dropped). Nothing crashed from the user's
 * perspective: the page consuming the stream is already gone. The rejection
 * has no handler (it lives inside react-server-dom), so it surfaces through
 * GlobalHandlers as an error-level unhandled rejection.
 *
 * It's never actionable — the message only ever means "the stream outlived
 * the page" — so it's downgraded, not paged on. In practice almost all
 * occurrences are E2E runs closing the browser right after a navigation
 * assertion.
 */
const RSC_STREAM_TEARDOWN_PATTERNS: readonly RegExp[] = [
  // react-server-dom-webpack's exact rejection. Anchored so a library error
  // that merely contains the phrase can't match.
  /^connection closed\.?$/i,
  // Variant emitted when the stream dies mid-chunk.
  /^connection closed while receiving the message\.?$/i,
];

/** Accepts plain-string reasons for the same reason as
 * {@link isReactRecoverableError}: this gates pure metadata. */
export function isRscStreamTeardownError(reason: unknown): boolean {
  let message: string;
  if (reason instanceof Error) {
    message = reason.message;
  } else if (typeof reason === "string") {
    message = reason;
  } else {
    return false;
  }
  return RSC_STREAM_TEARDOWN_PATTERNS.some((pattern) => pattern.test(message));
}

function recentlyReloaded(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < RELOAD_GUARD_WINDOW_MS;
  } catch {
    // sessionStorage unavailable (e.g. blocked storage) — fail open and
    // allow the reload; worst case the browser's own loop detection kicks in.
    return false;
  }
}

function markReloaded(): void {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Ignore — guard is best-effort.
  }
}

/**
 * Listen for unhandled rejections caused by version skew and recover by
 * reloading the page (at most once per {@link RELOAD_GUARD_WINDOW_MS}).
 * Sentry's own GlobalHandlers integration runs independently, so the event
 * is still reported (tagged + downgraded in `beforeSend`) before we reload.
 */
export function registerVersionSkewRecovery(): () => void {
  const handler = (event: PromiseRejectionEvent): void => {
    if (!isVersionSkewError(event.reason)) return;
    if (recentlyReloaded()) return;
    markReloaded();
    // Suppress the default console error — we are handling it.
    event.preventDefault();
    window.location.reload();
  };
  window.addEventListener("unhandledrejection", handler);
  return () => window.removeEventListener("unhandledrejection", handler);
}

/** Email domain used by E2E test accounts. Traffic from these users is tagged
 * (never dropped) so it stays visible as the canary for user-facing breakage. */
const E2E_EMAIL_SUFFIX = "@test.example.com";

/** Platform-admin E2E accounts can't use the test domain — the platform-admin
 * guard requires an allowed company domain — so `createTestPlatformAdmin` (in
 * `apps/e2e`) mints them as `e2e-<prefix>-<timestamp>@outerlayer.ai`, plus the
 * seeded local-dev `platform_admin@outerlayer.ai`. Anchored at both ends so a
 * real teammate address can never match. */
const E2E_PLATFORM_ADMIN_EMAILS: readonly RegExp[] = [
  /^e2e-[^@]*@outerlayer\.ai$/i,
  /^platform_admin@outerlayer\.ai$/i,
];

/** Standing E2E fixture organizations (seeded by `apps/e2e`). Events reported
 * through `useClientLogger` can lack `user.email`, so the org tag — set once
 * at login via `Sentry.setTag("organization_name", …)` in auth-provider — is
 * the fallback that survives every reporting path. */
const E2E_ORG_NAMES: ReadonlySet<string> = new Set(["outerlayer-test"]);

/** Ephemeral E2E orgs are minted per-run as `e2e-<spec>-org-<timestamp>-…`
 * and appear in the page URL (`/orgs/e2e-…/`). Events from these sessions can
 * carry NEITHER a user email (anonymous — error fired before `Sentry.setUser`)
 * NOR the org tag (set at login by auth-provider, racing the first
 * navigation), so the URL captured by HttpContext is the only identifying
 * signal that survives every reporting path. Anchored to the `/orgs/`
 * segment so a real org whose name merely contains "e2e" can't match. */
const E2E_ORG_URL_PATTERN = /\/orgs\/e2e-/i;

/** E2E traffic is identified by a test-account email (test domain, or the
 * platform-admin shapes above), the standing fixture org, OR an ephemeral
 * e2e org in the page URL. The overlapping checks are all needed: email-less
 * events (see use-client-logger.ts) miss the email checks, pre-login flows
 * miss the org tag, and anonymous early-navigation events miss both. */
function isE2eEvent(event: ErrorEvent): boolean {
  const email = event.user?.email;
  if (email?.endsWith(E2E_EMAIL_SUFFIX)) return true;
  if (email && E2E_PLATFORM_ADMIN_EMAILS.some((pattern) => pattern.test(email))) return true;
  const orgName = event.tags?.organization_name;
  if (typeof orgName === "string" && E2E_ORG_NAMES.has(orgName)) return true;
  const url = event.request?.url;
  return typeof url === "string" && E2E_ORG_URL_PATTERN.test(url);
}

/** Marks an event whose reporter says the automatic reload recovery gave up. */
const RECOVERY_EXHAUSTED_TAG = "recovery_exhausted";

/**
 * True when the reporting boundary declared the automatic recovery over, so none
 * of the "already recovered" downgrades apply.
 *
 * The metadata arrives via `Sentry.setContext("metadata", …)`, so it is read from
 * `event.contexts` rather than from the exception — the exception itself carries
 * no trace of how many reloads were spent on it.
 */
function hasExhaustedAutomaticRecovery(event: ErrorEvent): boolean {
  const metadata = event.contexts?.metadata;
  return typeof metadata?.automaticRecovery === "string";
}

/**
 * Sentry `beforeSend` hook. Enriches outgoing events in place and returns them
 * — it never drops an event (always returns `event`):
 *
 * - Version-skew errors are downgraded to `warning` and tagged
 *   `version_skew: "true"`. They're already recovered by an automatic reload
 *   (see {@link registerVersionSkewRecovery}); the tag lets us monitor
 *   frequency without paging on a self-healing condition.
 * - React recoverable errors (hydration / Suspense fallbacks — see
 *   {@link isReactRecoverableError}) are downgraded to `warning` and tagged
 *   `react_recoverable: "true"` for the same reason: React already recovered,
 *   and any real SSR cause is captured server-side with a digest.
 * - RSC stream teardowns ("Connection closed." — see
 *   {@link isRscStreamTeardownError}) are downgraded to `warning` and tagged
 *   `rsc_stream_teardown: "true"`: the page consuming the stream is already
 *   gone, so there is no user-facing failure to act on.
 * - E2E test traffic is tagged `is_e2e: "true"` so it can be filtered in the
 *   dashboard.
 *
 * Every downgrade above rests on the error having been recovered from. An error
 * boundary that reports `automaticRecovery` in its metadata is saying the
 * opposite — its reloads ran out, or it could not verify the guard that bounds
 * them, and the user is looking at a failure right now. Those keep `error` level
 * and are tagged {@link RECOVERY_EXHAUSTED_TAG} instead, because the exception
 * underneath is indistinguishable from the recovered case and would otherwise be
 * filed as the very condition it disproves.
 *
 * Existing tags are preserved (the spreads merge, not replace).
 */
export function tagSentryEvent(event: ErrorEvent, hint: EventHint): ErrorEvent {
  if (hasExhaustedAutomaticRecovery(event)) {
    event.tags = { ...event.tags, [RECOVERY_EXHAUSTED_TAG]: "true" };
    // E2E traffic is still tagged, never dropped: clobbering that tag makes
    // harness noise read as real user-facing breakage.
    if (isE2eEvent(event)) {
      event.tags = { ...event.tags, is_e2e: "true" };
    }
    return event;
  }

  if (isVersionSkewError(hint.originalException)) {
    event.level = "warning";
    event.tags = { ...event.tags, version_skew: "true" };
  }

  if (isReactRecoverableError(hint.originalException)) {
    event.level = "warning";
    event.tags = { ...event.tags, react_recoverable: "true" };
  }

  if (isRscStreamTeardownError(hint.originalException)) {
    event.level = "warning";
    event.tags = { ...event.tags, rsc_stream_teardown: "true" };
  }

  if (isE2eEvent(event)) {
    event.tags = { ...event.tags, is_e2e: "true" };
  }

  return event;
}
