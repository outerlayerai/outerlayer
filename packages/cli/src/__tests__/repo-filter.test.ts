// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { RepoFilter } from "../repo-filter.js";

describe("RepoFilter", () => {
  it("is inactive (allows everything) with no config", () => {
    const f = new RepoFilter(undefined);
    expect(f.active).toBe(false);
    expect(f.allows("github.com/acme/app")).toBe(true);
    expect(f.allows(undefined)).toBe(true);
    expect(f.skippedTotal).toBe(0);
  });

  it("exclude drops matching repos, keeps everything else including no-repo", () => {
    const f = new RepoFilter({ exclude: ["gitlab.com/personal/*"] });
    expect(f.allows("gitlab.com/personal/secret")).toBe(false);
    expect(f.allows("gitlab.com/personal/other")).toBe(false);
    expect(f.allows("github.com/acme/app")).toBe(true);
    expect(f.allows(undefined)).toBe(true);
    expect(f.skippedTotal).toBe(2);
    expect(f.skipped.get("gitlab.com/personal/secret")).toBe(1);
  });

  it("include keeps only matching repos and drops no-repo sessions", () => {
    const f = new RepoFilter({ include: ["github.com/acme/*"] });
    expect(f.allows("github.com/acme/app")).toBe(true);
    expect(f.allows("github.com/other/app")).toBe(false);
    expect(f.allows(undefined)).toBe(false);
    expect(f.skipped.get("(no repo)")).toBe(1);
  });

  it("exclude wins over include", () => {
    const f = new RepoFilter({ include: ["github.com/acme/*"], exclude: ["github.com/acme/legacy"] });
    expect(f.allows("github.com/acme/app")).toBe(true);
    expect(f.allows("github.com/acme/legacy")).toBe(false);
  });

  it("matches case-insensitively and anchors the whole string", () => {
    const f = new RepoFilter({ exclude: ["GitHub.com/ACME/app"] });
    expect(f.allows("github.com/acme/app")).toBe(false);
    // Anchored: a pattern without wildcards must not match a superstring.
    expect(f.allows("github.com/acme/app-two")).toBe(true);
  });

  it("does not treat regex metacharacters in patterns as regex", () => {
    const f = new RepoFilter({ exclude: ["github.com/acme/a.b"] });
    expect(f.allows("github.com/acme/a.b")).toBe(false);
    expect(f.allows("github.com/acme/aXb")).toBe(true);
  });
});
