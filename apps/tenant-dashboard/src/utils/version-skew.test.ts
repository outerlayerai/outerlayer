// @vitest-environment jsdom
import type { ErrorEvent, EventHint } from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isReactRecoverableError,
  isRscStreamTeardownError,
  isVersionSkewError,
  registerVersionSkewRecovery,
  tagSentryEvent,
} from "./version-skew";

/** jsdom doesn't implement PromiseRejectionEvent — fake the shape our handler reads. */
function dispatchRejection(reason: unknown): Event {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
  return event;
}

describe("isVersionSkewError", () => {
  it("matches the Server Action skew error thrown by Next.js", () => {
    expect(
      isVersionSkewError(new Error("An unexpected response was received from the server.")),
    ).toBe(true);
  });

  it("matches 'Failed to find Server Action' surfaced to the client", () => {
    expect(
      isVersionSkewError(
        new Error('Failed to find Server Action "abc123". This request might be from an older or newer deployment.'),
      ),
    ).toBe(true);
  });

  it("matches stale chunk load failures by message or error name", () => {
    expect(isVersionSkewError(new Error("Loading chunk 4121 failed."))).toBe(true);

    const chunkError = new Error("timeout");
    chunkError.name = "ChunkLoadError";
    expect(isVersionSkewError(chunkError)).toBe(true);
  });

  it("rejects ordinary errors and non-Error reasons", () => {
    expect(isVersionSkewError(new Error("Failed to fetch"))).toBe(false);
    expect(isVersionSkewError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    // Message text inside a plain string must NOT trigger a reload — only real Errors.
    expect(isVersionSkewError("An unexpected response was received from the server.")).toBe(false);
    expect(isVersionSkewError(undefined)).toBe(false);
  });
});

describe("isReactRecoverableError", () => {
  // The exact production message shape observed on staging.
  const minified419 =
    "Minified React error #419; visit https://react.dev/errors/419 for the full message " +
    "or use the non-minified dev environment for full errors and additional helpful warnings.";

  it("matches every minified recoverable code, and only those", () => {
    for (const code of [418, 419, 421, 422, 423]) {
      expect(
        isReactRecoverableError(
          new Error(`Minified React error #${code}; visit https://react.dev/errors/${code}`),
        ),
      ).toBe(true);
    }
    // Neighbouring codes must NOT match: #420 is not in the recoverable set,
    // and #4180 pins the word boundary — "#418" inside a longer number is a
    // different (future) code, not a hydration recovery.
    expect(
      isReactRecoverableError(new Error("Minified React error #420; visit https://react.dev/errors/420")),
    ).toBe(false);
    expect(
      isReactRecoverableError(new Error("Minified React error #4180; visit https://react.dev/errors/4180")),
    ).toBe(false);
  });

  it("matches the dev/unminified text of each recoverable class", () => {
    const devMessages = [
      // 418
      "Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client.",
      // 419
      "The server could not finish this Suspense boundary, likely due to an error during server rendering. Switched to client rendering.",
      // 421
      "This Suspense boundary received an update before it finished hydrating. This caused the boundary to switch to client rendering.",
      // 422
      "There was an error while hydrating but React was able to recover by instead client rendering from the nearest Suspense boundary.",
      // 423
      "There was an error while hydrating but React was able to recover by instead client rendering the entire root.",
    ];

    expect(devMessages.map((m) => isReactRecoverableError(new Error(m)))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("accepts a bare message string — window.onerror reports one when no Error object exists", () => {
    expect(isReactRecoverableError(minified419)).toBe(true);
    expect(isReactRecoverableError("Failed to fetch")).toBe(false);
  });

  it("rejects ordinary errors and non-string, non-Error reasons", () => {
    expect(isReactRecoverableError(new Error("Failed to fetch"))).toBe(false);
    expect(isReactRecoverableError(undefined)).toBe(false);
    expect(isReactRecoverableError(419)).toBe(false);
    // An Error-shaped plain object is not trusted — only real Errors and strings.
    expect(isReactRecoverableError({ message: minified419 })).toBe(false);
    // No String() coercion of arbitrary thrown values: an array whose string
    // form IS the message must still be rejected, not fed to RegExp.test.
    expect(isReactRecoverableError([minified419])).toBe(false);
  });
});

describe("registerVersionSkewRecovery", () => {
  const skewError = () => new Error("An unexpected response was received from the server.");
  let reload: ReturnType<typeof vi.fn>;
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T12:00:00Z"));
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload },
      writable: true,
      configurable: true,
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
    vi.useRealTimers();
  });

  it("reloads once on a skew rejection and suppresses the default handling", () => {
    unregister = registerVersionSkewRecovery();

    const event = dispatchRejection(skewError());

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not reload again within the guard window, but does after it elapses", () => {
    unregister = registerVersionSkewRecovery();

    dispatchRejection(skewError());
    dispatchRejection(skewError());
    expect(reload).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_000);
    dispatchRejection(skewError());
    expect(reload).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    dispatchRejection(skewError());
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("ignores non-skew rejections entirely", () => {
    unregister = registerVersionSkewRecovery();

    const event = dispatchRejection(new Error("Failed to fetch"));

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    // Guard must stay unset so a real skew error afterwards can still reload.
    expect(window.sessionStorage.getItem("am:version-skew-reloaded-at")).toBeNull();
  });

  it("still reloads when sessionStorage is unavailable (fails open)", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    unregister = registerVersionSkewRecovery();

    dispatchRejection(skewError());

    expect(reload).toHaveBeenCalledTimes(1);
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("stops handling after unregister", () => {
    const cleanup = registerVersionSkewRecovery();
    cleanup();

    dispatchRejection(skewError());

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("tagSentryEvent", () => {
  const skewError = new Error("An unexpected response was received from the server.");
  const ordinaryError = new Error("Failed to fetch");
  const reactRecoverableError = new Error(
    "Minified React error #419; visit https://react.dev/errors/419 for the full message",
  );

  const makeEvent = (overrides: Partial<ErrorEvent> = {}): ErrorEvent =>
    (({
      ...overrides
    }) as ErrorEvent);
  const hintFor = (reason: unknown): EventHint => ({ originalException: reason });

  it("keeps a report whose automatic recovery is exhausted at error level", () => {
    // The point of the whole reload budget is this alert: two reloads ran and the
    // bundle is still broken. The exception underneath is an ordinary chunk-load
    // failure, so without the marker it would be downgraded to `warning` and
    // tagged as a self-healing condition — filed as the opposite of what happened,
    // and below the level that pages anyone.
    const event = makeEvent({
      level: "error",
      tags: { route: "/dashboard" },
      contexts: { metadata: { unrecoveredSkew: true, automaticRecovery: "exhausted" } },
    });

    const tagged = tagSentryEvent(event, hintFor(skewError));

    expect(tagged.level).toBe("error");
    expect(tagged.tags).toEqual({ route: "/dashboard", recovery_exhausted: "true" });
  });

  it("keeps an unverifiable-guard report at error level too", () => {
    // No reload was attempted at all here, so "already recovered by an automatic
    // reload" is false in the other direction.
    const event = makeEvent({
      level: "error",
      contexts: {
        metadata: { reloadGuardUnverifiable: true, automaticRecovery: "unverifiable" },
      },
    });

    const tagged = tagSentryEvent(event, hintFor(skewError));

    expect(tagged.level).toBe("error");
    expect(tagged.tags).toEqual({ recovery_exhausted: "true" });
  });

  it("keeps an unrecovered stream-close report at error level, where the user sees a failure", () => {
    // The stream-teardown downgrade assumes the page consuming the stream is
    // gone. When a boundary reports it as unrecovered the page is very much
    // present, showing a card that says it still is not loading.
    const event = makeEvent({
      level: "error",
      contexts: {
        metadata: { reloadableClass: "rsc-stream-closed", automaticRecovery: "exhausted" },
      },
    });

    const tagged = tagSentryEvent(event, hintFor(new Error("Connection closed.")));

    expect(tagged.level).toBe("error");
    expect(tagged.tags).toEqual({ recovery_exhausted: "true" });
  });

  it("still tags E2E traffic on an exhausted-recovery event", () => {
    // Dropping the E2E tag on this path makes harness noise read as real
    // user-facing breakage.
    const event = makeEvent({
      level: "error",
      user: { email: "runner@test.example.com" },
      contexts: { metadata: { automaticRecovery: "exhausted" } },
    });

    const tagged = tagSentryEvent(event, hintFor(skewError));

    expect(tagged.level).toBe("error");
    expect(tagged.tags).toEqual({ recovery_exhausted: "true", is_e2e: "true" });
  });

  it("downgrades version-skew errors to warning and tags them, preserving existing tags", () => {
    const event = makeEvent({ level: "error", tags: { route: "/dashboard" } });

    const result = tagSentryEvent(event, hintFor(skewError));

    expect(result).toBe(event); // never drops the event
    expect(result.level).toBe("warning");
    expect(result.tags).toEqual({ route: "/dashboard", version_skew: "true" });
  });

  it("leaves non-skew errors at their original level and untagged", () => {
    const event = makeEvent({ level: "error", tags: { route: "/dashboard" } });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.level).toBe("error");
    expect(result.tags).toEqual({ route: "/dashboard" });
  });

  it("downgrades React recoverable errors to warning and tags them, preserving existing tags", () => {
    const event = makeEvent({ level: "error", tags: { route: "/platform-admin/users" } });

    const result = tagSentryEvent(event, hintFor(reactRecoverableError));

    expect(result).toBe(event); // never drops the event
    expect(result.level).toBe("warning");
    expect(result.tags).toEqual({
      route: "/platform-admin/users",
      react_recoverable: "true",
    });
  });

  it("tags E2E test-user traffic with is_e2e and keeps existing tags", () => {
    const event = makeEvent({ user: { email: "alice@test.example.com" }, tags: { foo: "bar" } });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({ foo: "bar", is_e2e: "true" });
  });

  it("does not tag real-user traffic as E2E", () => {
    const event = makeEvent({ user: { email: "real@customer.com" }, tags: {} });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({});
  });

  it("matches the test domain only as a suffix, not when merely contained", () => {
    // A spoofed address that *contains* the test domain mid-string must NOT be
    // treated as E2E traffic — endsWith, not includes/startsWith.
    const event = makeEvent({ user: { email: "attacker@test.example.com.evil.com" } });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toBeUndefined();
  });

  /**
   * Platform-admin E2E accounts can't use the test domain — the guard requires
   * @outerlayer.ai — so `createTestPlatformAdmin` mints e2e-<prefix>-<ts> ones.
   * Without this rule their errors page as real-user traffic.
   */
  it("tags platform-admin E2E accounts (e2e-*@outerlayer.ai) with is_e2e", () => {
    const event = makeEvent({
      user: { email: "e2e-changelog-1780874347@outerlayer.ai" },
      tags: { foo: "bar" },
    });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({ foo: "bar", is_e2e: "true" });
  });

  it("tags the seeded platform_admin@outerlayer.ai account with is_e2e", () => {
    const event = makeEvent({ user: { email: "platform_admin@outerlayer.ai" }, tags: {} });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({ is_e2e: "true" });
  });

  it("does not tag real teammate @outerlayer.ai addresses as E2E", () => {
    // Staff share the domain with platform-admin E2E accounts; only the
    // anchored e2e- prefix and the seeded admin may match.
    const staff = tagSentryEvent(
      makeEvent({ user: { email: "teammate@outerlayer.ai" } }),
      hintFor(ordinaryError),
    );
    // ^ anchor: an e2e- that isn't at the start must not match.
    const embedded = tagSentryEvent(
      makeEvent({ user: { email: "not-e2e-x@outerlayer.ai" } }),
      hintFor(ordinaryError),
    );
    // $ anchor: the domain must be the end of the address, not a prefix of
    // a longer (spoofable) one.
    const trailing = tagSentryEvent(
      makeEvent({ user: { email: "e2e-x@outerlayer.ai.evil.com" } }),
      hintFor(ordinaryError),
    );

    expect(staff.tags).toBeUndefined();
    expect(embedded.tags).toBeUndefined();
    expect(trailing.tags).toBeUndefined();
  });

  it("handles an event with no user without throwing", () => {
    const event = makeEvent({ tags: { a: "1" } });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({ a: "1" });
  });

  it("handles a user with no email without throwing", () => {
    const event = makeEvent({ user: { id: "u1" }, tags: {} });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({});
  });

  /**
   * The email-suffix check alone is not enough: events reported through
   * `useClientLogger` can carry `user: { id }` with no email (the hook
   * overwrites the auth-provider scope), which makes E2E harness errors page
   * as real-user errors. The standing fixture org — set as a tag at
   * login — is the fallback that survives every reporting path.
   */
  it("tags is_e2e via the standing E2E org when the user has no email", () => {
    const event = makeEvent({
      user: { id: "u1" },
      tags: { organization_name: "outerlayer-test" },
    });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({
      organization_name: "outerlayer-test",
      is_e2e: "true",
    });
  });

  it("does not tag other organizations as E2E", () => {
    const event = makeEvent({
      user: { id: "u1" },
      tags: { organization_name: "acme-corp" },
    });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.tags).toEqual({ organization_name: "acme-corp" });
  });

  it("requires an exact org match, not a prefix or substring", () => {
    // "outerlayer-test-2" / "my-outerlayer-test" must NOT be treated as the
    // fixture org — Set membership, not startsWith/includes.
    const prefixed = tagSentryEvent(
      makeEvent({ tags: { organization_name: "outerlayer-test-2" } }),
      hintFor(ordinaryError),
    );
    const contained = tagSentryEvent(
      makeEvent({ tags: { organization_name: "my-outerlayer-test" } }),
      hintFor(ordinaryError),
    );

    expect(prefixed.tags).toEqual({ organization_name: "outerlayer-test-2" });
    expect(contained.tags).toEqual({ organization_name: "my-outerlayer-test" });
  });

  it("applies both version_skew and is_e2e tags when both conditions hold", () => {
    const event = makeEvent({ level: "error", user: { email: "qa@test.example.com" } });

    const result = tagSentryEvent(event, hintFor(skewError));

    expect(result.level).toBe("warning");
    expect(result.tags).toEqual({ version_skew: "true", is_e2e: "true" });
  });

  it("applies react_recoverable and is_e2e together for hydration errors from E2E admins", () => {
    const event = makeEvent({ level: "error", user: { email: "e2e-delete-org-123@outerlayer.ai" } });

    const result = tagSentryEvent(event, hintFor(reactRecoverableError));

    expect(result.level).toBe("warning");
    expect(result.tags).toEqual({ react_recoverable: "true", is_e2e: "true" });
  });

  it("downgrades RSC stream teardowns to warning and tags them, preserving existing tags", () => {
    const event = makeEvent({ level: "error", tags: { route: "/orgs/:orgName/apps" } });

    const result = tagSentryEvent(event, hintFor(new Error("Connection closed.")));

    expect(result).toBe(event); // never drops the event
    expect(result.level).toBe("warning");
    expect(result.tags).toEqual({
      route: "/orgs/:orgName/apps",
      rsc_stream_teardown: "true",
    });
  });

  it("tags anonymous ephemeral-e2e-org traffic via the request URL (the harness Sentry event shape)", () => {
    // The real event that paged: anonymous user (error fired before
    // Sentry.setUser), no organization_name tag (set at login, raced by the
    // first navigation) — the page URL is the only E2E signal.
    const event = makeEvent({
      level: "error",
      user: {},
      request: {
        url: "https://stg.outerlayer.ai/orgs/e2e-dashboard-builder-org-1781107714718-10-366yfk/apps",
      },
    });

    const result = tagSentryEvent(event, hintFor(new Error("Connection closed.")));

    expect(result.level).toBe("warning");
    expect(result.tags).toEqual({ rsc_stream_teardown: "true", is_e2e: "true" });
  });

  it("does not tag a real org whose URL merely contains 'e2e' outside the /orgs/e2e- prefix", () => {
    const event = makeEvent({
      level: "error",
      request: { url: "https://stg.outerlayer.ai/orgs/acme-e2e-tools/apps" },
    });

    const result = tagSentryEvent(event, hintFor(ordinaryError));

    expect(result.level).toBe("error");
    expect(result.tags).toBeUndefined();
  });
});

describe("isRscStreamTeardownError", () => {
  it("matches the Flight client's exact rejection, with and without the trailing period", () => {
    expect(isRscStreamTeardownError(new Error("Connection closed."))).toBe(true);
    expect(isRscStreamTeardownError(new Error("Connection closed"))).toBe(true);
  });

  it("matches the mid-chunk variant", () => {
    expect(
      isRscStreamTeardownError(new Error("Connection closed while receiving the message")),
    ).toBe(true);
  });

  it("accepts a bare message string — window.onerror reports one when no Error object exists", () => {
    expect(isRscStreamTeardownError("Connection closed.")).toBe(true);
  });

  it("rejects errors that merely contain the phrase — anchored, not substring", () => {
    expect(
      isRscStreamTeardownError(new Error("WebSocket: Connection closed. Reconnecting…")),
    ).toBe(false);
    expect(isRscStreamTeardownError(new Error("Database connection closed unexpectedly"))).toBe(
      false,
    );
  });

  it("rejects ordinary errors and non-string, non-Error reasons", () => {
    expect(isRscStreamTeardownError(new Error("Failed to fetch"))).toBe(false);
    expect(isRscStreamTeardownError(undefined)).toBe(false);
    expect(isRscStreamTeardownError({ message: "Connection closed." })).toBe(false);
  });
});
