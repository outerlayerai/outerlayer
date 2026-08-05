/**
 * API-key crypto primitives — Web Crypto only (Workers + Node safe).
 *
 * A key is `sk_outerlayer_` + base64url(32 CSPRNG bytes). We never store the
 * plaintext: the keystore holds `hashApiKey(plaintext, pepper)` — a hex
 * HMAC-SHA256 digest peppered with an env secret (OWASP peppering). The digest
 * is deterministic, so the gateway looks a key up by recomputing the digest and
 * hitting a UNIQUE index. 256-bit entropy means no per-key salt is needed.
 *
 * This module imports nothing (passes `check-gateway-core-imports` +
 * `typecheck:workers`).
 */

/** Default plaintext prefix. Callers may override (e.g. dev keys). */
export const DEFAULT_KEY_PREFIX = 'sk_outerlayer_';

/** Number of plaintext characters after the prefix kept in `keyPrefix`. */
const PREFIX_VISIBLE_CHARS = 8;

/**
 * Encode bytes as unpadded base64url. Delegates the base64 alphabet to the
 * `btoa` builtin (present in Workers + Node) and swaps to the URL-safe alphabet,
 * so there is no hand-rolled bit arithmetic to drift.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

export interface GeneratedApiKey {
  /** The full secret shown to the user exactly once. Never persisted. */
  plaintext: string;
  /** Recognizable leading segment (prefix + a few chars) stored for display. */
  keyPrefix: string;
  /** Public, non-secret identifier persisted as api_key.api_key_id. */
  apiKeyId: string;
}

/**
 * Mint a fresh plaintext key, its display prefix, and its public id. Pure
 * CSPRNG — no I/O. The plaintext is the only thing that can produce the digest,
 * so the caller must hand it back to the user immediately and drop it.
 */
export function generateApiKey(opts?: { prefix?: string }): GeneratedApiKey {
  const prefix = opts?.prefix ?? DEFAULT_KEY_PREFIX;

  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = toBase64Url(secretBytes);
  const plaintext = `${prefix}${secret}`;

  const keyPrefix = plaintext.slice(0, prefix.length + PREFIX_VISIBLE_CHARS);

  // Public id: `key_` + 24 hex chars (12 CSPRNG bytes). Distinct from the
  // secret — safe to log, join on, and expose in URLs.
  const idBytes = new Uint8Array(12);
  crypto.getRandomValues(idBytes);
  const apiKeyId = `key_${toHex(idBytes)}`;

  return { plaintext, keyPrefix, apiKeyId };
}

/**
 * Compute the stored digest for a plaintext key: hex HMAC-SHA256(plaintext,
 * pepper). Deterministic — the gateway recomputes it at verify time. Throws on
 * an empty pepper so a misconfigured deploy fails loudly instead of writing
 * unpeppered (effectively plaintext-equivalent) digests.
 */
export async function hashApiKey(plaintext: string, pepper: string): Promise<string> {
  if (!pepper) {
    throw new Error('API_KEY_PEPPER is required to hash an API key');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(plaintext),
  );
  return toHex(new Uint8Array(signature));
}
