import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateApiKey, hashApiKey, DEFAULT_KEY_PREFIX } from './crypto';

// ---------------------------------------------------------------------------
// hashApiKey — the digest is the ONLY thing that must never drift: if its
// algorithm or encoding changes, every stored key silently stops verifying.
// ---------------------------------------------------------------------------

describe('hashApiKey', () => {
  it('matches a known-answer HMAC-SHA256 vector (pins algorithm + hex encoding)', async () => {
    // Independently computed: node crypto.createHmac('sha256', pepper)
    //   .update(plaintext).digest('hex')
    const digest = await hashApiKey(
      'sk_outerlayer_known_answer_vector',
      'test-pepper-value',
    );
    expect(digest).toBe(
      '85df714439e5a3ffe37aa81aaae1bfa419a3230399281c4b27a5306c0a4d470c',
    );
  });

  it('is deterministic for the same plaintext + pepper', async () => {
    const a = await hashApiKey('sk_outerlayer_abc', 'pepper');
    const b = await hashApiKey('sk_outerlayer_abc', 'pepper');
    expect(a).toBe(b);
  });

  it('changes when the pepper changes (the pepper reaches the digest)', async () => {
    const a = await hashApiKey('sk_outerlayer_abc', 'pepper-1');
    const b = await hashApiKey('sk_outerlayer_abc', 'pepper-2');
    expect(a).not.toBe(b);
  });

  it('produces a 64-char lowercase hex string', async () => {
    const digest = await hashApiKey('sk_outerlayer_abc', 'pepper');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on an empty pepper so a misconfigured deploy fails loudly', async () => {
    await expect(hashApiKey('sk_outerlayer_abc', '')).rejects.toThrow(
      /API_KEY_PEPPER is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// generateApiKey
// ---------------------------------------------------------------------------

describe('generateApiKey', () => {
  it('produces a plaintext of prefix + base64url(32 bytes) = 43-char secret', () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith(DEFAULT_KEY_PREFIX)).toBe(true);
    const secret = plaintext.slice(DEFAULT_KEY_PREFIX.length);
    // 32 bytes → 43 base64url chars, no padding.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('derives keyPrefix as prefix + 8 plaintext chars', () => {
    const { plaintext, keyPrefix } = generateApiKey();
    expect(keyPrefix).toBe(plaintext.slice(0, DEFAULT_KEY_PREFIX.length + 8));
    expect(plaintext.startsWith(keyPrefix)).toBe(true);
  });

  it('honors a custom prefix in both plaintext and keyPrefix', () => {
    const { plaintext, keyPrefix } = generateApiKey({ prefix: 'sk_outerlayer_dev_' });
    expect(plaintext.startsWith('sk_outerlayer_dev_')).toBe(true);
    expect(keyPrefix.startsWith('sk_outerlayer_dev_')).toBe(true);
  });

  it('mints apiKeyId as key_ + 24 lowercase hex chars', () => {
    const { apiKeyId } = generateApiKey();
    expect(apiKeyId).toMatch(/^key_[0-9a-f]{24}$/);
  });

  it('is unique across calls (plaintext, apiKeyId both fresh)', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.apiKeyId).not.toBe(b.apiKeyId);
  });
});

// ---------------------------------------------------------------------------
// Deterministic encoding — pin the exact base64url + hex output by feeding a
// known byte sequence through the CSPRNG. Any drift in the encoders or the
// keyPrefix slice math changes one of these exact strings.
// ---------------------------------------------------------------------------

describe('generateApiKey (deterministic bytes)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('encodes 32 secret bytes as base64url and 12 id bytes as hex, exactly', () => {
    // Fill each requested buffer with sequential bytes 0,1,2,… so the output is
    // fully determined (independently: Buffer(...).toString('base64url'/'hex')).
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf: ArrayBufferView | null) => {
      const arr = new Uint8Array(buf!.buffer, buf!.byteOffset, buf!.byteLength);
      for (let i = 0; i < arr.length; i += 1) arr[i] = i;
      return buf;
    });

    const { plaintext, keyPrefix, apiKeyId } = generateApiKey();

    expect(plaintext).toBe(
      'sk_outerlayer_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
    expect(keyPrefix).toBe('sk_outerlayer_AAECAwQF');
    expect(apiKeyId).toBe('key_000102030405060708090a0b');
  });

  it('base64url output uses the URL-safe alphabet (- and _, no + or /)', () => {
    // Bytes chosen so standard base64 would emit + and / ; base64url must not.
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf: ArrayBufferView | null) => {
      const arr = new Uint8Array(buf!.buffer, buf!.byteOffset, buf!.byteLength);
      // 0xFB 0xFF repeated → base64 '+/' territory.
      for (let i = 0; i < arr.length; i += 1) arr[i] = i % 2 === 0 ? 0xfb : 0xff;
      return buf;
    });

    const { plaintext } = generateApiKey();
    const secret = plaintext.slice(DEFAULT_KEY_PREFIX.length);
    expect(secret).not.toMatch(/[+/=]/);
    expect(secret).toMatch(/[-_]/);
  });
});
