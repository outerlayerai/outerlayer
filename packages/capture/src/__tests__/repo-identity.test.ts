// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemote, enrichSessionRepo, resolveRepoIdentity } from "../repo-identity.js";
import type { AgentSession } from "@outerlayer/session-schema";

describe("normalizeRemote", () => {
  it("collapses every remote form to host/org/repo", () => {
    for (const r of [
      "git@github.com:acme/app.git",
      "https://github.com/acme/app",
      "https://github.com/acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "git@github.com:acme/app",
    ]) {
      expect(normalizeRemote(r), r).toBe("github.com/acme/app");
    }
    expect(normalizeRemote("")).toBeUndefined();
  });
});

describe("enrichSessionRepo", () => {
  it("does not overwrite a transcript-captured branch (run-time branch is authoritative)", () => {
    // cwd that doesn't resolve → identity {}, branch preserved
    const s = { env: { cwd: "/nonexistent/xyz", gitBranch: "feat/run-time" } } as unknown as AgentSession;
    enrichSessionRepo(s);
    expect(s.env.gitBranch).toBe("feat/run-time");
  });
});

describe("resolveRepoIdentity — working-tree root", () => {
  // realpath so the temp dir matches `git rev-parse --show-toplevel`, which
  // realpaths (macOS /var/folders → /private/var/folders).
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ol-reporoot-")));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });

  it("resolves repoRoot to the working-tree root from a cwd inside it", () => {
    const nested = join(repo, "apps", "web");
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.co"], { stdio: "ignore" });
    // resolve from a nested dir to prove it returns the ROOT, not the cwd
    execFileSync("mkdir", ["-p", nested]);
    expect(resolveRepoIdentity(nested).repoRoot).toBe(repo);
  });

  it("leaves repoRoot undefined outside any repo", () => {
    expect(resolveRepoIdentity("/nonexistent/xyz").repoRoot).toBeUndefined();
  });
});
