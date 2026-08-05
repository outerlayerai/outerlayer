export {
  LICENSE_KEY_PREFIX,
  LICENSE_GRACE_DAYS,
  BAKED_LICENSE_PUBLIC_KEY,
  verifySignedClaims,
  evaluateLicenseWindow,
  verifyLicenseKey,
  type LicenseClaims,
  type VerifiedLicense,
} from './license';

export {
  EE_ENTITLEMENT_KEYS,
  isEeEntitlementKey,
  isSelfHostDeployment,
  getSelfHostLicense,
  resolveSelfHostBoolean,
  SELF_HOST_NUMERIC_LIMIT,
  _resetLicenseCacheForTests,
  type EeEntitlementKey,
  type EnvSource,
} from './self-host';
