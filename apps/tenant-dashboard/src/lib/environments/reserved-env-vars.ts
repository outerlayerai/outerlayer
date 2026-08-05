/**
 * Reserved environment variable names that are managed by the platform.
 *
 * Users cannot create, edit, or delete env vars with these names: the runtime
 * supplies them when it starts an agent, so a user-set value would be
 * overwritten and the mismatch would surface as a confusing runtime failure
 * rather than a validation error.
 */

const RESERVED_ENV_VARS = [
  "OUTERLAYER_API_KEY",
  "OUTERLAYER_APP_ID",
  "OUTERLAYER_BASE_URL",
  "OUTERLAYER_DISPATCH_SECRET",
  "PORT",
] as const;

/**
 * Returns true if the given key is a platform-reserved env var name.
 */
export function isReservedEnvVar(key: string): boolean {
  return (RESERVED_ENV_VARS as readonly string[]).includes(key);
}

export const RESERVED_ENV_VAR_MESSAGE =
  "This environment variable is managed by the platform and cannot be overridden";
