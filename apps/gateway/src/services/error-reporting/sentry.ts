/**
 * Sentry-compatible error-reporting facade (gateway).
 *
 * A drop-in replacement for `import * as Sentry from "@sentry/cloudflare"` at the
 * capture/scope call sites, so services depend on this seam instead of the
 * vendor SDK directly. The actual on/off + self-host toggle lives in the
 * `withSentry` options (see {@link resolveSentryOptions} in ./index): when error
 * reporting is disabled the SDK is initialized with no DSN, so these functions
 * become no-ops automatically — no per-call branching needed here.
 *
 * Only the capture/scope subset the gateway uses is re-exported. SDK lifecycle
 * (`withSentry`, `flush`) stays on the real SDK in the worker entrypoint, which
 * is the one place allowed to import `@sentry/cloudflare` directly.
 */
export {
  captureException,
  setContext,
  setUser,
} from "@sentry/cloudflare";
