/**
 * `@repo/git-providers` — shared git-provider logic that both the gateway and
 * the dashboard depend on, so the cross-service invariant (token wire format)
 * lives in exactly one place.
 */
export { encryptToken, decryptToken } from './crypto';
