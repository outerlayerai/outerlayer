// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { skillNamesFromPaths, unusedSkillsFinding } from "../detectors/unused-skills.js";

describe("skillNamesFromPaths", () => {
  it("takes the segment after `skills`, deduped and sorted, across scopes", () => {
    expect(
      skillNamesFromPaths([
        ".outerlayer/skills/writing/SKILL.md",
        ".outerlayer/skills/writing/references/style.md",
        "apps/web/.outerlayer/skills/deploy/SKILL.md",
        ".outerlayer/AGENTS.md",
        ".outerlayer/commands/ship.md",
      ]),
    ).toEqual(["deploy", "writing"]);
  });

  it("ignores a trailing `skills` segment with no name after it", () => {
    expect(skillNamesFromPaths([".outerlayer/skills"])).toEqual([]);
  });
});

describe("unusedSkillsFinding", () => {
  it("returns null when every installed skill was activated", () => {
    expect(
      unusedSkillsFinding({
        installedSkills: ["a", "b"],
        activatedSkillNames: new Set(["a", "b", "c"]),
        lookbackDays: 90,
      }),
    ).toBeNull();
  });

  it("flags only the installed skills with no activation, sorted, with honest null cost", () => {
    const finding = unusedSkillsFinding({
      installedSkills: ["review", "blog-writer", "deploy"],
      activatedSkillNames: new Set(["review"]),
      lookbackDays: 90,
    });
    expect(finding).toEqual({
      detectorId: "unused-skill",
      severity: "warn",
      sessionIds: [],
      evidence: [],
      costUsd: null,
      timeMin: null,
      summary: "2 installed skills never activated in 90 days: blog-writer, deploy",
      suggestion: expect.stringContaining("Remove or revise"),
    });
  });

  it("singularizes the noun for exactly one unused skill", () => {
    const finding = unusedSkillsFinding({
      installedSkills: ["solo"],
      activatedSkillNames: new Set<string>(),
      lookbackDays: 30,
    });
    expect(finding?.summary).toBe("1 installed skill never activated in 30 days: solo");
  });

  it("caps the named list and folds the remainder into +N more", () => {
    const finding = unusedSkillsFinding({
      installedSkills: ["a", "b", "c", "d", "e", "f", "g", "h"],
      activatedSkillNames: new Set<string>(),
      lookbackDays: 90,
      maxListed: 3,
    });
    // 8 unused, 3 named, 5 folded.
    expect(finding?.summary).toBe("8 installed skills never activated in 90 days: a, b, c, +5 more");
  });
});
