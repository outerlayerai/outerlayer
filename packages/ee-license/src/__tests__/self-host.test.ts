import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { UNLIMITED } from '@repo/tier-config';
import { LICENSE_KEY_PREFIX } from '../license';
import {
  EE_ENTITLEMENT_KEYS,
  isEeEntitlementKey,
  isSelfHostDeployment,
  getSelfHostLicense,
  resolveSelfHostBoolean,
  SELF_HOST_NUMERIC_LIMIT,
  _resetLicenseCacheForTests,
} from '../self-host';

const NOW = new Date('2026-07-10T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

function makeLicense(overrides: Partial<{ iat: number; exp: number }> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const claims = {
    org: 'Acme Corp',
    plan: 'enterprise' as const,
    iat: nowSec - 60,
    exp: nowSec + 30 * 24 * 60 * 60,
    ...overrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const message = `${LICENSE_KEY_PREFIX}.${payloadB64}`;
  const signature = cryptoSign(null, Buffer.from(message, 'ascii'), privateKey);
  return { token: `${message}.${signature.toString('base64url')}`, publicKeyBase64, claims };
}

beforeEach(() => {
  _resetLicenseCacheForTests();
});

describe('isSelfHostDeployment', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', false],
    ['1', false],
    [undefined, false],
    ['', false],
  ])('OUTERLAYER_SELF_HOSTED=%s → %s', async (value, expected) => {
    expect(isSelfHostDeployment({ OUTERLAYER_SELF_HOSTED: value })).toBe(expected);
  });
});

describe('EE entitlement set', () => {
  it('pins the exact EE-gated keys (changing this list is a product decision)', async () => {
    expect(EE_ENTITLEMENT_KEYS).toEqual([
      'custom_roles',
      'app_level_roles',
      'custom_sso',
      'audit_log',
    ]);
  });

  it('classifies keys exactly', async () => {
    expect(isEeEntitlementKey('custom_roles')).toBe(true);
    expect(isEeEntitlementKey('audit_log')).toBe(true);
    expect(isEeEntitlementKey('branching_workflow')).toBe(false);
    expect(isEeEntitlementKey('traces_enabled')).toBe(false);
    expect(isEeEntitlementKey('')).toBe(false);
  });
});

describe('resolveSelfHostBoolean', () => {
  // proves AC-071-01
  // proves AC-071-04
  it('unlicensed: EE keys off, everything else on', async () => {
    expect(resolveSelfHostBoolean('custom_sso', false)).toBe(false);
    expect(resolveSelfHostBoolean('audit_log', false)).toBe(false);
    expect(resolveSelfHostBoolean('branching_workflow', false)).toBe(true);
    expect(resolveSelfHostBoolean('alerts_enabled', false)).toBe(true);
  });

  // proves AC-071-03
  // proves AC-071-09
  it('licensed: everything on, including EE keys', async () => {
    expect(resolveSelfHostBoolean('custom_sso', true)).toBe(true);
    expect(resolveSelfHostBoolean('branching_workflow', true)).toBe(true);
  });
});

describe('SELF_HOST_NUMERIC_LIMIT', () => {
  // proves AC-071-02
  it('is the UNLIMITED sentinel', async () => {
    expect(SELF_HOST_NUMERIC_LIMIT).toBe(UNLIMITED);
  });
});

describe('getSelfHostLicense', () => {
  it('returns the verified license when key + public key are present and valid', async () => {
    const { token, publicKeyBase64, claims } = makeLicense();
    const env = {
      OUTERLAYER_EE_LICENSE_KEY: token,
      OUTERLAYER_EE_PUBLIC_KEY: publicKeyBase64,
    };

    expect(await getSelfHostLicense(env, NOW)).toEqual({ claims, inGrace: false });
  });

  it('returns null with no license key set', async () => {
    const { publicKeyBase64 } = makeLicense();
    expect(await getSelfHostLicense({ OUTERLAYER_EE_PUBLIC_KEY: publicKeyBase64 }, NOW)).toBeNull();
  });

  it('returns null with a license key but no public key (baked key is still null pre-launch)', async () => {
    const { token } = makeLicense();
    expect(await getSelfHostLicense({ OUTERLAYER_EE_LICENSE_KEY: token }, NOW)).toBeNull();
  });

  it('returns null for a tampered token', async () => {
    const { token, publicKeyBase64 } = makeLicense();
    const [p, payload, sig] = token.split('.');
    const forged = `${p}.${payload}${payload!.slice(0, 1) === 'A' ? 'B' : 'A'}.${sig}`;
    expect(
      await getSelfHostLicense(
        { OUTERLAYER_EE_LICENSE_KEY: forged, OUTERLAYER_EE_PUBLIC_KEY: publicKeyBase64 },
        NOW,
      ),
    ).toBeNull();
  });

  it('re-evaluates expiry on every call — a cached valid signature cannot outlive exp', async () => {
    const graceSeconds = 14 * 24 * 60 * 60;
    const { token, publicKeyBase64, claims } = makeLicense({ exp: nowSec + 60 });
    const env = {
      OUTERLAYER_EE_LICENSE_KEY: token,
      OUTERLAYER_EE_PUBLIC_KEY: publicKeyBase64,
    };

    expect(await getSelfHostLicense(env, NOW)).toEqual({ claims, inGrace: false });

    const insideGrace = new Date((claims.exp + 60) * 1000);
    expect(await getSelfHostLicense(env, insideGrace)).toEqual({ claims, inGrace: true });

    const afterGrace = new Date((claims.exp + graceSeconds + 1) * 1000);
    expect(await getSelfHostLicense(env, afterGrace)).toBeNull();
  });
});
