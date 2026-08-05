import { describe, expect, it } from "vitest";
import {
  buildFolderKeepPath,
  buildScopeKindPath,
  buildTargetedFilePath,
  createLocationFor,
  dirDeleteAffordance,
  folderExists,
  nameError,
  pathExceedsLengthLimits,
  pathExists,
  pathLengthErrorKey,
  staleFolderKeepDrafts,
} from "../context-create";

describe("createLocationFor", () => {
  it("returns the full kind menu at the scope's .outerlayer root", () => {
    expect(createLocationFor(".outerlayer", ".outerlayer")).toEqual({
      area: "root",
      fileKind: null,
      fileBaseDir: ".outerlayer",
      folderAllowed: true,
      folderBaseDir: ".outerlayer",
      actionsSuppressed: false,
    });
  });

  it("makes agents/ create a flat subagent and refuses a folder", () => {
    const loc = createLocationFor(".outerlayer/agents", ".outerlayer");
    expect(loc.area).toBe("agents");
    expect(loc.fileKind).toBe("subagent");
    expect(loc.fileBaseDir).toBe(".outerlayer/agents");
    expect(loc.folderAllowed).toBe(false);
  });

  it("nests a command and allows a namespace folder inside commands/ at any depth", () => {
    const loc = createLocationFor(".outerlayer/commands/deploy", ".outerlayer");
    expect(loc).toEqual({
      area: "commands",
      fileKind: "command",
      fileBaseDir: ".outerlayer/commands/deploy",
      folderAllowed: true,
      folderBaseDir: ".outerlayer/commands/deploy",
      actionsSuppressed: false,
    });
  });

  it("routes a skill dir's file/folder into its references/ subtree", () => {
    const loc = createLocationFor(".outerlayer/skills/writing", ".outerlayer");
    expect(loc.area).toBe("skill");
    expect(loc.fileKind).toBe("document");
    expect(loc.fileBaseDir).toBe(".outerlayer/skills/writing/references");
    expect(loc.folderBaseDir).toBe(".outerlayer/skills/writing/references");
    expect(loc.folderAllowed).toBe(true);
  });

  it("targets a references subdir directly, not references/references", () => {
    const loc = createLocationFor(".outerlayer/skills/writing/references/guides", ".outerlayer");
    expect(loc.fileBaseDir).toBe(".outerlayer/skills/writing/references/guides");
  });

  it("offers both actions on the bare skills/ dir: a skill file and a folder", () => {
    const loc = createLocationFor(".outerlayer/skills", ".outerlayer");
    expect(loc).toEqual({
      area: "skills-root",
      fileKind: "skill",
      fileBaseDir: ".outerlayer/skills",
      folderAllowed: true,
      folderBaseDir: ".outerlayer/skills",
      actionsSuppressed: false,
    });
    // The file action creates a skill scaffold at its fixed shape…
    expect(buildScopeKindPath("skill", "", "research")).toBe(".outerlayer/skills/research/SKILL.md");
    // …and the folder action stages a .gitkeep under skills/ (a SKILL.md-less dir).
    expect(buildFolderKeepPath(loc.folderBaseDir, "research")).toBe(".outerlayer/skills/research/.gitkeep");
  });

  it("treats any other dir as a generic document / plain folder location", () => {
    const loc = createLocationFor(".outerlayer/docs/guides", ".outerlayer");
    expect(loc).toEqual({
      area: "generic",
      fileKind: "document",
      fileBaseDir: ".outerlayer/docs/guides",
      folderAllowed: true,
      folderBaseDir: ".outerlayer/docs/guides",
      actionsSuppressed: false,
    });
  });

  it("resolves a nested scope's .outerlayer root correctly", () => {
    const loc = createLocationFor("apps/api/.outerlayer", "apps/api/.outerlayer");
    expect(loc.area).toBe("root");
    expect(loc.fileBaseDir).toBe("apps/api/.outerlayer");
  });
});

describe("nameError", () => {
  it("accepts a valid slug and rejects the empty name", () => {
    expect(nameError("deploy-prod")).toBeNull();
    expect(nameError("")).toBe("dashboard.context.create.validation.enterName");
  });

  it("rejects uppercase and illegal characters with the slug key", () => {
    expect(nameError("Deploy")).toBe("dashboard.context.create.validation.slug");
    expect(nameError("a_b")).toBe("dashboard.context.create.validation.slug");
  });

  it("rejects a slash when nesting is not allowed, allows it when it is", () => {
    expect(nameError("deploy/ship", { allowSlash: false })).toBe("dashboard.context.create.validation.slug");
    expect(nameError("deploy/ship", { allowSlash: true })).toBeNull();
  });

  it("rejects .. and empty path segments even when nesting is allowed", () => {
    expect(nameError("deploy/../etc", { allowSlash: true })).toBe("dashboard.context.create.validation.slug");
    expect(nameError("deploy//ship", { allowSlash: true })).toBe("dashboard.context.create.validation.emptySegment");
    expect(nameError("deploy/", { allowSlash: true })).toBe("dashboard.context.create.validation.emptySegment");
  });

  it("applies the stricter subagent charset (no digits) and its own message", () => {
    expect(nameError("agent1", { subagent: true })).toBe("dashboard.context.create.validation.subagentSlug");
    expect(nameError("code-reviewer", { subagent: true })).toBeNull();
  });

  it("enforces the max length with the skill message", () => {
    expect(nameError("a".repeat(65), { maxLen: 64 })).toBe("dashboard.context.create.validation.skillMax");
  });

  it("caps every segment at 64 chars (files, folders, and nested names)", () => {
    expect(nameError("a".repeat(64), { allowSlash: true })).toBeNull();
    expect(nameError("a".repeat(65), { allowSlash: true })).toBe(
      "dashboard.context.create.validation.segmentMax",
    );
    // A long segment anywhere in a nested path fails, not just the first.
    expect(nameError(`ok/${"b".repeat(65)}`, { allowSlash: true })).toBe(
      "dashboard.context.create.validation.segmentMax",
    );
  });
});

describe("path length caps", () => {
  it("flags a full path over 180 chars, allows exactly 180", () => {
    expect(pathLengthErrorKey("a".repeat(180))).toBeNull();
    expect(pathLengthErrorKey("a".repeat(181))).toBe(
      "dashboard.context.create.validation.pathMax",
    );
  });

  it("pathExceedsLengthLimits catches an over-length segment even on a short path", () => {
    expect(pathExceedsLengthLimits(`.outerlayer/skills/${"a".repeat(65)}/SKILL.md`)).toBe(true);
    expect(pathExceedsLengthLimits(`.outerlayer/skills/${"a".repeat(64)}/SKILL.md`)).toBe(false);
  });

  it("pathExceedsLengthLimits catches a 181-char path built from in-cap segments", () => {
    // Three ≤64-char segments: 60/60/58 → 180 total (ok), 60/60/59 → 181 (over).
    const ok = `${"a".repeat(60)}/${"a".repeat(60)}/${"a".repeat(58)}`;
    const over = `${"a".repeat(60)}/${"a".repeat(60)}/${"a".repeat(59)}`;
    expect(ok.length).toBe(180);
    expect(over.length).toBe(181);
    expect(pathExceedsLengthLimits(ok)).toBe(false);
    expect(pathExceedsLengthLimits(over)).toBe(true);
  });
});

describe("staleFolderKeepDrafts", () => {
  it("drops a folder keep whose dir gained a published child, keeping unrelated keeps", () => {
    const keeps = [
      ".outerlayer/commands/materialized/.gitkeep",
      ".outerlayer/commands/still-empty/.gitkeep",
    ];
    // The server tree gained a child under `materialized/` (published first).
    const tree = new Set([
      ".outerlayer/commands/materialized/run.md",
      ".outerlayer/commands/other.md",
    ]);
    expect(staleFolderKeepDrafts(keeps, tree)).toEqual([
      ".outerlayer/commands/materialized/.gitkeep",
    ]);
  });

  it("treats a dir that exists as its own entry as materialized", () => {
    const keeps = [".outerlayer/skills/my-skill/.gitkeep"];
    const tree = new Set([".outerlayer/skills/my-skill"]);
    expect(staleFolderKeepDrafts(keeps, tree)).toEqual([".outerlayer/skills/my-skill/.gitkeep"]);
  });

  it("ignores non-gitkeep draft paths and never false-matches a sibling prefix", () => {
    const keeps = [
      ".outerlayer/commands/build.md", // not a folder keep
      ".outerlayer/commands/foo/.gitkeep",
    ];
    // `foobar` shares a textual prefix with `foo` but is NOT under it.
    const tree = new Set([".outerlayer/commands/foobar/run.md"]);
    expect(staleFolderKeepDrafts(keeps, tree)).toEqual([]);
  });
});

describe("duplicate detection", () => {
  const existing = new Set([".outerlayer/commands/ship.md", ".outerlayer/docs/guides/intro.md"]);

  it("matches an exact path case-insensitively", () => {
    expect(pathExists(".outerlayer/commands/SHIP.md", existing)).toBe(true);
    expect(pathExists(".outerlayer/commands/other.md", existing)).toBe(false);
  });

  it("reports a folder as existing when any path sits under it", () => {
    expect(folderExists(".outerlayer/docs/guides", existing)).toBe(true);
    expect(folderExists(".outerlayer/DOCS", existing)).toBe(true);
    expect(folderExists(".outerlayer/other", existing)).toBe(false);
  });
});

describe("path builders", () => {
  it("builds a targeted file path and a folder keeper path", () => {
    expect(buildTargetedFilePath(".outerlayer/commands/deploy", "ship")).toBe(".outerlayer/commands/deploy/ship.md");
    expect(buildFolderKeepPath(".outerlayer/docs", "guides")).toBe(".outerlayer/docs/guides/.gitkeep");
  });
});

describe("dirDeleteAffordance", () => {
  it("refuses the four bare scope dirs — .outerlayer, agents/, commands/, skills/", () => {
    expect(dirDeleteAffordance(".outerlayer", ".outerlayer")).toBeNull();
    expect(dirDeleteAffordance(".outerlayer/agents", ".outerlayer")).toBeNull();
    expect(dirDeleteAffordance(".outerlayer/commands", ".outerlayer")).toBeNull();
    expect(dirDeleteAffordance(".outerlayer/skills", ".outerlayer")).toBeNull();
  });

  it("gives a nested command namespace folder a generic dir delete", () => {
    expect(dirDeleteAffordance(".outerlayer/commands/deploy", ".outerlayer")).toEqual({
      kind: "dir",
      dirPath: ".outerlayer/commands/deploy",
    });
  });

  it("gives a skill's own root dir the skill-flavored delete target", () => {
    expect(dirDeleteAffordance(".outerlayer/skills/writing", ".outerlayer")).toEqual({
      kind: "skill",
      skillDir: ".outerlayer/skills/writing",
    });
  });

  it("gives a subdirectory INSIDE a skill (e.g. references/) a generic dir delete, not the skill flavor", () => {
    expect(dirDeleteAffordance(".outerlayer/skills/writing/references", ".outerlayer")).toEqual({
      kind: "dir",
      dirPath: ".outerlayer/skills/writing/references",
    });
  });

  it("gives an ordinary folder a generic dir delete", () => {
    expect(dirDeleteAffordance(".outerlayer/docs/guides", ".outerlayer")).toEqual({
      kind: "dir",
      dirPath: ".outerlayer/docs/guides",
    });
  });
});
