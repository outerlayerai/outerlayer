// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCloudConfig, writeCloudConfig, cloudConfigPath, isLoopbackUrl } from "../sync-cmd.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-cfg-"));
  mkdirSync(join(home, ".outerlayer"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const seed = (config: unknown) =>
  writeFileSync(cloudConfigPath(home), JSON.stringify(config, null, 2));

describe("writeCloudConfig", () => {
  it("preserves fields the writer does not know about", () => {
    // The credential auto-persist only ever knows url/apiKey/appId; everything
    // else here must survive it.
    seed({
      url: "https://old.co",
      apiKey: "old-key",
      appId: "old-app",
      repos: { include: ["github.com/acme/*"] },
      autoSync: false,
      tier: "redacted",
      scrub: { literals: ["hunter2"] },
    });

    writeCloudConfig({ url: "https://new.co", apiKey: "new-key", appId: "new-app" }, home);

    expect(readCloudConfig(home)).toEqual({
      url: "https://new.co",
      apiKey: "new-key",
      appId: "new-app",
      repos: { include: ["github.com/acme/*"] },
      autoSync: false,
      tier: "redacted",
      scrub: { literals: ["hunter2"] },
    });
  });

  it("does not let an explicit undefined erase a stored value", () => {
    seed({ url: "https://a.co", apiKey: "k", appId: "app", tier: "redacted" });

    writeCloudConfig({ url: "https://b.co", apiKey: undefined, appId: undefined }, home);

    expect(readCloudConfig(home)).toEqual({
      url: "https://b.co",
      apiKey: "k",
      appId: "app",
      tier: "redacted",
    });
  });

  it("writes a fresh config when none exists", () => {
    writeCloudConfig({ url: "https://a.co", apiKey: "k", appId: "app" }, home);

    expect(readCloudConfig(home)).toEqual({ url: "https://a.co", apiKey: "k", appId: "app" });
  });

  it("keeps the file 0600 — it holds an API key", () => {
    seed({ url: "https://a.co" });
    writeCloudConfig({ apiKey: "secret" }, home);

    expect(statSync(cloudConfigPath(home)).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt existing config as empty rather than throwing", () => {
    writeFileSync(cloudConfigPath(home), "{not json");

    writeCloudConfig({ url: "https://a.co" }, home);

    expect(readCloudConfig(home)).toEqual({ url: "https://a.co" });
  });
});

describe("isLoopbackUrl", () => {
  it("recognises every loopback form a local gateway is reached by", () => {
    expect([
      "http://localhost:9105",
      "http://127.0.0.1:9105",
      "http://127.1.2.3:8787",
      "http://[::1]:9105",
      "http://0.0.0.0:9105",
      "http://gateway.localhost:9105",
    ].map(isLoopbackUrl)).toEqual([true, true, true, true, true, true]);
  });

  it("does not misclassify real destinations", () => {
    expect([
      "https://api-stg.agentmark.co",
      "https://api.outerlayer.com",
      // Substring traps: these are ordinary remote hosts.
      "https://localhost.evil.com",
      "https://not-127.0.0.1.example.com",
      "https://mylocalhost.co",
    ].map(isLoopbackUrl)).toEqual([false, false, false, false, false]);
  });

  it("returns false for an unparseable url instead of throwing", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
