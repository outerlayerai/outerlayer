/**
 * Pure builder for the literal file tree. Asserts exact node order,
 * nesting depth, badge placement, and the excluded-files note — the structure
 * the tree component renders 1:1. Folders sort before files, each alphabetical.
 */
import { describe, expect, it } from "vitest";
import { buildContextTreeModel, type TreeNode } from "../context-tree-model";
import type { ContextTreeResponse } from "../../types";

const RESPONSE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "abc", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
    { path: ".outerlayer/commands/deploy.md", kind: "command", scopePath: "", blobSha: "b2" },
    { path: ".outerlayer/skills/writing/SKILL.md", kind: "skill", scopePath: "", skillName: "writing", blobSha: "b3" },
    { path: ".outerlayer/skills/writing/references/style.md", kind: "skill-reference", scopePath: "", skillName: "writing", blobSha: "b4" },
    { path: ".outerlayer/skills/orphan/references/note.md", kind: "reference", scopePath: "", blobSha: "b5" },
    { path: "apps/web/.outerlayer/commands/deploy.md", kind: "command", scopePath: "apps/web", blobSha: "b6" },
  ],
  excludedCounts: [{ scopePath: "", skillName: "writing", count: 3 }],
  issues: [
    { type: "missing-skill-md", path: ".outerlayer/skills/orphan/SKILL.md", scopePath: "", detail: 'skill "orphan" has no SKILL.md' },
    { type: "shadowed", path: ".outerlayer/commands/deploy.md", scopePath: "", detail: 'command "deploy" is shadowed by a nearer definition at "apps/web"' },
  ],
  mcpServerCounts: [],
};

interface FlatRow {
  depth: number;
  type: "dir" | "file";
  name: string;
  badges: string[];
  excludedCount: number | null;
}

function flatten(nodes: TreeNode[], depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const node of nodes) {
    out.push({
      depth,
      type: node.type,
      name: node.name,
      badges: node.badges.map((b) => b.type),
      excludedCount: node.type === "dir" ? node.excludedCount : null,
    });
    if (node.type === "dir") flatten(node.children, depth + 1, out);
  }
  return out;
}

describe("buildContextTreeModel", () => {
  const model = buildContextTreeModel(RESPONSE);

  it("orders scope sections root-first, labelled by scope path (root) with the real .outerlayer dir", () => {
    expect(model.scopes.map((s) => s.scopeLabel)).toEqual(["root", "apps/web"]);
    expect(model.scopes.map((s) => s.scopeDir)).toEqual([".outerlayer", "apps/web/.outerlayer"]);
  });

  it("attaches the mcp server count to the mcp.json node", () => {
    const withMcp = buildContextTreeModel({
      ...RESPONSE,
      entries: [{ path: ".outerlayer/mcp.json", kind: "mcp", scopePath: "", blobSha: "m1" }],
      excludedCounts: [],
      issues: [],
      mcpServerCounts: [{ path: ".outerlayer/mcp.json", count: 4, servers: ["a", "b", "c", "d"] }],
    });
    const mcpNode = withMcp.scopes[0]!.children.find((n) => n.type === "file" && n.name === "mcp.json");
    expect(mcpNode?.type === "file" ? mcpNode.mcpServerCount : undefined).toBe(4);
  });

  it("reconstructs the root scope's directories and files with badges and the excluded-files note", () => {
    expect(flatten(model.scopes[0]!.children)).toEqual([
      { depth: 0, type: "dir", name: "commands", badges: [], excludedCount: null },
      { depth: 1, type: "file", name: "deploy.md", badges: ["shadowed"], excludedCount: null },
      { depth: 0, type: "dir", name: "skills", badges: [], excludedCount: null },
      { depth: 1, type: "dir", name: "orphan", badges: ["missing-skill-md"], excludedCount: null },
      { depth: 2, type: "dir", name: "references", badges: [], excludedCount: null },
      { depth: 3, type: "file", name: "note.md", badges: [], excludedCount: null },
      { depth: 1, type: "dir", name: "writing", badges: [], excludedCount: 3 },
      { depth: 2, type: "dir", name: "references", badges: [], excludedCount: null },
      { depth: 3, type: "file", name: "style.md", badges: [], excludedCount: null },
      { depth: 2, type: "file", name: "SKILL.md", badges: [], excludedCount: null },
      { depth: 0, type: "file", name: "AGENTS.md", badges: [], excludedCount: null },
    ]);
  });

  it("does not badge the winning (nearer-scope) copy of a shadowed command", () => {
    expect(flatten(model.scopes[1]!.children)).toEqual([
      { depth: 0, type: "dir", name: "commands", badges: [], excludedCount: null },
      { depth: 1, type: "file", name: "deploy.md", badges: [], excludedCount: null },
    ]);
  });

  it("carries the excluded-file count on the skill dir (view formats the plural)", () => {
    const single = buildContextTreeModel({
      ...RESPONSE,
      excludedCounts: [{ scopePath: "", skillName: "writing", count: 1 }],
    });
    const writing = flatten(single.scopes[0]!.children).find((r) => r.name === "writing");
    expect(writing?.excludedCount).toBe(1);
  });

  it("merges a pending-PR path absent from the mirror as a synthetic file with a pending-pr badge", () => {
    const pendingPr = new Set([".outerlayer/commands/release.md"]);
    const withPr = buildContextTreeModel(RESPONSE, undefined, pendingPr);
    const rows = flatten(withPr.scopes[0]!.children);

    // The new file appears under the existing commands dir, tagged pending-pr.
    const release = rows.find((r) => r.name === "release.md");
    expect(release).toEqual({ depth: 1, type: "file", name: "release.md", badges: ["pending-pr"], excludedCount: null });
  });

  it("tags a mirrored path with pending-pr when it is in the pending-PR set and has no draft", () => {
    const pendingPr = new Set([".outerlayer/AGENTS.md"]);
    const withPr = buildContextTreeModel(RESPONSE, undefined, pendingPr);
    const agents = flatten(withPr.scopes[0]!.children).find((r) => r.name === "AGENTS.md");
    expect(agents?.badges).toEqual(["pending-pr"]);
  });

  it("prefers the create draft badge over pending-pr when a path is in both sets", () => {
    const drafts = new Map<string, "edit" | "create">([[".outerlayer/commands/release.md", "create"]]);
    const pendingPr = new Set([".outerlayer/commands/release.md"]);
    const withBoth = buildContextTreeModel(RESPONSE, drafts, pendingPr);
    const release = flatten(withBoth.scopes[0]!.children).find((r) => r.name === "release.md");
    expect(release?.badges).toEqual(["new"]);
  });

  it("badges a file as dirty when an edit draft targets its path — and only that file", () => {
    const drafts = new Map<string, "edit" | "create">([[".outerlayer/AGENTS.md", "edit"]]);
    const withDrafts = buildContextTreeModel(RESPONSE, drafts);
    const rows = flatten(withDrafts.scopes[0]!.children);

    const agents = rows.find((r) => r.name === "AGENTS.md");
    expect(agents?.badges).toEqual(["dirty"]);
    // No other file picks up the badge.
    const deploy = rows.find((r) => r.name === "deploy.md" && r.badges.includes("shadowed"));
    expect(deploy?.badges).toEqual(["shadowed"]);
  });

  it("badges a file `deleted` when a delete draft targets its path — and only that file", () => {
    const drafts = new Map<string, "edit" | "create" | "delete">([[".outerlayer/AGENTS.md", "delete"]]);
    const withDrafts = buildContextTreeModel(RESPONSE, drafts);
    const rows = flatten(withDrafts.scopes[0]!.children);

    const agents = rows.find((r) => r.name === "AGENTS.md");
    expect(agents?.badges).toEqual(["deleted"]);
    const deploy = rows.find((r) => r.name === "deploy.md" && r.badges.includes("shadowed"));
    expect(deploy?.badges).toEqual(["shadowed"]);
  });

  it("badges a misplaced file (nested subagent) on its own row, and keeps it browsable as a reference", () => {
    const withMisplaced = buildContextTreeModel({
      ...RESPONSE,
      entries: [
        { path: ".outerlayer/agents/team/reviewer.md", kind: "reference", scopePath: "", blobSha: "m1" },
      ],
      excludedCounts: [],
      issues: [
        {
          type: "misplaced",
          path: ".outerlayer/agents/team/reviewer.md",
          scopePath: "",
          detail: 'subagents live directly in agents/; the frontmatter "name" is the identity, so folders add nothing',
        },
      ],
    });

    expect(flatten(withMisplaced.scopes[0]!.children)).toEqual([
      { depth: 0, type: "dir", name: "agents", badges: [], excludedCount: null },
      { depth: 1, type: "dir", name: "team", badges: [], excludedCount: null },
      { depth: 2, type: "file", name: "reviewer.md", badges: ["misplaced"], excludedCount: null },
    ]);
  });

  it("reconstructs an empty directory from a .gitkeep folder entry without rendering the .gitkeep as a file row", () => {
    const withFolder = buildContextTreeModel({
      ...RESPONSE,
      entries: [
        { path: ".outerlayer/docs/guides/.gitkeep", kind: "folder", scopePath: "", blobSha: "f1" },
        { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
      ],
      excludedCounts: [],
      issues: [],
    });
    const rows = flatten(withFolder.scopes[0]!.children);

    // The empty dirs are present; the `.gitkeep` itself is never a row.
    expect(rows).toEqual([
      { depth: 0, type: "dir", name: "docs", badges: [], excludedCount: null },
      { depth: 1, type: "dir", name: "guides", badges: [], excludedCount: null },
      { depth: 0, type: "file", name: "AGENTS.md", badges: [], excludedCount: null },
    ]);
    expect(rows.some((r) => r.name === ".gitkeep")).toBe(false);
  });

  it("marks a directory `new` when its .gitkeep is an unpublished create draft (ghost folder)", () => {
    const drafts = new Map<string, "edit" | "create">([[".outerlayer/docs/guides/.gitkeep", "create"]]);
    const model = buildContextTreeModel(
      {
        ...RESPONSE,
        entries: [{ path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" }],
        excludedCounts: [],
        issues: [],
      },
      drafts,
    );
    const rows = flatten(model.scopes[0]!.children);
    // The ghost folder shows and reads as new; the .gitkeep is never a row.
    expect(rows.find((r) => r.name === "guides")).toEqual({
      depth: 1,
      type: "dir",
      name: "guides",
      badges: ["new"],
      excludedCount: null,
    });
    expect(rows.some((r) => r.name === ".gitkeep")).toBe(false);
  });

  it("marks a directory `deleted` when its .gitkeep is a staged delete (published empty folder marked for removal)", () => {
    const drafts = new Map<string, "edit" | "create" | "delete">([[".outerlayer/docs/guides/.gitkeep", "delete"]]);
    const model = buildContextTreeModel(
      {
        ...RESPONSE,
        entries: [
          { path: ".outerlayer/docs/guides/.gitkeep", kind: "folder", scopePath: "", blobSha: "f1" },
          { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
        ],
        excludedCounts: [],
        issues: [],
      },
      drafts,
    );
    const rows = flatten(model.scopes[0]!.children);
    expect(rows.find((r) => r.name === "guides")).toEqual({
      depth: 1,
      type: "dir",
      name: "guides",
      badges: ["deleted"],
      excludedCount: null,
    });
  });

  it("reconstructs the intermediate dirs of a synthetic nested create draft", () => {
    const drafts = new Map<string, "edit" | "create">([[".outerlayer/commands/deploy/ship.md", "create"]]);
    const model = buildContextTreeModel(
      {
        ...RESPONSE,
        entries: [{ path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" }],
        excludedCounts: [],
        issues: [],
      },
      drafts,
    );
    expect(flatten(model.scopes[0]!.children)).toEqual([
      { depth: 0, type: "dir", name: "commands", badges: [], excludedCount: null },
      { depth: 1, type: "dir", name: "deploy", badges: [], excludedCount: null },
      { depth: 2, type: "file", name: "ship.md", badges: ["new"], excludedCount: null },
      { depth: 0, type: "file", name: "AGENTS.md", badges: [], excludedCount: null },
    ]);
  });
});

describe("buildContextTreeModel — skill adoption overlay", () => {
  /** Find the `skills/<name>` dir node in the root scope. */
  function skillDir(model: ReturnType<typeof buildContextTreeModel>, name: string) {
    const skills = model.scopes[0]!.children.find(
      (n): n is Extract<TreeNode, { type: "dir" }> => n.type === "dir" && n.name === "skills",
    );
    return skills?.children.find(
      (n): n is Extract<TreeNode, { type: "dir" }> => n.type === "dir" && n.name === name,
    );
  }

  const activation = (over: Partial<import("../context-skill-adoption").SkillActivation>) => ({
    skillName: "writing",
    recentActivations: 0,
    totalActivations: 0,
    totalSessions: 0,
    lastActivatedAt: null,
    ...over,
  });

  it("marks a skill's own dir with its skill name even without the overlay (selectable pre-load)", () => {
    const dir = skillDir(buildContextTreeModel(RESPONSE), "writing");
    expect(dir?.skillName).toBe("writing");
    // A plain (non-skill) dir is never marked — its row keeps the toggle click.
    const skills = buildContextTreeModel(RESPONSE).scopes[0]!.children.find(
      (n): n is Extract<TreeNode, { type: "dir" }> => n.type === "dir" && n.name === "skills",
    );
    expect(skills?.skillName).toBeUndefined();
  });

  it("recent activations → active, with the recent count carried for the badge", () => {
    const map = new Map([["writing", activation({ recentActivations: 12, totalActivations: 40, lastActivatedAt: "2026-07-16 09:00:00" })]]);
    const dir = skillDir(buildContextTreeModel(RESPONSE, undefined, undefined, map), "writing");
    expect(dir?.adoption).toEqual({
      status: "active",
      recentActivations: 12,
      totalActivations: 40,
      lastActivatedAt: "2026-07-16 09:00:00",
    });
  });

  it("activations in the lookback but none recent → quiet", () => {
    const map = new Map([["writing", activation({ recentActivations: 0, totalActivations: 8 })]]);
    expect(skillDir(buildContextTreeModel(RESPONSE, undefined, undefined, map), "writing")?.adoption?.status).toBe("quiet");
  });

  it("a skill dir absent from the activation map → never (installed but unused)", () => {
    // Empty map = data loaded, nothing fired. `writing` exists in the tree but
    // not the map, so it must read as never — the whole point of the overlay.
    const dir = skillDir(buildContextTreeModel(RESPONSE, undefined, undefined, new Map()), "writing");
    expect(dir?.adoption).toEqual({ status: "never", recentActivations: 0, totalActivations: 0, lastActivatedAt: null });
  });

  it("no activation map supplied → NO adoption annotation (unknown must not read as never)", () => {
    const dir = skillDir(buildContextTreeModel(RESPONSE), "writing");
    expect(dir?.adoption).toBeUndefined();
  });

  it("an activation for a skill with no dir in the tree does not conjure a phantom dir", () => {
    const map = new Map([["ghost", activation({ skillName: "ghost", recentActivations: 5 })]]);
    const model = buildContextTreeModel(RESPONSE, undefined, undefined, map);
    expect(skillDir(model, "ghost")).toBeUndefined();
    // And the real skill still resolves to never (it has no activation row).
    expect(skillDir(model, "writing")?.adoption?.status).toBe("never");
  });
});
