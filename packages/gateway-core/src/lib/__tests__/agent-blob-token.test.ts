import { describe, it, expect } from 'vitest';
import { signAgentBlobToken, verifyAgentBlobToken, signAgentBlobRefs } from '../agent-blob-token';

const SECRET = 'a'.repeat(32);
const CLAIMS = { tenantId: 'tenant-1', appId: 'app-1', keyId: 'key-1', sha256: 'f'.repeat(64) };

describe('agent blob token', () => {
  it('round-trips a freshly minted token', async () => {
    const token = await signAgentBlobToken({ secret: SECRET, claims: CLAIMS });
    const result = await verifyAgentBlobToken({ secret: SECRET, token });
    expect(result).toEqual({ ok: true, claims: { ...CLAIMS, exp: expect.any(Number) } });
  });

  // proves AC-052-14
  it('denies access after the token expires', async () => {
    let now = 1_000;
    const token = await signAgentBlobToken({ secret: SECRET, claims: CLAIMS, ttlSeconds: 60, now: () => now });
    now += 61;
    const result = await verifyAgentBlobToken({ secret: SECRET, token, now: () => now });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token whose payload was tampered with', async () => {
    const token = await signAgentBlobToken({ secret: SECRET, claims: CLAIMS });
    const [payload, sig] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...CLAIMS, sha256: 'e'.repeat(64), exp: 9_999_999_999 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = await verifyAgentBlobToken({ secret: SECRET, token: `${tamperedPayload}.${sig}` });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    void payload;
  });

  it('rejects a malformed token', async () => {
    const result = await verifyAgentBlobToken({ secret: SECRET, token: 'not-a-token' });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  // proves AC-052-14
  it('signs each image ref with a distinct token bound to the caller — never a raw sha256', async () => {
    const refs = await signAgentBlobRefs(
      SECRET,
      [{ sha256: 'a'.repeat(64), mediaType: 'image/png' }, { sha256: 'b'.repeat(64), mediaType: 'image/jpeg' }],
      { tenantId: 'tenant-1', appId: 'app-1', keyId: 'key-1' },
    );
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(typeof ref.token).toBe('string');
      expect(ref.token.length).toBeGreaterThan(0);
      const verified = await verifyAgentBlobToken({ secret: SECRET, token: ref.token });
      expect(verified.ok && verified.claims.sha256).toBe(ref.sha256);
    }
    expect(refs[0]!.token).not.toBe(refs[1]!.token);
  });
});
