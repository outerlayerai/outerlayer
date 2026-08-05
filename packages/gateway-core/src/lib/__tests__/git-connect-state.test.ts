/**
 * git-connect-state — signing + verification tests.
 *
 * The state token is the only CSRF / forgery defense for the OAuth
 * callback. Failure modes that MUST be caught:
 *   - Tampered payload (signature should reject)
 *   - Tampered signature (signature should reject)
 *   - Expired token (TTL should reject)
 *   - Malformed token (no second segment, bad base64) — opaque 400
 *   - Different secret (cross-environment leak) — signature rejects
 *
 * Plus correctness on the happy path: round-tripping payload values
 * exactly, nonce uniqueness, and TTL math.
 */

import { describe, it, expect } from 'vitest';
import {
  signGitConnectState,
  verifyGitConnectState,
  GIT_CONNECT_STATE_TTL_SECONDS,
} from '../git-connect-state';

const SECRET = 'test-secret-at-least-32-characters-long-for-hmac';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('signGitConnectState', () => {
  it('produces a two-segment payload.sig token', async () => {
    const { token } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    // Both segments must be non-empty.
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });

  it('encodes the requested provider + ids into the payload', async () => {
    const { token, payload } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    expect(payload.app_id).toBe(APP_ID);
    expect(payload.tenant_id).toBe(TENANT_ID);
    expect(payload.provider).toBe('github');
    // Verify the token round-trips to the same payload.
    const verified = await verifyGitConnectState({ secret: SECRET, token });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload).toEqual(payload);
    }
  });

  it('defaults TTL to the documented 10-minute window', async () => {
    const fixedNow = 1_700_000_000;
    const { payload } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
      now: () => fixedNow,
    });
    expect(payload.exp).toBe(fixedNow + GIT_CONNECT_STATE_TTL_SECONDS);
  });

  it('honors a caller-supplied ttlSeconds override', async () => {
    const fixedNow = 1_700_000_000;
    const { payload } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
      ttlSeconds: 60,
      now: () => fixedNow,
    });
    expect(payload.exp).toBe(fixedNow + 60);
  });

  it('generates a fresh nonce per call (no replay via reused state)', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () =>
        signGitConnectState({
          secret: SECRET,
          appId: APP_ID,
          tenantId: TENANT_ID,
          provider: 'github',
        }),
      ),
    );
    const nonces = new Set(tokens.map((t) => t.payload.nonce));
    expect(nonces.size).toBe(tokens.length);
  });
});

describe('verifyGitConnectState', () => {
  it('accepts an unmodified token signed with the same secret', async () => {
    const { token } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const result = await verifyGitConnectState({ secret: SECRET, token });
    expect(result.ok).toBe(true);
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const result = await verifyGitConnectState({
      secret: 'a-different-secret-also-at-least-32-chars-long',
      token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with a tampered payload (signature mismatch)', async () => {
    const { token } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    // Flip a single character in the payload segment — signature is now stale.
    const [payloadB64, sigB64] = token.split('.') as [string, string];
    const tampered = payloadB64.slice(0, -1) + (payloadB64.endsWith('A') ? 'B' : 'A') + '.' + sigB64;
    const result = await verifyGitConnectState({ secret: SECRET, token: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with a tampered signature', async () => {
    const { token } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const [payloadB64, sigB64] = token.split('.') as [string, string];
    const flippedSig = sigB64.slice(0, -1) + (sigB64.endsWith('A') ? 'B' : 'A');
    const result = await verifyGitConnectState({
      secret: SECRET,
      token: `${payloadB64}.${flippedSig}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', async () => {
    const past = 1_700_000_000;
    const { token } = await signGitConnectState({
      secret: SECRET,
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
      ttlSeconds: 60,
      now: () => past,
    });
    const result = await verifyGitConnectState({
      secret: SECRET,
      token,
      now: () => past + 120,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it.each([
    ['empty string', ''],
    ['single segment', 'onlypayload'],
    ['three segments (jwt-like)', 'a.b.c'],
    ['empty segments', '.'],
  ] as const)('rejects malformed token: %s', async (_label, token) => {
    const result = await verifyGitConnectState({ secret: SECRET, token });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either malformed (structure) or bad_signature (HMAC mismatch on
      // junk input). Both map to an opaque 400 at the route layer.
      expect(['malformed', 'bad_signature']).toContain(result.reason);
    }
  });

  it('rejects a well-signed payload with structurally invalid fields', async () => {
    // Sign a payload missing required fields. The signature will be valid
    // (we control both ends) but the structural check should reject it.
    const encoder = new TextEncoder();
    const badPayload = btoa(JSON.stringify({ app_id: APP_ID }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(badPayload));
    const sigBytes = new Uint8Array(sig);
    let binary = '';
    for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]!);
    const sigB64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await verifyGitConnectState({
      secret: SECRET,
      token: `${badPayload}.${sigB64}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects a validly-signed payload whose provider tag is not "github" (malformed)', async () => {
    const encoder = new TextEncoder();
    const forgedPayload = {
      app_id: APP_ID,
      tenant_id: TENANT_ID,
      provider: 'other',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: 'deadbeef00112233',
    };
    const payloadB64 = btoa(JSON.stringify(forgedPayload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
    const sigBytes = new Uint8Array(sig);
    let binary = '';
    for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]!);
    const sigB64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await verifyGitConnectState({
      secret: SECRET,
      token: `${payloadB64}.${sigB64}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });
});
