/**
 * Self-host entitlement rules:
 *
 *   - An unlicensed self-hosted instance gets every product feature and
 *     unlimited numeric quotas — usage limits are a Cloud concept; there is
 *     no metering on customer infrastructure (and per the zero-telemetry
 *     posture there couldn't honestly be).
 *   - The EE entitlement keys below stay OFF until a valid enterprise
 *     license key is present.
 *   - Cloud deployments never enter this code path: without
 *     OUTERLAYER_SELF_HOSTED=true the tier matrix resolves entitlements
 *     exactly as before.
 */

import { UNLIMITED } from '@repo/tier-config';
import {
  BAKED_LICENSE_PUBLIC_KEY,
  evaluateLicenseWindow,
  verifySignedClaims,
  type LicenseClaims,
  type VerifiedLicense,
} from './license';

/**
 * The entitlement keys gated behind an enterprise license on self-host.
 * Deliberately the compliance set — see ee/README.md for what is and isn't
 * EE and why. Adding a key here is a product decision, not a refactor.
 */
export const EE_ENTITLEMENT_KEYS = [
  'custom_roles',
  'app_level_roles',
  'custom_sso',
  'audit_log',
] as const;

export type EeEntitlementKey = (typeof EE_ENTITLEMENT_KEYS)[number];

export function isEeEntitlementKey(key: string): key is EeEntitlementKey {
  return (EE_ENTITLEMENT_KEYS as readonly string[]).includes(key);
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Self-host mode is an explicit opt-in — the self-host compose/deploy sets
 * OUTERLAYER_SELF_HOSTED=true. Anything else (unset, "1", "TRUE") is treated
 * as Cloud so a typo can never grant unlimited entitlements.
 */
export function isSelfHostDeployment(env: EnvSource = process.env): boolean {
  return env.OUTERLAYER_SELF_HOSTED === 'true';
}

/** Numeric quota on self-host: always unlimited. */
export const SELF_HOST_NUMERIC_LIMIT: number = UNLIMITED;

/**
 * Boolean entitlement on self-host: everything is enabled except the EE set,
 * which requires a license.
 */
export function resolveSelfHostBoolean(key: string, licensed: boolean): boolean {
  if (licensed) return true;
  return !isEeEntitlementKey(key);
}

// Signature verification is immutable per (token, publicKey), so it is cached
// process-wide (as a promise, deduping concurrent verifies); the expiry window
// is re-evaluated on every read so a cached "valid" can never outlive its own
// expiry.
const signedClaimsCache = new Map<string, Promise<LicenseClaims | null>>();

export function _resetLicenseCacheForTests(): void {
  signedClaimsCache.clear();
}

/**
 * Resolve the deployment's enterprise license from the environment.
 * Resolves to null when unlicensed: no key set, no public key available (the
 * baked production key is still null pre-launch), bad signature, or expired
 * past grace. Purely local — never performs network I/O.
 */
export async function getSelfHostLicense(
  env: EnvSource = process.env,
  now: Date = new Date(),
): Promise<VerifiedLicense | null> {
  const licenseKey = env.OUTERLAYER_EE_LICENSE_KEY;
  const publicKey = env.OUTERLAYER_EE_PUBLIC_KEY ?? BAKED_LICENSE_PUBLIC_KEY;
  if (!licenseKey || !publicKey) return null;

  const cacheKey = `${licenseKey}\n${publicKey}`;
  let claimsPromise = signedClaimsCache.get(cacheKey);
  if (claimsPromise === undefined) {
    claimsPromise = verifySignedClaims(licenseKey, publicKey);
    signedClaimsCache.set(cacheKey, claimsPromise);
  }
  const claims = await claimsPromise;
  if (!claims) return null;
  return evaluateLicenseWindow(claims, now);
}
