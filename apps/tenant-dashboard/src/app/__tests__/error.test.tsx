// @vitest-environment jsdom
/**
 * Skew detection and the reload guard, exercised through the real helpers in
 * `../deployment-skew` — the same ones the error boundaries import. An inline
 * copy of the helpers would be free to drift from the source (dropping the
 * `if (!message) return false` guard, say, and throwing on a message-less error
 * where the real code returns false) with no assertion able to see it.
 *
 * Deployment skew = server action IDs and chunk hashes change during a deploy
 * while a client bundle still references the old ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isDeploymentSkewError,
  isRscStreamClosedError,
  inspectReloadGuard,
  markReloadAttempted,
} from "../deployment-skew";

describe("Deployment skew detection", () => {
  let originalSessionStorage: Storage;
  let storage: Record<string, string>;

  beforeEach(() => {
    originalSessionStorage = global.sessionStorage;
    storage = {};
    global.sessionStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((key) => delete storage[key]);
      },
      key: (index: number) => Object.keys(storage)[index] ?? null,
      length: Object.keys(storage).length,
    } as Storage;
  });

  afterEach(() => {
    global.sessionStorage = originalSessionStorage;
  });

  describe("isDeploymentSkewError", () => {
    it("detects an error by the name UnrecognizedActionError", () => {
      const error = new Error("Some message");
      error.name = "UnrecognizedActionError";

      expect(isDeploymentSkewError(error)).toBe(true);
    });

    it('detects the "was not found on the server" message', () => {
      expect(
        isDeploymentSkewError(new Error('Server Action "abc123" was not found on the server')),
      ).toBe(true);
    });

    it('detects the "Server Action ... was not found" message pattern', () => {
      expect(isDeploymentSkewError(new Error('Server Action "xyz789" was not found'))).toBe(true);
    });

    it("detects a ChunkLoadError by name (webpack + Turbopack both set it)", () => {
      // The exact Sentry payload that motivated this: a stale chunk 404s after a
      // deploy and lands in the route error boundary. Reloading fetches the new
      // bundle, so this MUST be treated as recoverable skew, not a hard error.
      const error = new Error(
        "Failed to load chunk /_next/static/chunks/0mcwi1hkp2~5~.js from module 634026",
      );
      error.name = "ChunkLoadError";

      expect(isDeploymentSkewError(error)).toBe(true);
    });

    it("detects a chunk failure by message when the name was lost in re-wrapping", () => {
      // Turbopack's wording, with a generic name — message fallback must catch it.
      expect(
        isDeploymentSkewError(new Error("Failed to load chunk /_next/static/chunks/abc.js")),
      ).toBe(true);
      // webpack's wording.
      expect(isDeploymentSkewError(new Error("Loading chunk 42 failed"))).toBe(true);
    });

    it("detects a failed dynamic import() of a stale module (per browser engine)", () => {
      // Same stale-deploy symptom as a chunk 404, different code path: a
      // dynamic import() of a hashed module the new deploy replaced. None of
      // these set error.name = "ChunkLoadError", so they MUST match by message.
      // The motivating Sentry trace was Safari dropping in-flight module loads.
      expect(isDeploymentSkewError(new Error("Importing a module script failed."))).toBe(true); // Safari
      expect(
        isDeploymentSkewError(new Error("Failed to fetch dynamically imported module: /x.js")),
      ).toBe(true); // Chromium
      expect(
        isDeploymentSkewError(new Error("error loading dynamically imported module: /x.js")),
      ).toBe(true); // Firefox
    });

    it("does NOT detect ordinary errors", () => {
      expect(isDeploymentSkewError(new Error("Database connection failed"))).toBe(false);
    });

    it("does NOT detect errors that only partially match", () => {
      expect(isDeploymentSkewError(new Error("Server returned an error"))).toBe(false);
      expect(isDeploymentSkewError(new Error("Action failed to complete"))).toBe(false);
    });

    it("returns false (does not throw) when the error has no message", () => {
      // Pins the `if (!message) return false` guard: an error object without a
      // message reaches these predicates, and throwing here would take down the
      // boundary that is trying to triage it.
      expect(isDeploymentSkewError({ name: "UnrecognizedActionError" } as Error)).toBe(false);
    });
  });

  describe("reload-loop protection", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports no reload attempted initially", () => {
      expect(inspectReloadGuard()).toEqual({
        readable: true,
        msSinceLastReload: null,
        attempts: 0,
        attemptsExhausted: false,
      });
    });

    it("reports a reload attempted immediately after marking one", () => {
      vi.useFakeTimers();

      markReloadAttempted(0);

      expect(inspectReloadGuard()).toEqual({
        readable: true,
        msSinceLastReload: 0,
        attempts: 1,
        attemptsExhausted: false,
      });
    });

    it("keeps the spent count for the whole TTL, so a late re-failure inside it still counts", () => {
      // A re-failure minutes later is still the same incident while the stamp
      // lives, so the count — not the age — is what says "stop reloading".
      vi.useFakeTimers();
      markReloadAttempted(1);

      vi.advanceTimersByTime(4 * 60_000 + 59_000);

      expect(inspectReloadGuard()).toEqual({
        readable: true,
        msSinceLastReload: 4 * 60_000 + 59_000,
        attempts: 2,
        attemptsExhausted: true,
      });
    });

    it("discards a stamp from the future, so a backwards clock cannot freeze the budget", () => {
      // An NTP correction after the clock ran fast leaves a stamp whose age is
      // negative for as long as the skew lasts. The TTL check compares age
      // upward, so it never fires: the budget would read exhausted throughout,
      // and a genuinely separate deploy in that window would get zero reloads
      // and a report carrying a negative age.
      vi.useFakeTimers();
      sessionStorage.setItem(
        "deployment-skew-reload-attempted",
        `${Date.now() + 10 * 60_000}:2`,
      );

      expect(inspectReloadGuard()).toEqual({
        readable: true,
        msSinceLastReload: null,
        attempts: 0,
        attemptsExhausted: false,
      });
    });

    it("hands back a full budget once the stamp outlives its TTL", () => {
      // A *later* deploy in the same long-lived session must be recoverable — a
      // count that never expired would strand the user on a broken page with a
      // spent budget it earned during an incident that is over.
      vi.useFakeTimers();
      markReloadAttempted(1);

      vi.advanceTimersByTime(5 * 60_000);

      expect(inspectReloadGuard()).toEqual({
        readable: true,
        msSinceLastReload: null,
        attempts: 0,
        attemptsExhausted: false,
      });
    });

    it("exhausts the budget on the second attempt", () => {
      vi.useFakeTimers();
      markReloadAttempted(1);

      expect(inspectReloadGuard().attempts).toBe(2);
      expect(inspectReloadGuard().attemptsExhausted).toBe(true);
    });

    it("counts a bare-timestamp stamp from an older bundle as one spent attempt", () => {
      // Reading a stamp an older bundle wrote is the literal skew case. Treating
      // an unparseable count as "no attempts" would hand a broken deploy a fresh
      // budget on every reload.
      vi.useFakeTimers();
      sessionStorage.setItem("deployment-skew-reload-attempted", String(Date.now()));

      expect(inspectReloadGuard().attempts).toBe(1);
    });

    it("rejects a stamp whose attempt count is below one", () => {
      // A count of 0 or a negative would read as a fresh budget while still
      // looking like a legitimate stamp, so a poisoned or truncated value could
      // hand a broken deploy unlimited reloads. Discard rather than clamp: a
      // stamp we cannot trust is not a stamp.
      vi.useFakeTimers();
      sessionStorage.setItem("deployment-skew-reload-attempted", `${Date.now()}:0`);
      expect(inspectReloadGuard().attempts).toBe(0);
      expect(inspectReloadGuard().msSinceLastReload).toBe(null);

      sessionStorage.setItem("deployment-skew-reload-attempted", `${Date.now()}:-3`);
      expect(inspectReloadGuard().attempts).toBe(0);
      expect(inspectReloadGuard().msSinceLastReload).toBe(null);
    });

    it("treats a non-numeric stored value as 'not reloaded' (no throw)", () => {
      sessionStorage.setItem("deployment-skew-reload-attempted", "true");

      expect(inspectReloadGuard()).toEqual({
        readable: true,
        msSinceLastReload: null,
        attempts: 0,
        attemptsExhausted: false,
      });
    });

    it("records the timestamp and the attempt number under the expected key", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-05T00:00:00Z"));

      markReloadAttempted(1);

      expect(sessionStorage.getItem("deployment-skew-reload-attempted")).toBe(
        `${Date.parse("2026-06-05T00:00:00Z")}:2`,
      );
    });
  });

  describe("isRscStreamClosedError", () => {
    it('detects the exact "Connection closed." message from react-server-dom-turbopack', () => {
      // Motivating Sentry event: billing page, source route-error-boundary,
      // thrown by startReadingFromStream when a Server Action stream closes before
      // the full Flight payload is received.
      expect(isRscStreamClosedError(new Error("Connection closed."))).toBe(true);
    });

    it("requires the exact message — partial matches are not RSC stream close errors", () => {
      expect(isRscStreamClosedError(new Error("Connection closed"))).toBe(false);
      expect(isRscStreamClosedError(new Error("connection closed."))).toBe(false);
      expect(isRscStreamClosedError(new Error("Connection was closed."))).toBe(false);
    });

    it("returns false for unrelated errors", () => {
      expect(isRscStreamClosedError(new Error("Network error"))).toBe(false);
    });

    it("returns false (does not throw) when the error has no message", () => {
      expect(isRscStreamClosedError({} as Error)).toBe(false);
    });
  });

  describe("skew → reload-once flow", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("detects skew, allows two reloads, then suppresses the third", () => {
      vi.useFakeTimers();
      const error = new Error('Server Action "abc123" was not found on the server');

      expect(isDeploymentSkewError(error)).toBe(true);
      const first = inspectReloadGuard();
      expect(first.attemptsExhausted).toBe(false); // first encounter → reload allowed

      markReloadAttempted(first.attempts);
      vi.advanceTimersByTime(1_000);
      const second = inspectReloadGuard();
      expect(second.attemptsExhausted).toBe(false); // budget of two allows this one

      markReloadAttempted(second.attempts);
      vi.advanceTimersByTime(1_000);

      expect(inspectReloadGuard().attemptsExhausted).toBe(true); // third → suppressed
    });
  });
});
