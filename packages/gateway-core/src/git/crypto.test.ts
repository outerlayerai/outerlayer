/**
 * Unit tests for git token encryption (AES-256-GCM via Web Crypto).
 *
 * These tokens are GitHub OAuth credentials persisted to Supabase, so
 * the security properties matter as much as the round-trip: a wrong key must
 * NOT silently yield garbage, and each encryption must use a fresh IV.
 *
 * Real Web Crypto runs in the Node test env (Node 18+ exposes `crypto`
 * globally) — nothing is mocked here.
 */
import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from './crypto';
import type { Env } from '../types';

const KEY = 'test-encryption-key-0123456789ABCDEF';
const env = (key: string): Env => ({ TOKEN_ENCRYPTION_KEY: key }) as unknown as Env;

describe('git token crypto', () => {
  it('round-trips a token through encrypt → decrypt', async () => {
    const e = env(KEY);
    const cipher = await encryptToken('glpat-super-secret', e);

    // It is genuinely encrypted, not passed through.
    expect(cipher).not.toContain('glpat-super-secret');
    expect(cipher).toContain(':'); // iv:ciphertext envelope
    expect(await decryptToken(cipher, e)).toBe('glpat-super-secret');
  });

  it('treats empty input as a no-op in both directions', async () => {
    const e = env(KEY);
    expect(await encryptToken('', e)).toBe('');
    expect(await decryptToken('', e)).toBe('');
  });

  it('throws on a malformed ciphertext (missing iv:ciphertext separator)', async () => {
    await expect(decryptToken('no-separator-here', env(KEY))).rejects.toThrow(
      'Invalid encrypted token format',
    );
  });

  it('refuses to decrypt with the wrong key instead of returning garbage', async () => {
    // Security property: a key mismatch must fail the GCM auth tag, not
    // silently produce a wrong-but-plausible token.
    const cipher = await encryptToken('glpat-super-secret', env(KEY));
    await expect(decryptToken(cipher, env('a-totally-different-key'))).rejects.toThrow();
  });

  it('uses a fresh random IV per call (identical input → distinct ciphertext)', async () => {
    const e = env(KEY);
    const a = await encryptToken('identical-input', e);
    const b = await encryptToken('identical-input', e);

    expect(a).not.toBe(b); // IV reuse would be a real crypto weakness
    expect(await decryptToken(a, e)).toBe('identical-input');
    expect(await decryptToken(b, e)).toBe('identical-input');
  });
});
