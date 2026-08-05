import { describe, it, expect } from "vitest";
import { providerFileUrl } from "../provider-file-url";

describe("providerFileUrl", () => {
  const base = {
    repository: "acme/web",
    branch: "main",
    path: "apps/web/.outerlayer/skills/deploy/SKILL.md",
  };

  it("builds a GitHub blob URL", () => {
    expect(providerFileUrl({ ...base, provider: "github" })).toBe(
      "https://github.com/acme/web/blob/main/apps/web/.outerlayer/skills/deploy/SKILL.md",
    );
  });

  it("builds a GitLab blob URL with the /-/ segment", () => {
    expect(providerFileUrl({ ...base, provider: "gitlab" })).toBe(
      "https://gitlab.com/acme/web/-/blob/main/apps/web/.outerlayer/skills/deploy/SKILL.md",
    );
  });

  it("defaults a missing provider to GitHub (matches connection fallback)", () => {
    expect(providerFileUrl({ ...base, provider: null })).toBe(
      "https://github.com/acme/web/blob/main/apps/web/.outerlayer/skills/deploy/SKILL.md",
    );
  });

  it("percent-encodes path segments but keeps slashes as separators", () => {
    expect(
      providerFileUrl({ ...base, provider: "github", path: "a b/c#d/AGENTS.md" }),
    ).toBe("https://github.com/acme/web/blob/main/a%20b/c%23d/AGENTS.md");
  });

  it("drops empty segments from a malformed stored path (no doubled slashes in the URL)", () => {
    expect(
      providerFileUrl({ ...base, provider: "github", path: "/apps//web/AGENTS.md" }),
    ).toBe("https://github.com/acme/web/blob/main/apps/web/AGENTS.md");
  });

  it("returns undefined without a branch (CTA falls back to generic copy)", () => {
    expect(providerFileUrl({ ...base, provider: "github", branch: null })).toBeUndefined();
  });

  it("returns undefined for an unknown provider", () => {
    expect(providerFileUrl({ ...base, provider: "bitbucket" })).toBeUndefined();
  });
});
