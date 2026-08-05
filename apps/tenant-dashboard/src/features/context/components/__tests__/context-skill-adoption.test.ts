import { describe, expect, it } from "vitest";
import {
  skillAdoptionInfo,
  indexSkillActivations,
  type SkillActivation,
} from "../context-skill-adoption";

const activation = (over: Partial<SkillActivation>): SkillActivation => ({
  skillName: "s",
  recentActivations: 0,
  totalActivations: 0,
  totalSessions: 0,
  lastActivatedAt: null,
  ...over,
});

describe("skillAdoptionInfo", () => {
  it("undefined activation → never with zeroed counts (installed, unused)", () => {
    expect(skillAdoptionInfo(undefined)).toEqual({
      status: "never",
      recentActivations: 0,
      totalActivations: 0,
      lastActivatedAt: null,
    });
  });

  it("zero recent but some total → quiet, carrying the counts through", () => {
    expect(skillAdoptionInfo(activation({ recentActivations: 0, totalActivations: 7, lastActivatedAt: "2026-06-01 00:00:00" }))).toEqual({
      status: "quiet",
      recentActivations: 0,
      totalActivations: 7,
      lastActivatedAt: "2026-06-01 00:00:00",
    });
  });

  it("any recent activation → active", () => {
    // The 0/1 boundary is the active↔quiet line — pin it exactly.
    expect(skillAdoptionInfo(activation({ recentActivations: 1, totalActivations: 1 })).status).toBe("active");
  });
});

describe("indexSkillActivations", () => {
  it("keys rows by skill name for O(1) lookup", () => {
    const rows = [activation({ skillName: "a", recentActivations: 3 }), activation({ skillName: "b" })];
    const map = indexSkillActivations(rows);
    expect(map.get("a")?.recentActivations).toBe(3);
    expect(map.get("b")).toEqual(activation({ skillName: "b" }));
    expect(map.has("missing")).toBe(false);
    expect(map.size).toBe(2);
  });
});
