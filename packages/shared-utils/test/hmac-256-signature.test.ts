import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createSignature,
  verifySignature,
  MissingSignatureSecretError,
  MalformedSignatureError,
} from "../src/hmac-256-signature";

/** Independent reference implementation to cross-check the WebCrypto one. */
function referenceSignature(secret: string, payload: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

describe("createSignature", () => {
  it("matches an independent HMAC-SHA256 reference (exact hex, lowercase, 64 chars)", async () => {
    const sig = await createSignature("topsecret", "the-payload");
    expect(sig).toBe(referenceSignature("topsecret", "the-payload"));
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("produces different signatures for different payloads under the same secret", async () => {
    const a = await createSignature("k", "a");
    const b = await createSignature("k", "b");
    expect(a).not.toBe(b);
  });
});

describe("verifySignature", () => {
  it("accepts a signature produced for the same secret + payload", async () => {
    const sig = await createSignature("secret", "hello world");
    expect(await verifySignature("secret", sig, "hello world")).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const sig = await createSignature("secret", "hello world");
    expect(await verifySignature("secret", sig, "HELLO WORLD")).toBe(false);
  });

  it("rejects a signature made with a different secret", async () => {
    const sig = await createSignature("secret-a", "msg");
    expect(await verifySignature("secret-b", sig, "msg")).toBe(false);
  });

  it("parses the hex from the part after the algorithm prefix", async () => {
    const hex = createHmac("sha256", "k").update("msg").digest("hex");
    expect(await verifySignature("k", `sha256=${hex}`, "msg")).toBe(true);
  });
});

// A substituted constant is not a secret, so an empty one is refused outright
// rather than standing in for a key.
describe("an empty secret is refused, never defaulted", () => {
  it("createSignature throws instead of signing with a constant", async () => {
    await expect(createSignature("", "payload")).rejects.toThrow(
      MissingSignatureSecretError,
    );
  });

  it("verifySignature throws instead of verifying against a constant", async () => {
    const sig = await createSignature("secret", "msg");
    await expect(verifySignature("", sig, "msg")).rejects.toThrow(
      MissingSignatureSecretError,
    );
  });

  it("refuses a signature keyed on a constant when the secret is unset", async () => {
    await expect(
      verifySignature("", referenceSignature("DEFAULT", "msg"), "msg"),
    ).rejects.toThrow(MissingSignatureSecretError);
  });

  it("treats 'DEFAULT' as an ordinary secret, with no privileged meaning", async () => {
    // It still works when a caller genuinely passes it — it is just a string.
    const sig = await createSignature("DEFAULT", "msg");
    expect(sig).toBe(referenceSignature("DEFAULT", "msg"));
    expect(await verifySignature("DEFAULT", sig, "msg")).toBe(true);
    // ...and it does not verify a signature made under any other secret.
    expect(await verifySignature("DEFAULT", referenceSignature("other", "msg"), "msg")).toBe(
      false,
    );
  });
});

describe("malformed signature headers are refused, not coerced", () => {
  it.each([
    ["no prefix", "abcdef"],
    ["wrong algorithm prefix", "sha1=abcdef"],
    ["empty hex", "sha256="],
    ["odd-length hex", "sha256=abc"],
    // Each non-hex pair parses to NaN, which stores as 0 in a Uint8Array.
    ["non-hex characters", "sha256=zzzz"],
  ])("throws for %s", async (_label, header) => {
    await expect(verifySignature("secret", header, "payload")).rejects.toThrow(
      MalformedSignatureError,
    );
  });

  it("checks the secret before the header, so an unset secret is the reported fault", async () => {
    await expect(verifySignature("", "not-a-signature", "payload")).rejects.toThrow(
      MissingSignatureSecretError,
    );
  });
});
