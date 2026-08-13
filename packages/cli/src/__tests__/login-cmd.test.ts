// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLogin,
  LoginConfigError,
  LoginTransportError,
  LoginDeniedError,
  LoginTimeoutError,
} from "../login-cmd.js";
import { cloudConfigPath, type SyncCommandResult } from "../sync-cmd.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-login-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const START_RESPONSE = {
  device_code: "the-device-code",
  user_code: "AAAA-BBBB",
  verification_url: "https://dash.test/device?user_code=AAAA-BBBB",
  expires_in: 600,
  interval: 1,
};

const APPROVED_RESPONSE = {
  status: "approved",
  key: "sk_outerlayer_minted",
  app_id: "app-1",
  base_url: "https://gw.outerlayer.test",
  org_name: "acme",
  app_name: "My App",
};

function fakeSync(): typeof import("../sync-cmd.js").runSync {
  return vi.fn(async (): Promise<SyncCommandResult> => ({
    scanned: 3,
    eligible: 3,
    synced: 3,
    rejected: [],
    blobsSent: 0,
    batches: 1,
    tier: "full",
    url: "https://gw.outerlayer.test",
    dryRun: false,
    output: "",
  }));
}

/** Sequenced fetch stub: first call is /start, subsequent calls are /poll,
 * returning each entry of `pollSequence` in order (repeating the last one
 * if polled more times than provided). */
function fakeFetch(pollSequence: Array<{ status: number; body: unknown }>): typeof fetch {
  let pollIndex = 0;
  return vi.fn(async (url: URL | RequestInfo) => {
    const href = String(url);
    if (href.endsWith("/api/cli/device/start")) {
      return new Response(JSON.stringify(START_RESPONSE), { status: 200 });
    }
    if (href.endsWith("/api/cli/device/poll")) {
      const entry = pollSequence[Math.min(pollIndex, pollSequence.length - 1)]!;
      pollIndex += 1;
      return new Response(JSON.stringify(entry.body), { status: entry.status });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

const noSleep = async () => {};

describe("runLogin — configuration", () => {
  it("throws LoginConfigError when no --url and no OUTERLAYER_DASHBOARD_URL", async () => {
    await expect(runLogin({ home, env: {} })).rejects.toThrow(LoginConfigError);
  });

  it("accepts the URL from OUTERLAYER_DASHBOARD_URL when --url is omitted", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: APPROVED_RESPONSE }]);
    const result = await runLogin({
      home,
      env: { OUTERLAYER_DASHBOARD_URL: "https://dash.test" },
      fetchImpl,
      sleepImpl: noSleep,
      openImpl: vi.fn(),
      syncImpl: fakeSync(),
    });
    expect(result.appId).toBe("app-1");
  });
});

describe("runLogin — happy path", () => {
  it("prints the code, polls through pending states, writes config, and syncs", async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: APPROVED_RESPONSE },
    ]);
    const sync = fakeSync();
    const openImpl = vi.fn();

    const result = await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl, syncImpl: sync });

    expect(result.output).toContain("AAAA-BBBB");
    expect(result.appId).toBe("app-1");
    expect(result.orgName).toBe("acme");
    expect(result.appName).toBe("My App");
    expect(result.configWritten).toBe(true);
    expect(openImpl).toHaveBeenCalledWith(START_RESPONSE.verification_url);

    const config = JSON.parse(readFileSync(cloudConfigPath(home), "utf8"));
    expect(config).toEqual({ url: "https://gw.outerlayer.test", apiKey: "sk_outerlayer_minted", appId: "app-1" });
    expect(statSync(cloudConfigPath(home)).mode & 0o777).toBe(0o600);

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://gw.outerlayer.test", apiKey: "sk_outerlayer_minted", appId: "app-1", quiet: true }),
    );
    expect(result.sync?.synced).toBe(3);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dash.test/api/cli/device/start",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dash.test/api/cli/device/poll",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: "the-device-code" }) },
    );
  });

  it("a browser-open failure does not abort login — the printed URL is the fallback", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: APPROVED_RESPONSE }]);
    const result = await runLogin({
      url: "https://dash.test",
      home,
      fetchImpl,
      sleepImpl: noSleep,
      openImpl: () => {
        throw new Error("no display");
      },
      syncImpl: fakeSync(),
    });
    expect(result.configWritten).toBe(true);
  });

  it("a sync failure is swallowed — login still reports success with no sync result", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: APPROVED_RESPONSE }]);
    const failingSync = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: failingSync });

    expect(result.configWritten).toBe(true);
    expect(result.sync).toBeNull();
    expect(result.output).toContain("first sync will run automatically");
  });
});

describe("runLogin — loopback URL", () => {
  it("does not persist config over a loopback base_url, but still completes and syncs", async () => {
    const loopbackApproved = { ...APPROVED_RESPONSE, base_url: "http://localhost:3000" };
    const fetchImpl = fakeFetch([{ status: 200, body: loopbackApproved }]);
    const sync = fakeSync();

    const result = await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: sync });

    expect(result.configWritten).toBe(false);
    expect(result.output).toContain("not saved");
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ url: "http://localhost:3000" }));
  });
});

describe("runLogin — terminal poll states", () => {
  it("throws LoginDeniedError when the dashboard reports denied, writing no config", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { status: "denied" } }]);
    await expect(
      runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() }),
    ).rejects.toThrow(LoginDeniedError);
    expect(() => readFileSync(cloudConfigPath(home), "utf8")).toThrow();
  });

  it("throws LoginTimeoutError when the code expires mid-poll", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { status: "expired" } }]);
    await expect(
      runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() }),
    ).rejects.toThrow(LoginTimeoutError);
  });

  it("throws LoginTimeoutError immediately when the /start response's own expiry has already passed", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith("/start")) {
        return new Response(JSON.stringify({ ...START_RESPONSE, expires_in: -1 }), { status: 200 });
      }
      throw new Error("poll should never be reached");
    }) as unknown as typeof fetch;

    await expect(
      runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() }),
    ).rejects.toThrow(LoginTimeoutError);
  });

  it("throws LoginTransportError with the server's message on a 402 entitlement denial", async () => {
    const fetchImpl = fakeFetch([{ status: 402, body: { error: "entitlement_denied", message: "API key limit reached" } }]);
    await expect(
      runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() }),
    ).rejects.toThrow("API key limit reached");
  });

  it("throws LoginTransportError when /start itself fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(
      runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() }),
    ).rejects.toThrow(LoginTransportError);
  });

  it("/start failing with a non-200 status throws the exact message and status", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const err = await runLogin({
      url: "https://dash.test",
      home,
      fetchImpl,
      sleepImpl: noSleep,
      openImpl: vi.fn(),
      syncImpl: fakeSync(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginTransportError);
    expect((err as LoginTransportError).message).toBe("Failed to start device login (500)");
    expect((err as LoginTransportError).status).toBe(500);
  });

  it("a non-200, non-402 poll response throws the exact message and status", async () => {
    const fetchImpl = fakeFetch([{ status: 500, body: { error: "internal" } }]);
    const err = await runLogin({
      url: "https://dash.test",
      home,
      fetchImpl,
      sleepImpl: noSleep,
      openImpl: vi.fn(),
      syncImpl: fakeSync(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginTransportError);
    expect((err as LoginTransportError).message).toBe("Poll failed (500)");
    expect((err as LoginTransportError).status).toBe(500);
  });

  it("a 402 poll response with no body message falls back to the literal 'API key limit reached'", async () => {
    const fetchImpl = fakeFetch([{ status: 402, body: { error: "entitlement_denied" } }]);
    const err = await runLogin({
      url: "https://dash.test",
      home,
      fetchImpl,
      sleepImpl: noSleep,
      openImpl: vi.fn(),
      syncImpl: fakeSync(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginTransportError);
    expect((err as LoginTransportError).message).toBe("API key limit reached");
    expect((err as LoginTransportError).status).toBe(402);
  });
});

describe("runLogin — poll backoff", () => {
  it("clamps the poll interval to a 1000ms floor when the server sends a smaller interval", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith("/start")) {
        return new Response(JSON.stringify({ ...START_RESPONSE, interval: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify(APPROVED_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const sleepImpl = vi.fn(async () => {});

    await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl, openImpl: vi.fn(), syncImpl: fakeSync() });

    expect(sleepImpl).toHaveBeenCalledWith(1000);
  });

  it("uses interval*1000ms verbatim when it is above the 1000ms floor", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith("/start")) {
        return new Response(JSON.stringify({ ...START_RESPONSE, interval: 5 }), { status: 200 });
      }
      return new Response(JSON.stringify(APPROVED_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const sleepImpl = vi.fn(async () => {});

    await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl, openImpl: vi.fn(), syncImpl: fakeSync() });

    expect(sleepImpl).toHaveBeenCalledWith(5000);
  });
});

describe("runLogin — poll deadline", () => {
  it("computes the deadline as expires_in SECONDS after start (not raw ms)", async () => {
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(0); // deadline calc: 0 + 10*1000 = 10000
    dateSpy.mockReturnValueOnce(5000); // loop check: 5s elapsed, well under the 10s deadline
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith("/start")) {
        return new Response(JSON.stringify({ ...START_RESPONSE, expires_in: 10 }), { status: 200 });
      }
      return new Response(JSON.stringify(APPROVED_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() });

    expect(result.appId).toBe("app-1");
    dateSpy.mockRestore();
  });

  it("times out exactly AT the deadline — the boundary is inclusive", async () => {
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(0); // deadline calc: 0 + 10*1000 = 10000
    dateSpy.mockReturnValueOnce(10000); // loop check: exactly at the deadline
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith("/start")) {
        return new Response(JSON.stringify({ ...START_RESPONSE, expires_in: 10 }), { status: 200 });
      }
      // Reached only if the boundary check wrongly lets the loop through.
      return new Response(JSON.stringify(APPROVED_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() }),
    ).rejects.toThrow(LoginTimeoutError);
    dateSpy.mockRestore();
  });
});

describe("runLogin — poll loop", () => {
  it("keeps polling through repeated pending states until approved", async () => {
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith("/start")) {
        return new Response(JSON.stringify(START_RESPONSE), { status: 200 });
      }
      pollCount += 1;
      if (pollCount < 3) {
        return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      }
      return new Response(JSON.stringify(APPROVED_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: fakeSync() });

    expect(pollCount).toBe(3);
    expect(result.appId).toBe("app-1");
  });
});

describe("runLogin — exact result shape", () => {
  it("returns the full LoginCommandResult object on the happy path", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: APPROVED_RESPONSE }]);
    const sync = fakeSync();

    const { output, ...rest } = await runLogin({
      url: "https://dash.test",
      home,
      fetchImpl,
      sleepImpl: noSleep,
      openImpl: vi.fn(),
      syncImpl: sync,
    });

    expect(output).toContain("AAAA-BBBB");
    expect(output).toContain("Synced 3 session(s).\n");
    expect(rest).toEqual({
      url: "https://gw.outerlayer.test",
      apiKey: "sk_outerlayer_minted",
      appId: "app-1",
      orgName: "acme",
      appName: "My App",
      configWritten: true,
      sync: {
        scanned: 3,
        eligible: 3,
        synced: 3,
        rejected: [],
        blobsSent: 0,
        batches: 1,
        tier: "full",
        url: "https://gw.outerlayer.test",
        dryRun: false,
        output: "",
      },
    });
  });

  it("falls back to the automatic-sync message when the first sync throws", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: APPROVED_RESPONSE }]);
    const failingSync = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await runLogin({ url: "https://dash.test", home, fetchImpl, sleepImpl: noSleep, openImpl: vi.fn(), syncImpl: failingSync });

    expect(result.output).toContain("Login succeeded; the first sync will run automatically from your next session.\n");
  });
});
