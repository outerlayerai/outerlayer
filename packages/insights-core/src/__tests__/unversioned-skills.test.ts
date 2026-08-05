// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import {
  unversionedSkillsFinding,
  type ActivatedSkillUse,
} from "../detectors/unversioned-skills.js";

const use = (skillName: string, totalSessions: number): ActivatedSkillUse => ({
  skillName,
  totalSessions,
  totalActivations: totalSessions * 3,
});

describe("unversionedSkillsFinding", () => {
  it("flags activated-but-not-installed skills above the floor, ranked by sessions", () => {
    const finding = unversionedSkillsFinding({
      installedSkills: ["review"],
      activatedSkills: [use("review", 200), use("deep-research", 766), use("orchestrator", 40)],
      lookbackDays: 90,
    });
    // `review` is installed (excluded); the rest rank by sessions desc.
    expect(finding).toEqual({
      detectorId: "unversioned-skill",
      severity: "warn",
      sessionIds: [],
      evidence: [],
      costUsd: null,
      timeMin: null,
      summary:
        "2 skills your sessions rely on aren't in the repo: deep-research (766 sessions), orchestrator (40 sessions)",
      suggestion: expect.stringContaining("Add these to the repo"),
    });
  });

  it("returns null when everything used is either installed or below the reliance floor", () => {
    expect(
      unversionedSkillsFinding({
        installedSkills: ["review"],
        activatedSkills: [use("review", 900), use("one-off", 2)],
        lookbackDays: 90,
        minSessions: 5,
      }),
    ).toBeNull();
  });

  it("fires even with an empty installed set — a repo with no skills but real reliance", () => {
    const finding = unversionedSkillsFinding({
      installedSkills: [],
      activatedSkills: [use("deep-research", 766)],
      lookbackDays: 90,
    });
    expect(finding?.summary).toBe(
      "1 skill your sessions rely on isn't in the repo: deep-research (766 sessions)",
    );
  });

  it("caps the named list and folds the remainder", () => {
    const finding = unversionedSkillsFinding({
      installedSkills: [],
      activatedSkills: [use("a", 60), use("b", 50), use("c", 40), use("d", 30), use("e", 20), use("f", 10), use("g", 6)],
      lookbackDays: 90,
      maxListed: 2,
    });
    expect(finding?.summary).toBe(
      "7 skills your sessions rely on aren't in the repo: a (60 sessions), b (50 sessions), +5 more",
    );
  });

  it("respects a custom session floor at the boundary", () => {
    // 5 sessions is the default floor — exactly-at counts, one-below does not.
    expect(
      unversionedSkillsFinding({ installedSkills: [], activatedSkills: [use("x", 5)], lookbackDays: 90 })?.summary,
    ).toContain("x (5 sessions)");
    expect(
      unversionedSkillsFinding({ installedSkills: [], activatedSkills: [use("x", 4)], lookbackDays: 90 }),
    ).toBeNull();
  });
});
