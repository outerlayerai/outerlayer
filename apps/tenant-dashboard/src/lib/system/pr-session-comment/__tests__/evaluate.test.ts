/**
 * evaluateEvidence: the pure facts-in, verdict-out core behind the evidence
 * comment. Plain objects in, a plain evaluation out — this is where the
 * commit-provenance matching rules and the fact→verdict mapping of
 * `acceptance/082-evidence-comment.md` get proven.
 */
import { describe, it, expect } from "vitest";

import {
  evaluateEvidence,
  type CustomValidationFact,
  type PolicyErrorFact,
  type VerificationFact,
} from "../evaluate";

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

  // The guard cuts both ways: a PR-side sha below seven characters must not
  // match either, even when a full recorded sha starts with it — without
  // the guard, "abc12" would prefix-match into any recorded sha that
  // happens to begin with it. Exactly seven is the floor and must match.
  it("never matches a PR commit sha shorter than seven characters, and matches at exactly seven", () => {
    const recorded = ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"];

    const tooShort = evaluateEvidence({
      sessions: [session(recorded)],
      pendingLinkCount: 0,
      prCommitShas: ["1a2b3c"],
    });
    expect(tooShort.facts[0]).toMatchObject({ status: "flag", matchedCommitCount: 0 });

    const atFloor = evaluateEvidence({
      sessions: [session(recorded)],
      pendingLinkCount: 0,
      prCommitShas: ["1a2b3c4"],
    });
    expect(atFloor.facts[0]).toMatchObject({ status: "pass", matchedCommitCount: 1 });
  });

  // Recorded shas are transcript-derived and arrive sanitized at no hop, so
  // stray whitespace must not defeat the match.
  it("trims recorded shas before matching", () => {
    const result = evaluateEvidence({
      sessions: [session(["  1a2b3c4d  "])],
      pendingLinkCount: 0,
      prCommitShas: ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"],
    });

    expect(result.facts[0]).toMatchObject({ status: "pass", matchedCommitCount: 1 });
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

const verification = (over: Partial<VerificationFact> = {}): VerificationFact => ({
  id: "red-then-green",
  status: "pass",
  class: "amber",
  sentence: "New tests failed first, then passed",
  refs: [{ traceId: "t1", turnIndex: 61 }],
  ...over,
});

describe("evaluateEvidence with verification facts", () => {
  // AC-083-11
  it("appends verification facts to the displayed facts unchanged", () => {
    const fact = verification();
    const result = evaluateEvidence({
      sessions: [session(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])],
      pendingLinkCount: 0,
      prCommitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      verificationFacts: [fact],
    });

    expect(result.verdict).toBe("pass");
    expect(result.facts).toEqual([
      expect.objectContaining({ id: "commits-from-sessions", status: "pass" }),
      fact,
    ]);
  });

  it("counts an amber verification flag in flaggedCount and derives flag, not unverifiable", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      verificationFacts: [
        verification({
          id: "no-test-tampering",
          status: "flag",
          sentence: "A failing test was made to pass by changing the test, not the code",
        }),
      ],
    });

    expect(result.verdict).toBe("flag");
    expect(result.flaggedCount).toBe(1);
  });

  // AC-083-12
  it("derives unverifiable from a flagged red-class verification fact", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      verificationFacts: [
        verification({
          id: "no-test-tampering",
          status: "flag",
          class: "red",
          sentence: "A git command skipped the repo's checks",
          refs: [{ traceId: "t1", turnIndex: 88 }],
        }),
      ],
    });

    expect(result.verdict).toBe("unverifiable");
    expect(result.flaggedCount).toBe(1);
  });

  // A red-class fact that PASSES must not scare the verdict — only a
  // flagged red fact voids it.
  it("ignores fact class entirely when the fact passes", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      verificationFacts: [verification({ class: "red" })],
    });

    expect(result.verdict).toBe("pass");
  });
});

const custom = (over: Partial<CustomValidationFact> = {}): CustomValidationFact => ({
  type: "custom-validation",
  id: "migration-must-run",
  status: "flag",
  class: "amber",
  level: "warn",
  sentence: "Migrations ran against a local database",
  refs: [],
  source: null,
  ...over,
});

describe("evaluateEvidence under a policy", () => {
  // proves AC-085-01
  it("removes an off-leveled built-in fact entirely while others still evaluate", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      verificationFacts: [verification()],
      factLevels: { "commits-from-sessions": "off" },
    });
    expect(result.facts).toEqual([verification()]);
    expect(result.verdict).toBe("pass");
  });

  // proves AC-085-02
  it("evaluates exactly as before when no policy levels are supplied", () => {
    const input = {
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      verificationFacts: [verification({ status: "flag" as const })],
    };
    expect(evaluateEvidence(input)).toEqual(evaluateEvidence({ ...input, factLevels: {} }));
    expect(evaluateEvidence(input).flaggedCount).toBe(2);
  });

  // proves AC-085-03
  it("keeps an info-leveled flag visible without counting it toward the verdict", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      verificationFacts: [verification({ status: "flag" })],
      factLevels: { "red-then-green": "info" },
    });
    expect(result.facts).toEqual([verification({ status: "flag", level: "info" })]);
    expect(result.flaggedCount).toBe(0);
    expect(result.verdict).toBe("pass");
  });

  it("counts custom warn flags in the verdict and displays custom rows after built-ins", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      verificationFacts: [verification()],
      customFacts: [custom()],
    });
    expect(result.facts).toEqual([verification(), custom()]);
    expect(result.verdict).toBe("flag");
    expect(result.flaggedCount).toBe(1);
  });

  it("keeps info-level and not-checkable custom rows out of the flag count", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      customFacts: [
        custom({ id: "a-info", level: "info" }),
        custom({ id: "b-blind", status: "not_checkable" }),
      ],
    });
    expect(result.verdict).toBe("pass");
    expect(result.flaggedCount).toBe(0);
    expect(result.facts).toHaveLength(2);
  });

  // proves AC-085-14
  it("never derives unverifiable from custom flags — user checks cap at amber", () => {
    const result = evaluateEvidence({
      sessions: [session([])],
      pendingLinkCount: 0,
      prCommitShas: null,
      customFacts: [custom(), custom({ id: "second" }), custom({ id: "third" })],
    });
    expect(result.verdict).toBe("flag");
  });

  // proves AC-085-13
  it("appends the single policy-error fact, flagged, after everything else", () => {
    const error: PolicyErrorFact = {
      type: "policy-error",
      status: "flag",
      class: "amber",
      file: ".outerlayer/policy.yaml",
      problem: 'unknown extends "outerlayer:strict@v9" — the only supported registry is outerlayer:recommended@v1',
      additionalProblemCount: 2,
    };
    const result = evaluateEvidence({
      sessions: [session(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])],
      pendingLinkCount: 0,
      prCommitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      verificationFacts: [verification()],
      policyError: error,
    });
    expect(result.facts[result.facts.length - 1]).toEqual(error);
    expect(result.facts).toHaveLength(3);
    expect(result.verdict).toBe("flag");
    expect(result.flaggedCount).toBe(1);
  });
});
