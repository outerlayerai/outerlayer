/**
 * resolveToggle — the one decision every adapter seam shares: is this vendor
 * enabled, and which backend should we wire?
 *
 * Pure and runtime-agnostic. The caller reads its own env (a DSN, SMTP host,
 * api key, ...), decides whether a usable connection exists, and hands the raw
 * `<SEAM>_ENABLED` / `<SEAM>_BACKEND` strings in. This function owns the parts
 * that would otherwise be copy-pasted into every seam: backend selection with a
 * default, the explicit-enable override, the "default on iff a connection
 * exists" policy, and the clamp invariant that keeps the init path and the
 * adapter factory from ever disagreeing.
 */

import { parseEnvBoolean } from './primitives';

export interface ToggleSpec<B extends string> {
  /** Raw value of `<SEAM>_ENABLED`. Parsed as a boolean; unrecognised -> unset. */
  enabledOverride?: string;
  /** Raw value of `<SEAM>_BACKEND`. Matched case-insensitively against {@link backends}. */
  backendValue?: string;
  /** Allowed backends (non-empty). `backends[0]` is the default when none/unknown is given. */
  backends: readonly [B, ...B[]];
  /**
   * A backend that means "off". When selected, {@link ToggleResult.enabled} is
   * forced false regardless of every other input (e.g. `none` for errors).
   */
  offBackend?: B;
  /**
   * Whether a usable connection was resolved (DSN present, base URL set, ...).
   * Defaults to `true`. When false, `enabled` is clamped to false — a seam with
   * nothing to point at can never run.
   */
  hasConnection?: boolean;
  /**
   * The default when `<SEAM>_ENABLED` is unset/unrecognised. Defaults to
   * {@link hasConnection} ("on iff a connection exists"), which is what telemetry
   * seams want. Pass `false` for seams that must be opted into explicitly.
   */
  defaultEnabled?: boolean;
}

export interface ToggleResult<B extends string> {
  /** Whether the seam should run. When false, wire the no-op / disabled adapter. */
  enabled: boolean;
  /** The selected backend (always one of {@link ToggleSpec.backends}). */
  backend: B;
}

/** Select the backend: first case-insensitive match in `backends`, else `backends[0]`. */
function selectBackend<B extends string>(
  value: string | undefined,
  backends: readonly [B, ...B[]]
): B {
  const normalized = value?.trim().toLowerCase();
  if (normalized !== undefined && normalized !== '') {
    const match = backends.find((b) => b.toLowerCase() === normalized);
    if (match !== undefined) return match;
  }
  return backends[0];
}

export function resolveToggle<B extends string>(
  spec: ToggleSpec<B>
): ToggleResult<B> {
  const backend = selectBackend(spec.backendValue, spec.backends);
  const hasConnection = spec.hasConnection ?? true;
  const defaultEnabled = spec.defaultEnabled ?? hasConnection;

  const explicitEnabled = parseEnvBoolean(spec.enabledOverride);
  const wantEnabled = explicitEnabled ?? defaultEnabled;

  // Two hard clamps that can only turn the seam OFF: an explicit "off" backend,
  // and the absence of anything to connect to. Keeping them here means a seam's
  // boot path and its adapter factory always reach the same verdict.
  const enabled =
    wantEnabled && backend !== spec.offBackend && hasConnection;

  return { enabled, backend };
}
