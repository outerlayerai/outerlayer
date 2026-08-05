/**
 * branch-naming — head-branch name generation for fallback/forced PRs.
 *
 * Pins the git-ref-safety of the generated branch (sanitization is the bug
 * class: an unsanitized prompt path produces an invalid ref and the PR/commit
 * call fails) and the `outerlayer/publish/<slug>` shape the publish policy relies on.
 */
import { describe, it, expect } from "vitest";
import {
  buildFallbackBranchName,
  sanitizeBranchSegment,
  sanitizeBranchPath,
  isValidPreviewBranchName,
  toPreviewEnvName,
} from "../branch-naming";

describe("sanitizeBranchSegment", () => {
  it("lowercases, collapses non-alphanumerics to single hyphens, and trims", () => {
    expect(sanitizeBranchSegment("Prompts/Greeting Prompt!.mdx")).toBe(
      "prompts-greeting-prompt-mdx"
    );
  });

  it("strips leading and trailing hyphens left by punctuation", () => {
    expect(sanitizeBranchSegment("__hello.world__")).toBe("hello-world");
  });

  it("caps the slug length so the ref never gets unwieldy", () => {
    const slug = sanitizeBranchSegment("a".repeat(200));
    expect(slug.length).toBe(60);
  });
});

describe("sanitizeBranchPath", () => {
  it("preserves slash boundaries, sanitizing each segment independently", () => {
    expect(sanitizeBranchPath("outerlayer/context/main")).toBe(
      "outerlayer/context/main"
    );
  });

  it("sanitizes per segment without flattening the slashes", () => {
    expect(sanitizeBranchPath("Feature/My Branch")).toBe("feature/my-branch");
  });

  it("drops empty segments from leading, trailing, and doubled slashes", () => {
    expect(sanitizeBranchPath("/feature//login/")).toBe("feature/login");
  });
});

describe("buildFallbackBranchName", () => {
  // The uniqueness suffix is base36 of the clock, so assert on the prefix shape.
  it("defaults to outerlayer/dataset-<suffix> when no options are given (legacy datasets/protected-branch path)", () => {
    expect(buildFallbackBranchName()).toMatch(/^outerlayer\/dataset-[a-z0-9]+$/);
  });

  it("builds <prefix>/<sanitized-slug>-<suffix> for a publish", () => {
    expect(
      buildFallbackBranchName({
        headBranchPrefix: "outerlayer/publish",
        headBranchSlug: "prompts/greeting.prompt",
      })
    ).toMatch(/^outerlayer\/publish\/prompts-greeting-prompt-[a-z0-9]+$/);
  });

  it("omits the slug segment when no slug is given", () => {
    expect(
      buildFallbackBranchName({ headBranchPrefix: "outerlayer/publish" })
    ).toMatch(/^outerlayer\/publish-[a-z0-9]+$/);
  });

  it("uses a caller-provided branch name verbatim — no prefix, no suffix — so a re-publish lands on the same branch", () => {
    expect(
      buildFallbackBranchName({
        headBranchPrefix: "outerlayer/publish",
        headBranchSlug: "prompts/greeting.prompt",
        headBranchName: "customer-support-v2",
      })
    ).toBe("customer-support-v2");
  });

  it("keeps the slash structure of a slashed stable head branch name (no timestamp suffix)", () => {
    expect(
      buildFallbackBranchName({ headBranchName: "outerlayer/context/main" })
    ).toBe("outerlayer/context/main");
  });

  it("sanitizes each segment of a slashed head branch name independently", () => {
    expect(
      buildFallbackBranchName({ headBranchName: "outerlayer/context/Feature/New Docs" })
    ).toBe("outerlayer/context/feature/new-docs");
  });
});

describe("isValidPreviewBranchName", () => {
  it("accepts a lowercase slug that starts with a letter (≤40)", () => {
    expect(isValidPreviewBranchName("customer-support-v2")).toBe(true);
  });

  it("rejects names that can't be an env name (uppercase, slash, leading digit/hyphen, too long, too short)", () => {
    expect(isValidPreviewBranchName("Customer-Support")).toBe(false);
    expect(isValidPreviewBranchName("feature/login")).toBe(false);
    expect(isValidPreviewBranchName("2fast")).toBe(false);
    expect(isValidPreviewBranchName("-leading")).toBe(false);
    expect(isValidPreviewBranchName("a")).toBe(false);
    expect(isValidPreviewBranchName("a".repeat(41))).toBe(false);
  });
});

describe("toPreviewEnvName", () => {
  it("uses a valid branch name verbatim", () => {
    expect(toPreviewEnvName("customer-support-v2", 7)).toBe("customer-support-v2");
  });

  it("sanitizes a slashed branch into a valid env name", () => {
    expect(toPreviewEnvName("outerlayer/publish/greeting", 7)).toBe(
      "outerlayer-publish-greeting"
    );
  });

  it("falls back to pr-<n> when the branch can't yield a valid env name", () => {
    // Leading digit → sanitized still starts with a digit → invalid env name.
    expect(toPreviewEnvName("123", 7)).toBe("pr-7");
  });
});
