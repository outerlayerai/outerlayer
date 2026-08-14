/**
 * evaluateEvidence: the pure facts-in, verdict-out core behind the evidence
 * comment. Plain objects in, a plain evaluation out — this is where the
 * commit-provenance matching rules and the fact→verdict mapping of
 * `acceptance/082-evidence-comment.md` get proven.
 */
import { describe, it, expect } from "vitest";

import { evaluateEvidence } from "../evaluate";

const session = (recordedCommitShas: string[]) => ({ recordedCommitShas });

describe("evaluateEvidence", () => {
  // AC-082-01: every displayed fact passing maps to the pass verdict.
  it("derives pass when every displayed fact passes", () => {
    const result = evaluateEvidence({
      sessions: [session(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])],
      pendingLinkCount: 0,
      prCommitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    });

    expect(result.verdict).toBe("pass");
    expect(result.flaggedCount).toBe(0);
    expect(result.facts).toEqual([
      {
        id: "commits-from-sessions",
        status: "pass",
        class: "amber",
        matchedCommitCount: 1,
        totalCommitCount: 1,
        unrecordedShas: [],
      },
    ]);
  });

  // AC-082-01 + AC-082-02: a flagged fact maps to the flag verdict — and
  // because commit provenance is amber-class, unrecorded commits ALONE can
  // never produce the red "unverifiable" verdict, even at 0 of n.
  it("derives flag — never unverifiable — when commits are unrecorded, even when none match", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
    });

    expect(result.verdict).toBe("flag");
    expect(result.flaggedCount).toBe(1);
    expect(result.facts).toEqual([
      expect.objectContaining({
        id: "commits-from-sessions",
        status: "flag",
        class: "amber",
        matchedCommitCount: 0,
        totalCommitCount: 2,
        unrecordedShas: [
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
      }),
    ]);
  });

  // AC-082-02: matching is by ≥7-character SHA prefix, in either direction —
  // sessions record what the transcript captured, which can be the truncated
  // spelling of the full sha GitHub reports.
  it("matches a full PR sha against a recorded 7+ character prefix, and vice versa", () => {
    const full = "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d";

    const recordedPrefix = evaluateEvidence({
      sessions: [session(["1a2b3c4"])],
      pendingLinkCount: 0,
      prCommitShas: [full],
    });
    expect(recordedPrefix.facts[0]).toMatchObject({ status: "pass", matchedCommitCount: 1 });

    const recordedFull = evaluateEvidence({
      sessions: [session([full])],
      pendingLinkCount: 0,
      prCommitShas: ["1a2b3c4d5e6f"],
    });
    expect(recordedFull.facts[0]).toMatchObject({ status: "pass", matchedCommitCount: 1 });
  });

  // AC-082-02: below seven characters is too collision-prone to accept as
  // identity — a shorter recorded sha matches nothing, never everything.
  it("never matches a recorded sha shorter than seven characters", () => {
    const result = evaluateEvidence({
      sessions: [session(["1a2b3c"])],
      pendingLinkCount: 0,
      prCommitShas: ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"],
    });

    expect(result.facts[0]).toMatchObject({ status: "flag", matchedCommitCount: 0 });
  });

  it("matches case-insensitively — git shas are hex, spellings vary by source", () => {
    const result = evaluateEvidence({
      sessions: [session(["1A2B3C4D"])],
      pendingLinkCount: 0,
      prCommitShas: ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"],
    });

    expect(result.facts[0]).toMatchObject({ status: "pass" });
  });

  // AC-082-02: the match set is the UNION across all confirmed sessions — a
  // commit recorded by any witness is accounted for.
  it("matches against the union of every session's recorded commits", () => {
    const result = evaluateEvidence({
      sessions: [session(["aaaaaaaa"]), session(["bbbbbbbb"])],
      pendingLinkCount: 0,
      prCommitShas: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
    });

    expect(result.facts[0]).toMatchObject({
      status: "pass",
      matchedCommitCount: 2,
      totalCommitCount: 2,
    });
  });

  // AC-082-02: the flagged fact names exactly the unrecorded commits, in the
  // PR's own commit order.
  it("names the unrecorded commits in PR order", () => {
    const result = evaluateEvidence({
      sessions: [session(["bbbbbbbb"])],
      pendingLinkCount: 0,
      prCommitShas: [
        "cccccccccccccccccccccccccccccccccccccccc",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    });

    expect(result.facts[0]).toMatchObject({
      matchedCommitCount: 1,
      totalCommitCount: 3,
      unrecordedShas: [
        "cccccccccccccccccccccccccccccccccccccccc",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    });
  });

  // An unreadable commit list (null) and an empty PR (n = 0) both omit the
  // fact — the evaluation asserts nothing it cannot know, and with no
  // displayed facts the verdict is pass over what IS displayed.
  it("omits the provenance fact when commits are unreadable or absent", () => {
    const unreadable = evaluateEvidence({
      sessions: [session(["aaaaaaaa"])],
      pendingLinkCount: 0,
      prCommitShas: null,
    });
    const empty = evaluateEvidence({
      sessions: [session(["aaaaaaaa"])],
      pendingLinkCount: 0,
      prCommitShas: [],
    });

    for (const result of [unreadable, empty]) {
      expect(result.facts).toEqual([]);
      expect(result.verdict).toBe("pass");
    }
  });

  // AC-082-05: no confirmed session yet, pending candidates syncing — the
  // verdict is "waiting", never a judgment on no evidence.
  it("derives waiting when there are no confirmed sessions but pending links exist", () => {
    const result = evaluateEvidence({
      sessions: [],
      pendingLinkCount: 2,
      prCommitShas: null,
    });

    expect(result).toEqual({
      verdict: "waiting",
      facts: [],
      flaggedCount: 0,
      pendingLinkCount: 2,
    });
  });

  // AC-082-07: unchanged inputs, identical evaluation — no clock, no
  // randomness, no ordering drift.
  it("is deterministic: the same inputs evaluate identically every time", () => {
    const input = {
      sessions: [session(["1a2b3c4d", "9f8e7d6c"]), session([])],
      pendingLinkCount: 1,
      prCommitShas: [
        "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d",
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      ],
    };

    expect(evaluateEvidence(input)).toStrictEqual(evaluateEvidence(input));
  });
});
