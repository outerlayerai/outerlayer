/**
 * Offline verification of OuterLayer Enterprise license keys.
 *
 * Design constraint: the self-host distribution promises ZERO phone-home, so
 * license verification must be fully local. A license key is an
 * Ed25519-signed token; verification needs only the public key — no network
 * call, air-gap friendly.
 *
 * Token format:  outerlayer_ee_v1.<base64url(payload JSON)>.<base64url(signature)>
 * Signed bytes:  the ASCII string `outerlayer_ee_v1.<base64url(payload JSON)>`
 *
 * Uses WebCrypto (globalThis.crypto.subtle), NOT node:crypto: this module is
 * reachable from client-component import graphs via the entitlement service
 * (which exports client-safe helpers like buildDeniedInfo), and a `node:`
 * scheme import breaks the webpack client compilation outright. WebCrypto
 * bundles cleanly everywhere, is native in Node ≥20, and keeps the verifier
 * Workers-compatible for the day the gateway gates an EE surface. Browsers
 * never actually *call* verify — the license lives server-side — the
 * requirement is only that importing this module is harmless in any bundle.
 */

export const LICENSE_KEY_PREFIX = 'outerlayer_ee_v1';

/**
 * Days after `exp` during which the license still validates (with
 * `inGrace: true`) so a renewal lapse degrades softly instead of flipping
 * features off at midnight. After the window, EE features deactivate —
 * data is never touched.
 */
export const LICENSE_GRACE_DAYS = 14;

/** Max tolerated clock skew for a not-yet-valid (`iat` in the future) key. */
const IAT_SKEW_SECONDS = 5 * 60;

export interface LicenseClaims {
  /** Licensed organization display name (informational). */
  org: string;
  plan: 'enterprise';
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

export interface VerifiedLicense {
  claims: LicenseClaims;
  /** True when past `exp` but inside the LICENSE_GRACE_DAYS window. */
  inGrace: boolean;
}

/**
 * Production license public key (SPKI DER, base64). Intentionally null until
 * the production keypair is minted (OSS-launch checklist item): with no baked
 * key and no OUTERLAYER_EE_PUBLIC_KEY set, no license can validate, so EE
 * features fail CLOSED rather than accidentally open.
 */
export const BAKED_LICENSE_PUBLIC_KEY: string | null = null;

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function base64ToBytes(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64_RE.test(value)) return null;
  // Accept both base64url (token segments) and standard base64 (env-provided
  // public keys) by normalizing the url-safe alphabet first.
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(normalized.replace(/=+$/, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0x7f;
  return bytes;
}

/**
 * WebCrypto handle, typed portably. The runtimes this package must verify on
 * declare the global differently — DOM lib (dashboard) and @types/node ≥ 20
 * put `crypto` on `typeof globalThis`, but Cloudflare's workers-types uses a
 * bare `declare const crypto`, which is NOT a typed `globalThis` property —
 * so a direct `globalThis.crypto` fails to compile there. The runtime lookup
 * is identical everywhere.
 */
function getWebCrypto(): Crypto {
  return (globalThis as unknown as { crypto: Crypto }).crypto;
}

function parseClaims(value: unknown): LicenseClaims | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { org, plan, iat, exp } = record;
  if (typeof org !== 'string' || org.length === 0) return null;
  if (plan !== 'enterprise') return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (exp <= iat) return null;
  return { org, plan, iat, exp };
}

/**
 * Signature + shape check only — no expiry evaluation. Resolves to the parsed
 * claims when the token is well-formed and the Ed25519 signature verifies
 * against `publicKeyBase64` (SPKI DER, base64 or base64url). Split from the
 * time-window check so callers may cache this (expensive, immutable per
 * token) and evaluate the window (time-dependent) on every read.
 */
export async function verifySignedClaims(
  licenseKey: string,
  publicKeyBase64: string,
): Promise<LicenseClaims | null> {
  const parts = licenseKey.split('.');
  if (parts.length !== 3) return null;
  const [prefix = '', payloadB64 = '', signatureB64 = ''] = parts;
  if (prefix !== LICENSE_KEY_PREFIX) return null;

  const payloadBytes = base64ToBytes(payloadB64);
  const signatureBytes = base64ToBytes(signatureB64);
  const publicKeyDer = base64ToBytes(publicKeyBase64);
  if (!payloadBytes || !signatureBytes || !publicKeyDer) return null;

  let signatureValid = false;
  try {
    const publicKey = await getWebCrypto().subtle.importKey(
      'spki',
      publicKeyDer as unknown as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    signatureValid = await getWebCrypto().subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      signatureBytes as unknown as BufferSource,
      asciiBytes(`${prefix}.${payloadB64}`) as unknown as BufferSource,
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  return parseClaims(payload);
}

/**
 * Time-window evaluation for already-verified claims. Null when the license
 * is not yet valid (issued in the future beyond clock skew) or expired past
 * the grace window.
 */
export function evaluateLicenseWindow(
  claims: LicenseClaims,
  now: Date = new Date(),
): VerifiedLicense | null {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.iat > nowSeconds + IAT_SKEW_SECONDS) return null;
  if (nowSeconds < claims.exp) return { claims, inGrace: false };
  const graceEnd = claims.exp + LICENSE_GRACE_DAYS * 24 * 60 * 60;
  if (nowSeconds < graceEnd) return { claims, inGrace: true };
  return null;
}

/**
 * Full offline verification: signature + shape + time window.
 */
export async function verifyLicenseKey(
  licenseKey: string,
  publicKeyBase64: string,
  now: Date = new Date(),
): Promise<VerifiedLicense | null> {
  const claims = await verifySignedClaims(licenseKey, publicKeyBase64);
  if (!claims) return null;
  return evaluateLicenseWindow(claims, now);
}
