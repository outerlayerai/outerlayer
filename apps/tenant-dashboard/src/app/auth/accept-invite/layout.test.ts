import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../locales/langs/en.json";

// Regression guard: the accept-invite layout once passed
// `title="invitation.title"` — a key that does not exist in en.json — so the
// i18n fallback echoed the raw "invitation.title" string into the heading.
// These tests tie the layout's title prop back to the locale file, so any
// future title that points at a missing key fails here instead of shipping.

const resolveKey = (key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object" && part in (node as object)) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, en);

describe("accept-invite layout i18n title", () => {
  const layoutSource = readFileSync(
    join(__dirname, "layout.tsx"),
    "utf8"
  );

  it("passes a title prop that resolves to a non-empty locale string", () => {
    const match = layoutSource.match(/title="([^"]+)"/);
    expect(match).not.toBeNull();

    const key = match![1]!;
    const value = resolveKey(key);

    // Must resolve to a real string...
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeGreaterThan(0);
    // ...and must NOT be the key echoed back (the original bug's symptom).
    expect(value).not.toBe(key);
  });

  it("does not reference the removed invitation.title key", () => {
    expect(layoutSource).not.toContain("invitation.title");
    expect(resolveKey("invitation.title")).toBeUndefined();
  });

  it("uses a left-panel headline distinct from the card title", () => {
    // The card (ready state) renders auth.acceptInvite.title; the left panel
    // must not duplicate it, or the screen shows the same heading twice.
    expect(layoutSource).not.toContain('title="auth.acceptInvite.title"');
    expect(resolveKey("auth.acceptInvite.welcomeTitle")).toBe(
      "Join your team on OuterLayer"
    );
  });
});
