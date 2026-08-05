// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWatermark, writeWatermark, watermarkKeyFor, watermarkPath } from "../watermark.js";

let home: string;
const URL_A = "https://api-stg.agentmark.co";
const APP = "9e43803f";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-wm-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("watermarkKeyFor", () => {
  it("keys on host + appId, so two destinations never share a checkpoint", () => {
    expect(watermarkKeyFor("https://api-stg.agentmark.co/x", "app1")).toBe("api-stg.agentmark.co:app1");
    expect(watermarkKeyFor("http://localhost:9105", "app1")).toBe("localhost:9105:app1");
    // Same corpus, different app → different key.
    expect(watermarkKeyFor(URL_A, "app1")).not.toBe(watermarkKeyFor(URL_A, "app2"));
  });
});

describe("read/write round-trip", () => {
  it("returns what was written, preserving sub-millisecond precision", () => {
    // never-migrate: a fresh machine with no SQLite starts at 0.
    const noMigrate = () => null;
    expect(readWatermark(URL_A, APP, home, noMigrate)).toBe(0);

    writeWatermark(URL_A, APP, 1784562916755.8477, home);
    expect(readWatermark(URL_A, APP, home, noMigrate)).toBe(1784562916755.8477);
  });

  it("isolates checkpoints per destination in one file", () => {
    writeWatermark(URL_A, "app1", 100, home);
    writeWatermark(URL_A, "app2", 200, home);
    writeWatermark("http://localhost:9105", "app1", 300, home);

    const noMigrate = () => null;
    expect(readWatermark(URL_A, "app1", home, noMigrate)).toBe(100);
    expect(readWatermark(URL_A, "app2", home, noMigrate)).toBe(200);
    expect(readWatermark("http://localhost:9105", "app1", home, noMigrate)).toBe(300);
    // One file, three keys.
    expect(Object.keys(JSON.parse(readFileSync(watermarkPath(home), "utf8")))).toEqual([
      "api-stg.agentmark.co:app1",
      "api-stg.agentmark.co:app2",
      "localhost:9105:app1",
    ]);
  });

  it("advancing a checkpoint overwrites only its own key", () => {
    writeWatermark(URL_A, "app1", 100, home);
    writeWatermark(URL_A, "app2", 999, home);
    writeWatermark(URL_A, "app1", 500, home);

    const noMigrate = () => null;
    expect(readWatermark(URL_A, "app1", home, noMigrate)).toBe(500);
    expect(readWatermark(URL_A, "app2", home, noMigrate)).toBe(999);
  });
});

describe("SQLite migration (one-time)", () => {
  it("seeds the checkpoint from the legacy SQLite value on first read", () => {
    let migrateCalls = 0;
    const migrate = () => {
      migrateCalls += 1;
      return 1784562916755.8477;
    };

    // First read: no JSON yet → migrate.
    expect(readWatermark(URL_A, APP, home, migrate)).toBe(1784562916755.8477);
    expect(migrateCalls).toBe(1);

    // The migrated value is now persisted, so a second read does NOT touch
    // SQLite again — this is what keeps the native module off the hot path.
    expect(readWatermark(URL_A, APP, home, migrate)).toBe(1784562916755.8477);
    expect(migrateCalls).toBe(1);
  });

  it("records a 0 when there is nothing to migrate, so migration is not retried every run", () => {
    let migrateCalls = 0;
    const migrate = () => {
      migrateCalls += 1;
      return null; // no prior SQLite watermark
    };

    expect(readWatermark(URL_A, APP, home, migrate)).toBe(0);
    expect(readWatermark(URL_A, APP, home, migrate)).toBe(0);
    // Migration attempted once, then the persisted 0 short-circuits it.
    expect(migrateCalls).toBe(1);
    expect(existsSync(watermarkPath(home))).toBe(true);
  });
});

describe("resilience", () => {
  it("treats a corrupt checkpoint file as empty rather than throwing", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(watermarkPath(home), "{not json");

    // Falls through to migration (null here) → 0, no throw.
    expect(readWatermark(URL_A, APP, home, () => null)).toBe(0);
  });

  it("ignores non-numeric values a hand-edit might introduce", () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(watermarkPath(home), JSON.stringify({ "api-stg.agentmark.co:9e43803f": "oops" }));

    // The bad key is dropped, so it looks unset → migrate → 0.
    expect(readWatermark(URL_A, APP, home, () => null)).toBe(0);
  });

  it("leaves no .tmp file behind after an atomic write", () => {
    writeWatermark(URL_A, APP, 42, home);
    expect(existsSync(`${watermarkPath(home)}.tmp`)).toBe(false);
  });
});
