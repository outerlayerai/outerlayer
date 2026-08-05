import type { ContextSaveResult } from "@/lib/adapters/context-save";

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A translation key plus its interpolation values, resolved by the caller's `t`. */
interface LandingMessage {
  key: string;
  params: Record<string, string | number>;
}

/**
 * One-line outcome shown after a context save or delete lands. Names where the
 * change went so a protected-branch PR fallback (which happens even when the
 * publish policy didn't ask for a PR) is never silent, and distinguishes a
 * freshly opened PR from an update to the accumulating one.
 *
 * Returns a translation key + params (not a formatted string) so the message
 * localizes at the render site, mirroring the codebase's helper-returns-a-key
 * pattern for text built outside a component.
 */
export function landingMessage(result: ContextSaveResult): LandingMessage {
  if (result.landed === "branch") {
    return {
      key: "dashboard.context.view.landingBranch",
      params: { branch: result.branch, sha: shortSha(result.commitSha) },
    };
  }
  if (result.prAction === "updated") {
    return {
      key: "dashboard.context.view.landingPrUpdated",
      params: { number: result.pullRequestNumber },
    };
  }
  if (result.reason === "protected_branch") {
    return {
      key: "dashboard.context.view.landingPrProtected",
      params: { number: result.pullRequestNumber, branch: result.branch },
    };
  }
  return {
    key: "dashboard.context.view.landingPrOpened",
    params: { number: result.pullRequestNumber },
  };
}
