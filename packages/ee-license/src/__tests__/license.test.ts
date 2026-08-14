import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  LICENSE_KEY_PREFIX,
  LICENSE_GRACE_DAYS,
  verifyLicenseKey,
  verifySignedClaims,
  evaluateLicenseWindow,
  type LicenseClaims,
} from '../license';

// Test-only signer. The production signer lives outside this repository —
// only the private key can mint a token this verifier accepts.
function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { privateKey, publicKeyBase64 };
}

function signToken(privateKey: import('node:crypto').KeyObject, payload: unknown): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const message = `${LICENSE_KEY_PREFIX}.${payloadB64}`;
  const signature = cryptoSign(null, Buffer.from(message, 'ascii'), privateKey);
  return `${message}.${signature.toString('base64url')}`;
}

const NOW = new Date('2026-07-10T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

const validClaims: LicenseClaims = {
  org: 'Acme Corp',
  plan: 'enterprise',
  iat: nowSec - 24 * 60 * 60,
  exp: nowSec + 365 * 24 * 60 * 60,
};

describe('verifyLicenseKey', () => {
  it('accepts a validly signed, unexpired token and returns the exact claims', async () => {
    const { privateKey, publicKeyBase64 } = makeKeyPair();
    const token = signToken(privateKey, validClaims);

    expect(await verifyLicenseKey(token, publicKeyBase64, NOW)).toEqual({
      claims: validClaims,
      inGrace: false,
    });
  });

  // proves AC-071-05
  it('rejects a token whose payload was altered after signing', async () => {
    const { privateKey, publicKeyBase64 } = makeKeyPair();
    const token = signToken(privateKey, validClaims);
    const [prefix, , sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...validClaims, org: 'Mallory Inc' }),
      'utf8',
    ).toString('base64url');
    const forged = `${prefix}.${forgedPayload}.${sig}`;

    expect(await verifyLicenseKey(forged, publicKeyBase64, NOW)).toBeNull();
  });

  // proves AC-071-05
  it('rejects a token signed by a different key', async () => {
    const signer = makeKeyPair();
    const other = makeKeyPair();
    const token = signToken(signer.privateKey, validClaims);

    expect(await verifyLicenseKey(token, other.publicKeyBase64, NOW)).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['two segments', 'outerlayer_ee_v1.abc'],
    ['four segments', 'outerlayer_ee_v1.a.b.c'],
    ['wrong prefix', 'outerlayer_ee_v2.a.b'],
    ['non-base64 payload', 'outerlayer_ee_v1.$$$$.aaaa'],
    ['non-base64 signature', 'outerlayer_ee_v1.aaaa.$$$$'],
  ])('rejects malformed token: %s', async (_name, token) => {
    const { publicKeyBase64 } = makeKeyPair();
    expect(await verifyLicenseKey(token, publicKeyBase64, NOW)).toBeNull();
  });

  it('rejects a syntactically valid token whose payload is not JSON', async () => {
    const { privateKey, publicKeyBase64 } = makeKeyPair();
    const payloadB64 = Buffer.from('not json', 'utf8').toString('base64url');
    const message = `${LICENSE_KEY_PREFIX}.${payloadB64}`;
    const signature = cryptoSign(null, Buffer.from(message, 'ascii'), privateKey);
    const token = `${message}.${signature.toString('base64url')}`;

    expect(await verifyLicenseKey(token, publicKeyBase64, NOW)).toBeNull();
  });

  it.each([
    ['missing org', { plan: 'enterprise', iat: 1, exp: 2 }],
    ['empty org', { org: '', plan: 'enterprise', iat: 1, exp: 2 }],
    ['wrong plan', { org: 'A', plan: 'pro', iat: 1, exp: 2 }],
    ['exp before iat', { org: 'A', plan: 'enterprise', iat: 2, exp: 1 }],
    ['exp equals iat', { org: 'A', plan: 'enterprise', iat: 2, exp: 2 }],
    ['non-numeric exp', { org: 'A', plan: 'enterprise', iat: 1, exp: 'never' }],
    ['null payload', null],
    ['array payload', [1, 2]],
  ])('rejects signed-but-invalid claims: %s', async (_name, payload) => {
    const { privateKey, publicKeyBase64 } = makeKeyPair();
    const token = signToken(privateKey, payload);
    expect(await verifyLicenseKey(token, publicKeyBase64, NOW)).toBeNull();
  });

  it('rejects a garbage public key without throwing', async () => {
    const { privateKey } = makeKeyPair();
    const token = signToken(privateKey, validClaims);
    expect(await verifyLicenseKey(token, 'bm90IGEga2V5', NOW)).toBeNull();
  });

  it('accepts a standard-base64 (non-url) public key', async () => {
    const { privateKey, publicKeyBase64 } = makeKeyPair();
    // export() already produces standard base64 with +/ — assert it round-trips.
    const token = signToken(privateKey, validClaims);
    expect((await verifyLicenseKey(token, publicKeyBase64, NOW))?.claims).toEqual(validClaims);
  });
});

describe('evaluateLicenseWindow', () => {
  const graceSeconds = LICENSE_GRACE_DAYS * 24 * 60 * 60;

  it('is valid (not in grace) strictly before exp', async () => {
    const claims = { ...validClaims, exp: nowSec + 1 };
    expect(evaluateLicenseWindow(claims, NOW)).toEqual({ claims, inGrace: false });
  });

  it('enters grace exactly at exp', async () => {
    const claims = { ...validClaims, exp: nowSec };
    expect(evaluateLicenseWindow(claims, NOW)).toEqual({ claims, inGrace: true });
  });

  it('stays in grace one second before the grace window closes', async () => {
    const claims = { ...validClaims, exp: nowSec - graceSeconds + 1 };
    expect(evaluateLicenseWindow(claims, NOW)).toEqual({ claims, inGrace: true });
  });

  // proves AC-071-07
  it('expires exactly when the grace window closes', async () => {
    const claims = { ...validClaims, exp: nowSec - graceSeconds };
    expect(evaluateLicenseWindow(claims, NOW)).toBeNull();
  });

  it('rejects a license issued in the future beyond clock skew', async () => {
    const claims = {
      ...validClaims,
      iat: nowSec + 6 * 60,
      exp: nowSec + 365 * 24 * 60 * 60,
    };
    expect(evaluateLicenseWindow(claims, NOW)).toBeNull();
  });

  it('tolerates a license issued marginally in the future (clock skew)', async () => {
    const claims = {
      ...validClaims,
      iat: nowSec + 4 * 60,
      exp: nowSec + 365 * 24 * 60 * 60,
    };
    expect(evaluateLicenseWindow(claims, NOW)).toEqual({ claims, inGrace: false });
  });
});

describe('verifySignedClaims', () => {
  it('returns claims without evaluating expiry (expired token still parses)', async () => {
    const { privateKey, publicKeyBase64 } = makeKeyPair();
    const expired = { ...validClaims, iat: 1000, exp: 2000 };
    const token = signToken(privateKey, expired);

    expect(await verifySignedClaims(token, publicKeyBase64)).toEqual(expired);
    expect(await verifyLicenseKey(token, publicKeyBase64, NOW)).toBeNull();
  });
});
