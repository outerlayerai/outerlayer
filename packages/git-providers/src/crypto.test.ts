import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from './crypto';

/**
 * These tests guard the one property that matters for a shared crypto module
 * used by two independently-deployed services: the wire format must never drift.
 * A change to the salt, iteration count, IV size, or base64 handling would make
 * tokens written by one service (or already stored in prod) undecryptable — the
 * exact cross-service breakage the extraction exists to prevent.
 */

// A fixed key + plaintext, and REAL ciphertexts captured from the two legacy
// copies BEFORE they were replaced by wrappers over this module:
//   - LEGACY_GATEWAY_VECTOR: produced by gateway-core's `atob`/`btoa` path.
//   - LEGACY_DASHBOARD_VECTOR: produced by tenant-dashboard's Node `Buffer`
//     base64 path.
// Both must decrypt with this module — proving it reads already-stored tokens
// from either service regardless of which base64 path wrote them.
const KEY = 'test-fixed-encryption-key-32-bytes-min!!';
const LEGACY_PLAINTEXT = 'glpat-legacy-token-abc123-DEADBEEF';
const LEGACY_GATEWAY_VECTOR =
  '1hzb3TQe2vtuKh2A:OHIXAanOikL+jDC1Uy3wPjMiq+pIpdrt+zN14yHlgXLCk4dGffAhR8u1R5BWT/Xzt1I=';
const LEGACY_DASHBOARD_VECTOR =
  'vGWQhKKb13P7o+3e:gYOUbTFR9+r4r30SYaOUyisjRwaaOy2UK4sB0N5iK16sw35A41axAGLzgKMEOsT2YKA=';

describe('git-providers crypto — wire-format compatibility', () => {
  it('decrypts a legacy ciphertext from the gateway (Workers atob/btoa path)', async () => {
    expect(await decryptToken(LEGACY_GATEWAY_VECTOR, KEY)).toBe(LEGACY_PLAINTEXT);
  });

  it('decrypts a legacy ciphertext from the dashboard (Node Buffer base64 path)', async () => {
    expect(await decryptToken(LEGACY_DASHBOARD_VECTOR, KEY)).toBe(LEGACY_PLAINTEXT);
  });

  it('rejects a legacy ciphertext under the wrong key (auth-tag mismatch)', async () => {
    await expect(decryptToken(LEGACY_GATEWAY_VECTOR, 'a-different-wrong-key-32-bytes-min!!')).rejects.toThrow(
      /Failed to decrypt token/,
    );
  });
});

describe('git-providers crypto — round trip', () => {
  it.each([
    ['ascii token', 'ghp_1234567890abcdefGHIJKLMNOP'],
    ['unicode', 'tökén-🔐-values-Ω'],
    ['long value', 'x'.repeat(4096)],
    ['single char', 'a'],
  ])('encrypt→decrypt is identity for %s', async (_label, plaintext) => {
    const encrypted = await encryptToken(plaintext, KEY);
    expect(encrypted).not.toBe(plaintext); // actually encrypted, not passed through
    expect(await decryptToken(encrypted, KEY)).toBe(plaintext);
  });

  it('produces a fresh random IV each call (ciphertexts differ, both decrypt)', async () => {
    const a = await encryptToken(LEGACY_PLAINTEXT, KEY);
    const b = await encryptToken(LEGACY_PLAINTEXT, KEY);
    expect(a).not.toBe(b);
    expect(await decryptToken(a, KEY)).toBe(LEGACY_PLAINTEXT);
    expect(await decryptToken(b, KEY)).toBe(LEGACY_PLAINTEXT);
  });
});

describe('git-providers crypto — format + edge cases', () => {
  it('emits `base64(iv):base64(ct)` with a 12-byte IV and standard base64', async () => {
    const encrypted = await encryptToken(LEGACY_PLAINTEXT, KEY);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(2);
    expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    // 12-byte IV → 16 base64 chars (no padding needed for a 12-byte input).
    expect(parts[0]).toHaveLength(16);
    expect(atob(parts[0]!)).toHaveLength(12);
  });

  it('round-trips empty string as empty (never stores ciphertext for empty)', async () => {
    expect(await encryptToken('', KEY)).toBe('');
    expect(await decryptToken('', KEY)).toBe('');
  });

  it('throws on a malformed token (missing the ciphertext half)', async () => {
    await expect(decryptToken('only-one-part', KEY)).rejects.toThrow(/Invalid encrypted token format/);
  });

  it('requires a key when there is real work to do', async () => {
    await expect(encryptToken('some-token', '')).rejects.toThrow(/TOKEN_ENCRYPTION_KEY is required/);
    await expect(decryptToken(LEGACY_GATEWAY_VECTOR, '')).rejects.toThrow(/TOKEN_ENCRYPTION_KEY is required/);
  });
});
