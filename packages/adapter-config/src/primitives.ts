/**
 * Env-parsing primitives shared by every adapter seam.
 *
 * Pure and runtime-agnostic — callers pass in already-read env strings, so the
 * same helpers work in the Workers gateway (`env` binding) and the Next.js
 * dashboard (`process.env`). Nothing here reads `process` or touches a Node
 * built-in.
 */

/**
 * Parse an env-string boolean. `true/1/yes/on` -> true, `false/0/no/off/""` ->
 * false (case-insensitive, surrounding whitespace ignored). Anything
 * unrecognised (including `undefined`) returns `undefined` so the caller can
 * fall back to its own default rather than guessing.
 */
export function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/** First non-empty (after trim) string in the list, else undefined. */
export function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** The outcome of resolving a value across vendor-neutral and legacy names. */
export interface NeutralValueResolution {
  /** The resolved value (trimmed), or undefined when nothing was set. */
  value?: string;
  /**
   * True when the value came ONLY from a legacy name (no vendor-neutral name
   * supplied it). Use this to drive a one-time deprecation warning. False when
   * a neutral name supplied the value or when nothing was set at all.
   */
  usedLegacy: boolean;
}

/**
 * Resolve a single config value (a DSN, a base URL, a key, ...) across its
 * vendor-neutral names and a set of deprecated legacy fallbacks.
 *
 * Precedence: the first non-empty vendor-neutral value wins; only if every
 * neutral name is empty do the legacy names apply (again first-non-empty). When
 * the legacy fallback is what supplied the value, {@link NeutralValueResolution.usedLegacy}
 * is set so the caller can warn once and point users at the new name.
 */
export function resolveNeutralValue(opts: {
  neutral: Array<string | undefined>;
  legacy?: Array<string | undefined>;
}): NeutralValueResolution {
  const neutralValue = firstNonEmpty(...opts.neutral);
  if (neutralValue !== undefined) {
    return { value: neutralValue, usedLegacy: false };
  }
  const legacyValue = firstNonEmpty(...(opts.legacy ?? []));
  return { value: legacyValue, usedLegacy: legacyValue !== undefined };
}
