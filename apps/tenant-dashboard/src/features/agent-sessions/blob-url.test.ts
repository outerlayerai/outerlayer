/**
 * Signed transcript-image tokens. These tests pin the properties the blob
 * route leans on: a token is bound to one person, one app, one tenant and one
 * hash, it stops working at `exp`, and nothing about it can be edited without
 * breaking the signature.
 */
import {
  signAgentBlobToken,
  verifyAgentBlobToken,
  signImageRefs,
  AGENT_BLOB_URL_TTL_SECONDS,
} from "./blob-url";

const SECRET = "test-oauth-state-secret-at-least-32-chars";
const OTHER_SECRET = "a-different-secret-that-is-also-32-chars";
const SHA = "a".repeat(64);
const NOW = 1_800_000_000;
const at = (t: number) => () => t;

const CLAIMS = { tenantId: "tenant-1", appId: "app-1", userId: "user-1", sha256: SHA };

describe("signAgentBlobToken / verifyAgentBlobToken", () => {
  it("round-trips every claim and stamps the default two-hour expiry", async () => {
    const token = await signAgentBlobToken({ secret: SECRET, claims: CLAIMS, now: at(NOW) });
    const result = await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW) });

    // The literal, not the constant: a URL's lifetime is a product decision,
    // so the number is pinned here rather than asserted against itself.
    expect(AGENT_BLOB_URL_TTL_SECONDS).toBe(7200);
    expect(result).toEqual({ ok: true, claims: { ...CLAIMS, exp: NOW + 7200 } });
  });

  it("expires exactly at exp, not a second later", async () => {
    const token = await signAgentBlobToken({
      secret: SECRET,
      claims: CLAIMS,
      ttlSeconds: 60,
      now: at(NOW),
    });

    expect(await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW + 59) })).toEqual({
      ok: true,
      claims: { ...CLAIMS, exp: NOW + 60 },
    });
    expect(await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW + 60) })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a payload edited to name another user, app, tenant, or image", async () => {
    const token = await signAgentBlobToken({ secret: SECRET, claims: CLAIMS, now: at(NOW) });
    const [payload, signature] = token.split(".") as [string, string];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());

    const forgeries = [
      { ...decoded, userId: "user-2" },
      { ...decoded, appId: "app-2" },
      { ...decoded, tenantId: "tenant-2" },
      { ...decoded, sha256: "b".repeat(64) },
      { ...decoded, exp: decoded.exp + 86_400 },
    ];

    for (const forged of forgeries) {
      const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
      expect(await verifyAgentBlobToken({ secret: SECRET, token: tampered, now: at(NOW) })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });

  it("rejects a token minted under a different secret", async () => {
    const token = await signAgentBlobToken({ secret: OTHER_SECRET, claims: CLAIMS, now: at(NOW) });

    expect(await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects malformed envelopes without throwing", async () => {
    const cases = ["", "no-dot", "a.b.c", `${btoa("{}")}.zzzz`, "payload."];

    for (const token of cases) {
      expect(await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW) })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("rejects a correctly-signed payload that is not a claims object", async () => {
    // Signed with the real key and the real domain prefix — only the shape is
    // wrong, so this is the case the structure check exists for.
    const payload = Buffer.from(JSON.stringify({ tenantId: "t" })).toString("base64url");
    const { createSignature } = await import("@repo/shared-utils");
    const signature = await createSignature(SECRET, `agent-blob.v1.${payload}`);
    const token = `${payload}.${signature.slice("sha256=".length)}`;

    expect(await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("does not accept a signature minted for another purpose over the same payload", async () => {
    // The git-connect flow signs the bare payload with the same key. Domain
    // separation is what stops that signature from opening image bytes.
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, exp: NOW + 600 })).toString("base64url");
    const { createSignature } = await import("@repo/shared-utils");
    const undomained = await createSignature(SECRET, payload);
    const token = `${payload}.${undomained.slice("sha256=".length)}`;

    expect(await verifyAgentBlobToken({ secret: SECRET, token, now: at(NOW) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("throws on a missing secret rather than signing with a substitute", async () => {
    await expect(signAgentBlobToken({ secret: "", claims: CLAIMS })).rejects.toThrow(
      /non-empty secret/,
    );
  });
});

describe("signImageRefs", () => {
  it("keeps each ref's fields and gives every image its own hash-bound token", async () => {
    const images = [
      { sha256: SHA, mediaType: "image/png" },
      { sha256: "b".repeat(64), mediaType: "image/jpeg" },
    ];

    const signed = await signImageRefs(SECRET, images, {
      tenantId: "tenant-1",
      appId: "app-1",
      userId: "user-1",
    });

    expect(signed.map((i) => ({ sha256: i.sha256, mediaType: i.mediaType }))).toEqual(images);
    for (const ref of signed) {
      const result = await verifyAgentBlobToken({ secret: SECRET, token: ref.token });
      expect(result.ok && result.claims.sha256).toBe(ref.sha256);
    }
    // The second image's token must not open the first image's bytes.
    const crossed = await verifyAgentBlobToken({ secret: SECRET, token: signed[1]!.token });
    expect(crossed.ok && crossed.claims.sha256).not.toBe(signed[0]!.sha256);
  });

  it("returns an empty list for a span with no images", async () => {
    expect(
      await signImageRefs(SECRET, [], { tenantId: "t", appId: "a", userId: "u" }),
    ).toEqual([]);
  });
});
