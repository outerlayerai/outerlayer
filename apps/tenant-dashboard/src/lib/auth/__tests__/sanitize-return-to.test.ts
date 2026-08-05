// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  sanitizeReturnTo,
  resolveNextPath,
  requestAllowedOrigins,
} from "../sanitize-return-to";

describe("sanitizeReturnTo — accepts safe relative paths", () => {
  it.each([
    ["/orgs"],
    ["/orgs/my-org"],
    ["/auth/github/callback?installation_id=12345&state=abc.def"],
    ["/orgs/foo-bar/apps/triage"],
    ["/orgs/foo/apps/triage#section"],
  ])("accepts %s", (input) => {
    expect(sanitizeReturnTo(input)).toBe(input);
  });
});

describe("sanitizeReturnTo — blocks unsafe inputs", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["absolute http", "http://evil.example.com/"],
    ["absolute https", "https://evil.example.com/"],
    ["protocol-relative", "//evil.example.com/"],
    ["backslash protocol-relative", "/\\evil.example.com/"],
    ["@-prefix", "/@user"],
    ["colon-prefix", "/:foo"],
    ["space-prefix", "/ foo"],
    ["plus-prefix", "/+foo"],
    ["no leading slash", "orgs"],
    ["javascript URL via no-leading-slash", "javascript:alert(1)"],
  ] as const)("blocks %s", (_label, input) => {
    expect(sanitizeReturnTo(input)).toBeNull();
  });

  it("strips embedded control bytes before re-checking", () => {
    // Null-byte injection — without the strip, `\0//evil.com` could
    // confuse a downstream URL parser into treating the result as
    // protocol-relative even though the leading char is `\0`.
    expect(sanitizeReturnTo("\0//evil.example.com")).toBeNull();
  });

  it("strips control bytes from otherwise-safe paths", () => {
    // Control byte in the middle of a safe path: the byte is stripped
    // and the cleaned string is returned.
    expect(sanitizeReturnTo("/orgs\x01/foo")).toBe("/orgs/foo");
  });
});

describe("resolveNextPath — relative paths", () => {
  const origin = ["https://app.agentmark.co"];

  it("keeps the query string of a relative path", () => {
    // The invite flow depends on this: `/auth/accept-invite` is unusable
    // without its `?id=<membershipId>` param.
    expect(resolveNextPath("/auth/accept-invite?id=abc-123", origin)).toBe(
      "/auth/accept-invite?id=abc-123",
    );
  });

  it("passes through a plain relative path", () => {
    expect(resolveNextPath("/auth/new-password", origin)).toBe("/auth/new-password");
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["protocol-relative", "//evil.example.com/"],
    ["no leading slash", "orgs"],
  ] as const)("falls back on %s", (_label, input) => {
    expect(resolveNextPath(input, origin)).toBe("/");
  });

  it("honors a custom fallback", () => {
    expect(resolveNextPath(null, origin, "/orgs")).toBe("/orgs");
  });
});

describe("resolveNextPath — full URLs (GoTrue RedirectTo shape)", () => {
  const origin = ["https://app.agentmark.co"];

  it("reduces a same-origin URL to path + query", () => {
    expect(
      resolveNextPath("https://app.agentmark.co/auth/accept-invite?id=abc-123", origin),
    ).toBe("/auth/accept-invite?id=abc-123");
  });

  it("accepts a URL matching any of multiple allowed origins", () => {
    // Behind the proxy the request origin and the public x-forwarded-host
    // origin differ; either must validate the emailRedirectTo URL.
    expect(
      resolveNextPath(
        "https://app.agentmark.co/orgs",
        ["http://localhost:3000", "https://app.agentmark.co"],
      ),
    ).toBe("/orgs");
  });

  it.each([
    ["cross-origin host", "https://evil.example.com/auth/accept-invite?id=abc"],
    ["same host, different scheme", "http://app.agentmark.co/orgs"],
    ["userinfo trick", "https://app.agentmark.co@evil.example.com/orgs"],
    ["malformed URL", "https://"],
  ] as const)("falls back on %s", (_label, input) => {
    expect(resolveNextPath(input, origin)).toBe("/");
  });
});

describe("requestAllowedOrigins", () => {
  it("returns only the request origin without a forwarded host", () => {
    expect(requestAllowedOrigins("http://localhost:3000", null)).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("adds the https forwarded-host origin behind the proxy", () => {
    expect(requestAllowedOrigins("http://localhost:3000", "app.agentmark.co")).toEqual([
      "http://localhost:3000",
      "https://app.agentmark.co",
    ]);
  });
});
