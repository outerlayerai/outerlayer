/**
 * resolveErrorReportingConfig — the self-host / no-op toggle.
 *
 * Reads a plain env bag and decides whether error reporting is on, which
 * backend to use, and which DSN to point at. Pure and runtime-agnostic (no
 * `process` access, no Node built-ins) — callers pass the env in, so the same
 * resolver works in the Workers gateway (`env` binding) and the Next.js
 * dashboard (`process.env`).
 *
 * The enabled/backend decision and the vendor-neutral-with-legacy-fallback DSN
 * resolution are delegated to {@link @repo/adapter-config}, the shared toggle
 * layer every migration seam reuses; this module only adds the error-reporting
 * specifics (the env names, the `sentry`/`none` backends, and the legacy
 * BetterStack DSN fallback).
 *
 * ## Vendor-neutral vars (preferred)
 *
 *  - `ERROR_REPORTING_DSN` / `NEXT_PUBLIC_ERROR_REPORTING_DSN` — the Sentry-compatible
 *    DSN. Point it at BetterStack, a self-hosted Sentry, or GlitchTip.
 *  - `ERROR_REPORTING_BACKEND` — `sentry` (default) or `none` (force-disable).
 *  - `ERROR_REPORTING_ENABLED` — explicit `true`/`false` override. When unset,
 *    reporting is enabled iff a DSN is present and the backend isn't `none`.
 *
 * ## Legacy fallback
 *
 * Two BetterStack-specific names also resolve, so a deploy that has not been
 * re-configured keeps reporting: `BETTERSTACK_ERRORS_DSN` (gateway) and
 * `NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN` (dashboard). When a legacy name is the
 * one that supplied the DSN, {@link ErrorReportingConfig.usedLegacyDsn} is set
 * so the caller can emit a one-time deprecation warning (see
 * {@link warnLegacyDsnOnce}).
 */

import {
  resolveNeutralValue,
  resolveToggle,
  warnLegacyOnce,
  resetWarnLatch,
} from "@repo/adapter-config";

export type ErrorReportingBackend = "sentry" | "none";

/** The env names this resolver reads. All optional; all strings (env values). */
export interface ErrorReportingEnv {
  ERROR_REPORTING_ENABLED?: string;
  ERROR_REPORTING_BACKEND?: string;
  ERROR_REPORTING_DSN?: string;
  NEXT_PUBLIC_ERROR_REPORTING_DSN?: string;
  // Legacy fallbacks (deprecated — remove after one release).
  BETTERSTACK_ERRORS_DSN?: string;
  NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN?: string;
}

export interface ErrorReportingConfig {
  /** Whether reporting should run. When false, wire {@link NoOpAdapter}. */
  enabled: boolean;
  /** The resolved DSN, if any. Undefined when nothing is configured. */
  dsn?: string;
  /** The selected backend. `none` always forces `enabled: false`. */
  backend: ErrorReportingBackend;
  /** True when the DSN came from a deprecated `*BETTERSTACK_ERRORS_DSN` name. */
  usedLegacyDsn: boolean;
}

/** Latch key for the shared one-time legacy-DSN deprecation warning. */
const WARN_KEY = "error-reporting";

const BACKENDS = ["sentry", "none"] as const;

/**
 * Resolve the error-reporting config from an env bag.
 *
 * Precedence for the DSN: vendor-neutral names win over legacy ones, and a
 * server-scoped name wins over its `NEXT_PUBLIC_` twin when both are present.
 */
export function resolveErrorReportingConfig(
  env: ErrorReportingEnv
): ErrorReportingConfig {
  const { value: dsn, usedLegacy: usedLegacyDsn } = resolveNeutralValue({
    neutral: [env.ERROR_REPORTING_DSN, env.NEXT_PUBLIC_ERROR_REPORTING_DSN],
    legacy: [
      env.BETTERSTACK_ERRORS_DSN,
      env.NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN,
    ],
  });

  // Default "on iff a DSN exists"; `none` and a missing DSN both clamp to off.
  const { enabled, backend } = resolveToggle<ErrorReportingBackend>({
    enabledOverride: env.ERROR_REPORTING_ENABLED,
    backendValue: env.ERROR_REPORTING_BACKEND,
    backends: BACKENDS,
    offBackend: "none",
    hasConnection: dsn !== undefined,
  });

  return { enabled, dsn, backend, usedLegacyDsn };
}

/**
 * Emit a one-time deprecation warning when a legacy `*BETTERSTACK_ERRORS_DSN`
 * supplied the DSN. Idempotent within a process — safe to call on every
 * resolve. Returns whether it warned (for testability).
 */
export function warnLegacyDsnOnce(config: ErrorReportingConfig): boolean {
  if (!config.usedLegacyDsn) return false;
  return warnLegacyOnce(
    WARN_KEY,
    "[error-reporting] BETTERSTACK_ERRORS_DSN / NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN " +
      "is deprecated; rename to ERROR_REPORTING_DSN / NEXT_PUBLIC_ERROR_REPORTING_DSN. " +
      "The legacy name will be removed in a future release."
  );
}

/** Test-only: reset the one-time legacy-warning latch. @internal */
export function resetLegacyWarningLatch(): void {
  resetWarnLatch(WARN_KEY);
}
