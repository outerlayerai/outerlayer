import { describe, it, expect, beforeAll } from "vitest";
import type { i18n as I18n } from "i18next";
import { landingMessage } from "./landing-message";
import { getRealI18n } from "@/test-helpers/real-i18n";
import type { ContextSaveResult } from "@/lib/adapters/context-save";

// `landingMessage` returns a translation key + params (not a formatted string)
// so the copy localizes at the render site. Each case pins the exact key + params
// AND feeds them through the real i18n to prove the key exists in en.json and its
// placeholders interpolate to the shipped English.
describe("landingMessage", () => {
  let i18n: I18n;
  beforeAll(() => {
    i18n = getRealI18n();
  });

  it("names the branch and short sha for a direct push", () => {
    const result: ContextSaveResult = {
      landed: "branch",
      commitSha: "abcdef1234567890",
      branch: "main",
    };
    const msg = landingMessage(result);
    expect(msg).toEqual({
      key: "dashboard.context.view.landingBranch",
      params: { branch: "main", sha: "abcdef1" },
    });
    expect(i18n.t(msg.key, msg.params)).toBe("Changes pushed to main · abcdef1");
  });

  it("reports an accumulating PR update", () => {
    const result: ContextSaveResult = {
      landed: "pull_request",
      commitSha: "c0ffee0000",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      pullRequestNumber: 7,
      prAction: "updated",
      reason: "config",
      branch: "main",
    };
    const msg = landingMessage(result);
    expect(msg).toEqual({
      key: "dashboard.context.view.landingPrUpdated",
      params: { number: 7 },
    });
    expect(i18n.t(msg.key, msg.params)).toBe("Pull request #7 updated");
  });

  it("reports a freshly opened PR from the publish policy", () => {
    const result: ContextSaveResult = {
      landed: "pull_request",
      commitSha: "c0ffee0000",
      pullRequestUrl: "https://github.com/acme/app/pull/8",
      pullRequestNumber: 8,
      prAction: "created",
      reason: "config",
      branch: "main",
    };
    const msg = landingMessage(result);
    expect(msg).toEqual({
      key: "dashboard.context.view.landingPrOpened",
      params: { number: 8 },
    });
    expect(i18n.t(msg.key, msg.params)).toBe("Opened pull request #8");
  });

  it("spells out the protected-branch fallback when a PR was opened without the policy asking", () => {
    const result: ContextSaveResult = {
      landed: "pull_request",
      commitSha: "c0ffee0000",
      pullRequestUrl: "https://github.com/acme/app/pull/9",
      pullRequestNumber: 9,
      prAction: "created",
      reason: "protected_branch",
      branch: "main",
    };
    const msg = landingMessage(result);
    expect(msg).toEqual({
      key: "dashboard.context.view.landingPrProtected",
      params: { number: 9, branch: "main" },
    });
    expect(i18n.t(msg.key, msg.params)).toBe(
      "Opened pull request #9 — main is protected, direct push unavailable",
    );
  });
});
