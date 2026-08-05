import { describe, expect, it } from "vitest";

import { init } from "./i18n";
import { localStorageGetItem } from "./utils/storage-available";

// Mirrors the shape the app loads. `auth.forgotPassword.title` is one of the
// strings the forgot-password page renders — the page that surfaced React #418
// ("text content does not match") in production.
const translations = {
  en: {
    auth: {
      forgotPassword: {
        title: "Forgot your password?",
      },
    },
  },
};

describe("locales SSR determinism", () => {
  it("renders real translations during a server render (no window)", () => {
    // The node environment has no `window`/`localStorage`, exactly like a
    // Next.js server render. The previous implementation derived the language
    // from localStorage here, resolved `undefined`, and `t()` returned the key
    // — which diverged from the client's "en" text and threw React #418 on
    // hydration. The fix pins the language to a constant, so server and client
    // produce identical text.
    expect(typeof window).toBe("undefined");

    const i18n = init({ translations });

    expect(i18n.language).toBe("en");
    expect(i18n.t("auth.forgotPassword.title")).toBe("Forgot your password?");
  });

  it("falls back to the provided default when storage is unavailable", () => {
    // Without storage the helper must honor the caller's default rather than
    // returning `undefined` (which is what drove the language to `undefined`
    // server-side above).
    expect(localStorageGetItem("i18nextLng", "en")).toBe("en");
  });
});
