import { describe, it, expect } from "vitest";
import { parseCommitRevertTargets, parseRevertTarget } from "../revert-detection";

describe("parseRevertTarget", () => {
  it("resolves the GitHub revert-button form 'Reverts owner/repo#N'", () => {
    expect(parseRevertTarget("Reverts acme-corp/webapp#3461")).toEqual({ prNumber: 3461 });
  });

  it("resolves the bare GitHub form 'Reverts #N'", () => {
    expect(parseRevertTarget("Reverts #512")).toEqual({ prNumber: 512 });
  });

  it("does NOT match the 'merge request !N' form (no such provider is wired up)", () => {
    expect(parseRevertTarget("This reverts merge request group/proj!87")).toBeNull();
    expect(parseRevertTarget("This reverts merge request !87")).toBeNull();
  });

  it("is case-insensitive on the keyword", () => {
    expect(parseRevertTarget("reverts owner/repo#9")).toEqual({ prNumber: 9 });
  });

  it("does NOT match a stray issue reference not anchored to 'Reverts' (no false positives)", () => {
    // A squashed body mentioning #42 in prose must not be read as a revert of #42.
    expect(parseRevertTarget("Fixes the thing discussed in #42; unrelated cleanup")).toBeNull();
    expect(parseRevertTarget('Revert "feat: add #42 support"')).toBeNull();
  });

  it("returns null for a manual git revert that carries only a commit sha (documented undercount)", () => {
    expect(parseRevertTarget("This reverts commit 0a1b2c3d4e5f60718293a4b5c6d7e8f901234567.")).toBeNull();
  });

  it("returns null for empty/absent bodies", () => {
    expect(parseRevertTarget(null)).toBeNull();
    expect(parseRevertTarget(undefined)).toBeNull();
    expect(parseRevertTarget("")).toBeNull();
  });
})

describe("parseCommitRevertTargets", () => {
  const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

  it("resolves the squash-title convention: Revert \"title (#N)\"", () => {
    expect(parseCommitRevertTargets('Revert "feat: add widgets (#123)"')).toEqual({
      prNumbers: [123],
      shas: [],
    });
  });

  it("takes the FIRST (#N) on the title — the reverted PR, not the revert's own squash number", () => {
    expect(parseCommitRevertTargets('Revert "feat: add widgets (#123)" (#456)').prNumbers).toEqual([123]);
  });

  it("resolves 'This reverts commit <sha>' bodies to full 40-hex shas, lowercased", () => {
    expect(
      parseCommitRevertTargets(`Revert "feat: thing"\n\nThis reverts commit ${SHA.toUpperCase()}.`)
    ).toEqual({ prNumbers: [], shas: [SHA] });
  });

  it("ignores abbreviated shas — any 7-hex word in a message must not become a revert target", () => {
    expect(parseCommitRevertTargets("This reverts commit 0a1b2c3.").shas).toEqual([]);
  });

  it("resolves provider body references carried into squash commit messages", () => {
    expect(parseCommitRevertTargets('Revert PR (#456)\n\nReverts acme/api#123').prNumbers).toEqual([456, 123]);
    expect(parseCommitRevertTargets("chore\n\nThis reverts merge request !87").prNumbers).toEqual([]);
  });

  it("does NOT read a (#N) from a title that doesn't start with Revert (no false positives)", () => {
    expect(parseCommitRevertTargets("feat: add widgets (#123)")).toEqual({ prNumbers: [], shas: [] });
    // A second line starting with Revert is a body, not the title.
    expect(parseCommitRevertTargets("feat: x\nRevert \"y (#9)\"").prNumbers).toEqual([]);
  });

  it("collects several targets from one message without duplicates", () => {
    const message = `Revert "feat: a (#12)"\n\nThis reverts commit ${SHA}.\nThis reverts commit ${SHA}.`;
    expect(parseCommitRevertTargets(message)).toEqual({ prNumbers: [12], shas: [SHA] });
  });

  it("returns empty for empty/absent messages", () => {
    expect(parseCommitRevertTargets(null)).toEqual({ prNumbers: [], shas: [] });
    expect(parseCommitRevertTargets("")).toEqual({ prNumbers: [], shas: [] });
  });
});
