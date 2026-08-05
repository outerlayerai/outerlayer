/**
 * validateEnvironmentName — Environments & Promotion.
 *
 * Contract: "Names MUST match the pattern `^[a-z][a-z0-9-]{1,39}$`
 * (2-40 characters, lowercase alphanumeric and hyphens, must start with a
 * letter)."
 *
 * Returns a discriminated union so callers can branch on success without
 * try/catch. The Postgres CHECK constraint on environment.name enforces the
 * same pattern; this helper is the early-return path before any DB write
 * ("Inputs failing the pattern ... MUST be rejected at
 * the API boundary with a clear validation error before any state is written").
 */

/**
 * Env-name regex: `^[a-z][a-z0-9-]{1,39}$` — 2-40 chars, lowercase
 * alphanumeric + hyphens, must start with a letter. Exported so other
 * consumers (dashboard form validation, gateway) reference the single source
 * of truth rather than re-declaring the pattern.
 */
export const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export type EnvironmentNameValidation =
  | { valid: true }
  | { valid: false; reason: 'env_name_invalid'; message: string };

export function validateEnvironmentName(name: string): EnvironmentNameValidation {
  if (typeof name !== 'string') {
    return {
      valid: false,
      reason: 'env_name_invalid',
      message: 'Environment name must be a string',
    };
  }

  if (name.length < 2 || name.length > 40) {
    return {
      valid: false,
      reason: 'env_name_invalid',
      message: `Environment name must be 2-40 characters (got ${name.length})`,
    };
  }

  if (!ENV_NAME_PATTERN.test(name)) {
    return {
      valid: false,
      reason: 'env_name_invalid',
      message:
        'Environment name must match ^[a-z][a-z0-9-]{1,39}$ — start with a letter; ' +
        'lowercase letters, digits, and hyphens only',
    };
  }

  return { valid: true };
}
