// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessSyncHealth,
  formatAge,
  formatAgo,
  readSyncStatus,
  writeSyncStatus,
  syncStatusPath,
  SYNC_STALE_AFTER_MS,
  type SyncStatus,
} from "../sync-status.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-status-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse("2026-07-21T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("writeSyncStatus / readSyncStatus", () => {
  it("round-trips a success record with its full shape", () => {
    const status: SyncStatus = {
      at: iso(T0),
      ok: true,
      url: "https://api-stg.agentmark.co",
      appId: "app-1",
      synced: 12,
      pending: 0,
    };
    writeSyncStatus(status, home);

    expect(readSyncStatus(home)).toEqual({ ...status, lastOkAt: iso(T0) });
  });

  it("carries lastOkAt forward across a failure so outage length survives", () => {
    writeSyncStatus({ at: iso(T0), ok: true, url: "https://a.co", synced: 3, pending: 0 }, home);
    writeSyncStatus(
      {
        at: iso(T0 + 3_600_000),
        ok: false,
        url: "https://a.co",
        pending: 9,
        error: { status: 413, message: "too big" },
      },
      home,
    );

    // The failing record must still point at the last time data actually landed.
    expect(readSyncStatus(home)).toEqual({
      at: iso(T0 + 3_600_000),
      ok: false,
      url: "https://a.co",
      pending: 9,
      error: { status: 413, message: "too big" },
      lastOkAt: iso(T0),
    });
  });

  it("keeps carrying the ORIGINAL lastOkAt across consecutive failures", () => {
    writeSyncStatus({ at: iso(T0), ok: true }, home);
    writeSyncStatus({ at: iso(T0 + 1_000), ok: false, error: { message: "x" } }, home);
    writeSyncStatus({ at: iso(T0 + 2_000), ok: false, error: { message: "y" } }, home);

    expect(readSyncStatus(home)?.lastOkAt).toBe(iso(T0));
  });

  it("returns null for a corrupt record rather than throwing", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(syncStatusPath(home), "{not json");

    expect(readSyncStatus(home)).toBeNull();
  });

  it("returns null when the record is well-formed JSON but the wrong shape", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(syncStatusPath(home), JSON.stringify({ at: 5, ok: "yes" }));

    expect(readSyncStatus(home)).toBeNull();
  });

  it("writes the record 0600 — it names the destination and app", () => {
    writeSyncStatus({ at: iso(T0), ok: true }, home);

    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(syncStatusPath(home)).mode & 0o777).toBe(0o600);
  });

  it("leaves no .tmp file behind — readers must never see a partial write", () => {
    writeSyncStatus({ at: iso(T0), ok: true }, home);

    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(`${syncStatusPath(home)}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(syncStatusPath(home), "utf8")).ok).toBe(true);
  });
});

describe("assessSyncHealth", () => {
  it("reports unknown when no sync has ever run", () => {
    expect(assessSyncHealth(null, T0)).toEqual({
      level: "unknown",
      headline: "no sync has run on this machine yet",
      details: ["run `outerlayer sync` once to verify the connection"],
    });
  });

  it("reports a failure as error, naming status, host, outage length and backlog", () => {
    const health = assessSyncHealth(
      {
        at: iso(T0),
        ok: false,
        url: "https://api-stg.agentmark.co",
        pending: 46,
        error: { status: 413, message: "request too large" },
        lastOkAt: iso(T0 - 28 * 3_600_000),
      },
      T0 + 60_000,
    );

    expect(health.level).toBe("error");
    expect(health.headline).toBe("sync is FAILING — last attempt 1m ago");
    expect(health.details).toEqual([
      "HTTP 413 from api-stg.agentmark.co: request too large",
      "last successful sync 28h ago",
      "46 session(s) waiting to ship",
      "run `outerlayer doctor` for the full picture",
    ]);
  });

  it("says so explicitly when a destination has NEVER synced successfully", () => {
    const health = assessSyncHealth(
      { at: iso(T0), ok: false, url: "http://localhost:9105", error: { message: "connection refused" } },
      T0,
    );

    expect(health.level).toBe("error");
    // No lastOkAt: a fresh misconfiguration, not a regression of a working setup.
    expect(health.details).toEqual([
      "localhost:9105: connection refused",
      "no successful sync has ever been recorded for this destination",
      "run `outerlayer doctor` for the full picture",
    ]);
  });

  it("reports a recent success as ok", () => {
    const health = assessSyncHealth({ at: iso(T0), ok: true, url: "https://api-stg.agentmark.co" }, T0 + 120_000);

    expect(health).toEqual({
      level: "ok",
      headline: "synced 2m ago → api-stg.agentmark.co",
      details: [],
    });
  });

  it("escalates a stale success to warn only past the threshold", () => {
    const status: SyncStatus = { at: iso(T0), ok: true, url: "https://a.co" };

    expect(assessSyncHealth(status, T0 + SYNC_STALE_AFTER_MS - 1).level).toBe("ok");
    expect(assessSyncHealth(status, T0 + SYNC_STALE_AFTER_MS + 1).level).toBe("warn");
  });

  it("never downgrades a failure to warn no matter how recent", () => {
    // A failure is unambiguous — age must not soften it.
    const health = assessSyncHealth({ at: iso(T0), ok: false, error: { message: "boom" } }, T0);
    expect(health.level).toBe("error");
  });
});

describe("formatAge", () => {
  it("maps durations to compact units across every boundary", () => {
    expect([
      formatAge(30_000),
      formatAge(60_000),
      formatAge(59 * 60_000),
      formatAge(60 * 60_000),
      formatAge(47 * 3_600_000),
      formatAge(48 * 3_600_000),
      formatAge(72 * 3_600_000),
    ]).toEqual(["just now", "1m", "59m", "1h", "47h", "2d", "3d"]);
  });

  it("refuses to invent an age from a nonsense duration", () => {
    expect([formatAge(NaN), formatAge(-1)]).toEqual(["unknown", "unknown"]);
  });
});

describe("formatAgo", () => {
  it("appends 'ago' only where it reads correctly", () => {
    // "just now ago" and "unknown ago" are the failure modes this guards.
    expect([formatAgo(30_000), formatAgo(120_000), formatAgo(5 * 3_600_000), formatAgo(NaN)]).toEqual([
      "just now",
      "2m ago",
      "5h ago",
      "unknown",
    ]);
  });
});
