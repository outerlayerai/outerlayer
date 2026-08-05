// @vitest-environment node
//
// Node env (not jsdom): the verify-state module uses TextEncoder + Web
// Crypto at the top level. jsdom doesn't ship TextEncoder by default and
// this file doesn't need DOM APIs.
/**
 * verify-state — dashboard-side OAuth state verification tests.
 *
 * The dashboard's OAuth callback handlers consume signed state tokens
 * minted by the gateway's POST /v1/apps/:appId/git/connect. Drift
 * between mint (gateway) and verify (dashboard) is a class of bug that
 * silently breaks the headless flow — every callback would 400 and
 * users would see "git not connected" with no error in the dashboard.
 *
 * The tests below mint tokens with the same crypto primitives the
 * gateway uses (Web Crypto HMAC-SHA256 over base64url segments) so a
 * format change on either side surfaces here as a failing round-trip.
 */

import { describe, it, expect } from 'vitest';
import {
  verifySignedGitConnectState,
  looksLikeSignedGitConnectState,
  type SignedGitConnectStatePayload,
} from '../verify-state';

const SECRET = 'test-secret-at-least-32-characters-long-for-hmac';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// Local mint helper — mirrors packages/gateway-core/src/lib/git-connect-state.ts
// signGitConnectState. Duplicated so the test exercises the wire format
// directly without coupling to the gateway package.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintToken(
  payload: SignedGitConnectStatePayload,
  secret: string,
): Promise<string> {
  const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

function makePayload(overrides: Partial<SignedGitConnectStatePayload> = {}): SignedGitConnectStatePayload {
  return {
    app_id: APP_ID,
    tenant_id: TENANT_ID,
    provider: 'github',
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: 'deadbeef00112233',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifySignedGitConnectState — happy path', () => {
  it('accepts a token signed with the same secret and round-trips the payload', async () => {
    const original = makePayload();
    const token = await mintToken(original, SECRET);

    const result = await verifySignedGitConnectState({ secret: SECRET, token });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(original);
  });

});

describe('verifySignedGitConnectState — provider tag', () => {
  it('rejects a payload whose provider tag is not "github" (malformed)', async () => {
    const forged = { ...makePayload(), provider: 'other' } as unknown as SignedGitConnectStatePayload;
    const token = await mintToken(forged, SECRET);
    const result = await verifySignedGitConnectState({ secret: SECRET, token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });
});

describe('verifySignedGitConnectState — rejection paths', () => {
  it('rejects a token signed with a different secret', async () => {
    const token = await mintToken(makePayload(), SECRET);
    const result = await verifySignedGitConnectState({
      secret: 'different-secret-also-at-least-32-chars-long',
      token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with a tampered payload', async () => {
    const token = await mintToken(makePayload(), SECRET);
    const [p, s] = token.split('.') as [string, string];
    const tampered = p.slice(0, -1) + (p.endsWith('A') ? 'B' : 'A') + '.' + s;
    const result = await verifySignedGitConnectState({ secret: SECRET, token: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with a tampered signature', async () => {
    const token = await mintToken(makePayload(), SECRET);
    const [p, s] = token.split('.') as [string, string];
    const flipped = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    const result = await verifySignedGitConnectState({
      secret: SECRET,
      token: `${p}.${flipped}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', async () => {
    const past = 1_700_000_000;
    const token = await mintToken(makePayload({ exp: past + 60 }), SECRET);
    const result = await verifySignedGitConnectState({
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
    ['three segments', 'a.b.c'],
    ['empty payload segment', '.deadbeef'],
    ['empty sig segment', 'deadbeef.'],
  ] as const)('rejects malformed token (%s)', async (_label, token) => {
    const result = await verifySignedGitConnectState({ secret: SECRET, token });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // malformed or bad_signature — both opaque-400 at the route layer.
      expect(['malformed', 'bad_signature']).toContain(result.reason);
    }
  });

  it('rejects a well-signed but structurally invalid payload', async () => {
    // Mint a token signed with the real secret but missing fields.
    const badPayload = b64url(encoder.encode(JSON.stringify({ app_id: APP_ID })));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(badPayload));
    const token = `${badPayload}.${b64url(sig)}`;

    const result = await verifySignedGitConnectState({ secret: SECRET, token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });
});

describe('looksLikeSignedGitConnectState — format detection', () => {
  it('recognizes a freshly-minted signed token', async () => {
    const token = await mintToken(makePayload(), SECRET);
    expect(looksLikeSignedGitConnectState(token)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['legacy github format', '11111111-1111-1111-1111-111111111111divider/some/redirect'],
    ['legacy unsigned format', 'eyJhcHBJZCI6InRlc3QifQ=='], // base64 of {"appId":"test"}
    ['three segments', 'a.b.c'],
    ['contains slash', 'foo/bar.baz'],
    ['contains plus (legacy base64)', 'fo+o.bar'],
  ] as const)('falls through legacy / invalid inputs (%s)', (_label, input) => {
    expect(looksLikeSignedGitConnectState(input)).toBe(false);
  });
});
