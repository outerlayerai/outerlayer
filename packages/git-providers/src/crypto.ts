/**
 * Git-token encryption — the AES-256-GCM scheme that protects provider OAuth
 * tokens at rest. Consumed by the Cloudflare-Workers gateway
 * (`@repo/gateway-core`) via a thin wrapper that injects its own encryption
 * key.
 *
 * Runtime-neutral by construction: it uses only web-standard globals
 * (`crypto.subtle`, `atob`/`btoa`, `TextEncoder`/`TextDecoder`) present in
 * both the Workers runtime and Node 18+, and takes the key as an argument so
 * no runtime's env plumbing leaks in.
 *
 * Wire format: `base64(iv):base64(ciphertext‖authTag)` — a 12-byte random IV and
 * the Web Crypto ciphertext (which appends the 16-byte GCM auth tag). Both parts
 * are standard (padded) base64; ':' is safe as a delimiter because it is outside
 * the base64 alphabet.
 */

/** 96-bit IV — the size AES-GCM is defined for. */
const IV_LENGTH = 12;
/** 128-bit GCM authentication tag. */
const AUTH_TAG_LENGTH = 16;
/**
 * Static PBKDF2 salt. Safe to be constant here: the derived key's uniqueness
 * comes entirely from the per-deployment `TOKEN_ENCRYPTION_KEY`. This value is
 * part of the on-disk format — changing it makes every stored token
 * undecryptable, which the wire-compat tests pin.
 */
const PBKDF2_SALT = 'git-token-encryption-salt';
const PBKDF2_ITERATIONS = 100_000;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Built char-by-char (not `String.fromCharCode(...bytes)`) so a long token
  // can't blow the call-stack argument limit on the spread.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

async function deriveKey(encryptionKey: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(PBKDF2_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a token for storage. Returns `''` for an empty input (the callers
 * store empty as empty, never as ciphertext).
 *
 * @param plaintext - the token to encrypt
 * @param encryptionKey - the deployment's `TOKEN_ENCRYPTION_KEY` (must match
 *   across every service that will decrypt the result)
 */
export async function encryptToken(plaintext: string, encryptionKey: string): Promise<string> {
  if (!plaintext) return '';
  if (!encryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required to encrypt a token');
  }

  const key = await deriveKey(encryptionKey);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: AUTH_TAG_LENGTH * 8 },
    key,
    encoder.encode(plaintext),
  );

  const ivBase64 = uint8ArrayToBase64(iv);
  const ciphertextBase64 = uint8ArrayToBase64(new Uint8Array(ciphertext));

  return `${ivBase64}:${ciphertextBase64}`;
}

/**
 * Decrypt a stored token. Returns `''` for an empty input.
 *
 * @param encrypted - the `iv:ciphertext` string produced by {@link encryptToken}
 *   (by any service on the shared scheme, current or historical)
 * @param encryptionKey - the deployment's `TOKEN_ENCRYPTION_KEY`
 * @throws if the format is invalid, or the ciphertext is corrupt / the key is wrong
 */
export async function decryptToken(encrypted: string, encryptionKey: string): Promise<string> {
  if (!encrypted) return '';
  if (!encryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required to decrypt a token');
  }

  const [ivBase64, ciphertextBase64] = encrypted.split(':');
  if (!ivBase64 || !ciphertextBase64) {
    throw new Error('Invalid encrypted token format');
  }

  const key = await deriveKey(encryptionKey);
  const iv = base64ToUint8Array(ivBase64);
  const ciphertext = base64ToUint8Array(ciphertextBase64);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: AUTH_TAG_LENGTH * 8 },
      key,
      ciphertext,
    );
  } catch (cause) {
    const wrappedError = new Error('Failed to decrypt token: ciphertext invalid or key mismatch');
    (wrappedError as Error & { cause?: unknown }).cause = cause;
    throw wrappedError;
  }

  return new TextDecoder().decode(decrypted);
}
