import { describe, expect, it } from 'vitest';
import { createSignature } from '@repo/shared-utils';
import { signBlobToken, verifyBlobToken, signBlobRefs, type BlobTokenPort } from '../services/blob-tokens';

const SECRET = 'test-oauth-state-secret-at-least-32-chars';
const OTHER_SECRET = 'a-different-secret-that-is-also-32-chars';
const SHA = 'a'.repeat(64);
const NOW = 1_800_000_000;
const at = (t: number) => () => t;

type Binding = { tenantId: string; appId: string; userId: string };
const PORT: BlobTokenPort<Binding> = {
  domain: 'test-blob.v1',
  ttlSeconds: 7200,
  bindingKeys: ['tenantId', 'appId', 'userId'],
};
const CLAIMS = { tenantId: 'tenant-1', appId: 'app-1', userId: 'user-1', sha256: SHA };

describe('signBlobToken / verifyBlobToken', () => {
  it('round-trips every claim and stamps the port default expiry', async () => {
    const token = await signBlobToken(PORT, { secret: SECRET, claims: CLAIMS, now: at(NOW) });
    const result = await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) });

    expect(result).toEqual({ ok: true, claims: { ...CLAIMS, exp: NOW + 7200 } });
  });

  it('expires exactly at exp, not a second later', async () => {
    const token = await signBlobToken(PORT, { secret: SECRET, claims: CLAIMS, ttlSeconds: 60, now: at(NOW) });

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW + 59) })).toEqual({
      ok: true,
      claims: { ...CLAIMS, exp: NOW + 60 },
    });
    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW + 60) })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a token minted under a different secret', async () => {
    const token = await signBlobToken(PORT, { secret: OTHER_SECRET, claims: CLAIMS, now: at(NOW) });

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a payload edited to name another binding field or image', async () => {
    const token = await signBlobToken(PORT, { secret: SECRET, claims: CLAIMS, now: at(NOW) });
    const [payload, signature] = token.split('.') as [string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

    const forgeries = [
      { ...decoded, userId: 'user-2' },
      { ...decoded, appId: 'app-2' },
      { ...decoded, tenantId: 'tenant-2' },
      { ...decoded, sha256: 'b'.repeat(64) },
      { ...decoded, exp: decoded.exp + 86_400 },
    ];

    for (const forged of forgeries) {
      const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
      expect(await verifyBlobToken(PORT, { secret: SECRET, token: tampered, now: at(NOW) })).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
  });

  it('rejects malformed envelopes without throwing', async () => {
    const cases = ['', 'no-dot', 'a.b.c', `${Buffer.from('{}').toString('base64url')}.zzzz`, 'payload.'];

    for (const token of cases) {
      expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects a correctly-signed payload missing a required binding field', async () => {
    const payload = Buffer.from(JSON.stringify({ tenantId: 'tenant-1', appId: 'app-1' })).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('does not accept a signature minted for a different domain over the same payload', async () => {
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, exp: NOW + 600 })).toString('base64url');
    const undomained = await createSignature(SECRET, payload);
    const token = `${payload}.${undomained.slice('sha256='.length)}`;

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('throws on a missing secret rather than signing with a substitute', async () => {
    await expect(signBlobToken(PORT, { secret: '', claims: CLAIMS })).rejects.toThrow(/non-empty secret/);
  });

  it('rejects an empty payload half distinctly from an empty signature half', async () => {
    expect(await verifyBlobToken(PORT, { secret: SECRET, token: '.sig', now: at(NOW) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyBlobToken(PORT, { secret: SECRET, token: 'payload.', now: at(NOW) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a payload with exactly one binding key non-string while the rest are valid', async () => {
    const payload = Buffer.from(
      JSON.stringify({ tenantId: 'tenant-1', appId: 'app-1', userId: 42, sha256: SHA, exp: NOW + 60 }),
    ).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('accepts a payload where every binding key is present and a string', async () => {
    const payload = Buffer.from(
      JSON.stringify({ tenantId: 'tenant-1', appId: 'app-1', userId: 'user-1', sha256: SHA, exp: NOW + 60 }),
    ).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: true,
      claims: { tenantId: 'tenant-1', appId: 'app-1', userId: 'user-1', sha256: SHA, exp: NOW + 60 },
    });
  });

  it('rejects a payload whose exp is a string, not a number, even with valid binding and sha256', async () => {
    const payload = Buffer.from(
      JSON.stringify({ ...CLAIMS, exp: String(NOW + 60) }),
    ).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a payload missing sha256 even with valid binding and a numeric exp', async () => {
    const { sha256: _sha256, ...withoutSha } = CLAIMS;
    const payload = Buffer.from(JSON.stringify({ ...withoutSha, exp: NOW + 60 })).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    expect(await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('round-trips a multi-byte claim value through base64url decode without corruption', async () => {
    const claims = { ...CLAIMS, userId: 'usuário-héllo-日本語' };
    const token = await signBlobToken(PORT, { secret: SECRET, claims, now: at(NOW) });
    const result = await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) });

    expect(result).toEqual({ ok: true, claims: { ...claims, exp: NOW + 7200 } });
  });

  it('round-trips claims of varying serialized length to exercise every base64 padding case', async () => {
    for (const userId of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg']) {
      const claims = { ...CLAIMS, userId };
      const token = await signBlobToken(PORT, { secret: SECRET, claims, now: at(NOW) });
      const result = await verifyBlobToken(PORT, { secret: SECRET, token, now: at(NOW) });
      expect(result).toEqual({ ok: true, claims: { ...claims, exp: NOW + 7200 } });
    }
  });

  it('verifies against a real near-future expiry when no now is supplied', async () => {
    const farFutureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, exp: farFutureExp })).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    const result = await verifyBlobToken(PORT, { secret: SECRET, token });
    expect(result).toEqual({ ok: true, claims: { ...CLAIMS, exp: farFutureExp } });
  });

  it('reports expired against a real past expiry when no now is supplied', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, exp: pastExp })).toString('base64url');
    const signature = await createSignature(SECRET, `${PORT.domain}.${payload}`);
    const token = `${payload}.${signature.slice('sha256='.length)}`;

    const result = await verifyBlobToken(PORT, { secret: SECRET, token });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('signBlobRefs', () => {
  it('gives every image its own hash-bound token, never a raw sha256', async () => {
    const images = [
      { sha256: SHA, mediaType: 'image/png' },
      { sha256: 'b'.repeat(64), mediaType: 'image/jpeg' },
    ];

    const signed = await signBlobRefs(PORT, SECRET, images, {
      tenantId: 'tenant-1',
      appId: 'app-1',
      userId: 'user-1',
    });

    expect(signed.map((i) => ({ sha256: i.sha256, mediaType: i.mediaType }))).toEqual(images);
    for (const ref of signed) {
      const result = await verifyBlobToken(PORT, { secret: SECRET, token: ref.token });
      expect(result.ok && result.claims.sha256).toBe(ref.sha256);
    }
    expect(signed[0]!.token).not.toBe(signed[1]!.token);
  });

  it('returns an empty list for no images', async () => {
    expect(await signBlobRefs(PORT, SECRET, [], { tenantId: 't', appId: 'a', userId: 'u' })).toEqual([]);
  });
});
