/**
 * HMAC-SHA256 payload signing, for webhooks.
 *
 * An absent secret is an error, never a default: a substituted constant is not
 * a secret, so "no secret" fails closed rather than signing with one.
 */

const encoder = new TextEncoder();

const SIGNATURE_PREFIX = "sha256=";

export class MissingSignatureSecretError extends Error {
  constructor() {
    super("a non-empty secret is required to sign or verify a payload");
    this.name = "MissingSignatureSecretError";
  }
}

export class MalformedSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSignatureError";
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new MissingSignatureSecretError();
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign", "verify"],
  );
}

export async function createSignature(secret: string, payload: string) {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return `${SIGNATURE_PREFIX}${toHexString(signature)}`;
}

function toHexString(signature: ArrayBuffer) {
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySignature(secret: string, header: string, payload: string) {
  const key = await importHmacKey(secret);

  if (!header.startsWith(SIGNATURE_PREFIX)) {
    throw new MalformedSignatureError(
      `signature header must start with "${SIGNATURE_PREFIX}"`,
    );
  }
  const sigHex = header.slice(SIGNATURE_PREFIX.length);
  // Reject before decoding: `parseInt` yields NaN for a non-hex pair and NaN
  // stores as 0 in a Uint8Array, so a malformed header must not reach
  // `hexToBytes` at all.
  if (sigHex.length === 0 || sigHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(sigHex)) {
    throw new MalformedSignatureError("signature is not an even-length hex string");
  }

  return crypto.subtle.verify("HMAC", key, hexToBytes(sigHex), encoder.encode(payload));
}

function hexToBytes(hex: string) {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);

  let index = 0;
  for (let i = 0; i < hex.length; i += 2) {
    const c = hex.slice(i, i + 2);
    const b = parseInt(c, 16);
    bytes[index] = b;
    index += 1;
  }

  return bytes;
}
