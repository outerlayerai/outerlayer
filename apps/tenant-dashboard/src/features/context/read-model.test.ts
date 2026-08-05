/**
 * Pure derivation for the read-only Context API. These assertions pin the exact
 * classification/partition/annotation output for a realistic mixed tree, and the
 * per-kind frontmatter handling — the logic that would otherwise be invisible
 * behind the SWR hooks.
 */
import { describe, expect, it } from "vitest";
import { deriveFileResponse, deriveTreeResponse, type RawTreeRow } from "./read-model";

const HEAD = { commitSha: "abc123", snapshotId: "snap-1", syncedAt: "2026-07-10T00:00:00Z" };
const CONN = { repository: "acme/app", branch: "main" };

/** Mixed tree: nested scopes, a valid skill, a shadowed command, an orphan skill dir, mcp + config, external files. */
const ROWS: RawTreeRow[] = [
  { path: ".outerlayer/AGENTS.md", blobSha: "b1" },
  { path: ".outerlayer/mcp.json", blobSha: "b2" },
  { path: ".outerlayer/config.json", blobSha: "b3" },
  { path: ".outerlayer/commands/deploy.md", blobSha: "b4" },
  { path: ".outerlayer/skills/writing/SKILL.md", blobSha: "b5" },
  { path: ".outerlayer/skills/writing/references/style.md", blobSha: "b6" },
  { path: "apps/web/.outerlayer/AGENTS.md", blobSha: "b7" },
  { path: "apps/web/.outerlayer/commands/deploy.md", blobSha: "b8" },
  { path: "apps/web/.outerlayer/skills/orphan/references/note.md", blobSha: "b9" },
  { path: "CLAUDE.md", blobSha: "b10" },
  { path: "docs/AGENTS.md", blobSha: "b11" },
];

describe("deriveTreeResponse", () => {
  const result = deriveTreeResponse({ gitConnection: CONN, head: HEAD, rows: ROWS });

  it("carries the app publish policy through, defaulting to false when absent", () => {
    expect(result.requirePullRequest).toBe(false);
    expect(
      deriveTreeResponse({ gitConnection: CONN, head: HEAD, rows: ROWS, requirePullRequest: true })
        .requirePullRequest,
    ).toBe(true);
  });

  it("classifies + orders content entries, excluding config.json (unrecognized file) and external instructions", () => {
    expect(result.entries.map((e) => [e.path, e.kind, e.scopePath, e.skillName ?? null, e.blobSha])).toEqual([
      [".outerlayer/AGENTS.md", "instructions", "", null, "b1"],
      [".outerlayer/mcp.json", "mcp", "", null, "b2"],
      [".outerlayer/commands/deploy.md", "command", "", null, "b4"],
      [".outerlayer/skills/writing/SKILL.md", "skill", "", "writing", "b5"],
      [".outerlayer/skills/writing/references/style.md", "skill-reference", "", "writing", "b6"],
      ["apps/web/.outerlayer/AGENTS.md", "instructions", "apps/web", null, "b7"],
      ["apps/web/.outerlayer/commands/deploy.md", "command", "apps/web", null, "b8"],
      // Orphan skill reference (no SKILL.md) is demoted to a plain reference.
      ["apps/web/.outerlayer/skills/orphan/references/note.md", "reference", "apps/web", null, "b9"],
    ]);
  });

  it("derives missing-SKILL.md and shadowing issues, missing-skill first", () => {
    expect(result.issues).toEqual([
      {
        type: "missing-skill-md",
        path: "apps/web/.outerlayer/skills/orphan/SKILL.md",
        scopePath: "apps/web",
        detail: 'skill "orphan" has no SKILL.md',
      },
      {
        type: "shadowed",
        path: ".outerlayer/commands/deploy.md",
        scopePath: "",
        detail: 'command "deploy" is shadowed by a nearer definition at "apps/web"',
      },
    ]);
  });

  it("returns empty excludedCounts — asset/script paths are not mirrored, so the mirror has no source for them", () => {
    expect(result.excludedCounts).toEqual([]);
  });

  it("passes head + connection through unchanged", () => {
    expect(result.head).toEqual(HEAD);
    expect(result.gitConnection).toEqual(CONN);
  });

  it("reports no connection as a distinct empty-state shape", () => {
    const empty = deriveTreeResponse({ gitConnection: null, head: null, rows: [] });
    expect(empty).toEqual({
      gitConnection: null,
      head: null,
      entries: [],
      excludedCounts: [],
      issues: [],
      mcpServerCounts: [],
      requirePullRequest: false,
    });
  });

  it("counts mcp.json servers when the blob content is supplied", () => {
    const withMcp = deriveTreeResponse({
      gitConnection: CONN,
      head: HEAD,
      rows: [{ path: ".outerlayer/mcp.json", blobSha: "b2" }],
      mcpContents: new Map([[".outerlayer/mcp.json", JSON.stringify({ mcpServers: { a: {}, b: {}, c: {} } })]]),
    });
    expect(withMcp.mcpServerCounts).toEqual([{ path: ".outerlayer/mcp.json", count: 3, servers: ["a", "b", "c"] }]);
  });

  it("omits mcp counts when no blob content is supplied", () => {
    expect(result.mcpServerCounts).toEqual([]);
  });
});

describe("deriveFileResponse", () => {
  it("parses valid skill frontmatter with no issues", () => {
    const res = deriveFileResponse({
      path: ".outerlayer/skills/writing/SKILL.md",
      kind: "skill",
      blobSha: "b5",
      commitSha: "abc123",
      content: "---\nname: writing\ndescription: How to write\n---\nBody text\n",
    });
    expect(res.frontmatter.parsed).toEqual({ name: "writing", description: "How to write" });
    expect(res.frontmatter.issues).toEqual([]);
    expect(res.oversize).toBe(false);
  });

  it("flags a skill whose name does not equal its directory", () => {
    const res = deriveFileResponse({
      path: ".outerlayer/skills/writing/SKILL.md",
      kind: "skill",
      blobSha: "b5",
      commitSha: "abc123",
      content: "---\nname: wrong\ndescription: x\n---\n",
    });
    expect(res.frontmatter.issues.map((i) => i.code)).toEqual(["name_mismatch"]);
  });

  it("flags forbidden frontmatter on an AGENTS.md while still returning the parsed keys", () => {
    const res = deriveFileResponse({
      path: ".outerlayer/AGENTS.md",
      kind: "instructions",
      blobSha: "b1",
      commitSha: "abc123",
      content: "---\nfoo: bar\n---\nInstructions\n",
    });
    expect(res.frontmatter.parsed).toEqual({ foo: "bar" });
    expect(res.frontmatter.issues.map((i) => i.code)).toEqual(["frontmatter_forbidden"]);
  });

  it("warns on unknown frontmatter keys without erroring", () => {
    const res = deriveFileResponse({
      path: ".outerlayer/skills/writing/SKILL.md",
      kind: "skill",
      blobSha: "b5",
      commitSha: "abc123",
      content: "---\nname: writing\ndescription: x\nvibe: cosmic\n---\n",
    });
    expect(res.frontmatter.issues).toEqual([
      { path: "vibe", code: "unknown_key", message: 'unknown frontmatter key "vibe" — preserved, not validated' },
    ]);
  });

  it("blocks a literal secret in mcp.json env", () => {
    const res = deriveFileResponse({
      path: ".outerlayer/mcp.json",
      kind: "mcp",
      blobSha: "b2",
      commitSha: "abc123",
      content: JSON.stringify({ mcpServers: { gh: { command: "srv", env: { TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } } } }),
    });
    expect(res.frontmatter.parsed).toBeNull();
    expect(res.frontmatter.issues.some((i) => i.code === "secret-literal")).toBe(true);
  });

  it("marks an oversize blob (content not mirrored) without parsing", () => {
    const res = deriveFileResponse({
      path: ".outerlayer/skills/big/SKILL.md",
      kind: "skill",
      blobSha: "b99",
      commitSha: "abc123",
      content: null,
    });
    expect(res).toEqual({
      path: ".outerlayer/skills/big/SKILL.md",
      kind: "skill",
      blobSha: "b99",
      commitSha: "abc123",
      content: null,
      oversize: true,
      frontmatter: { parsed: null, issues: [] },
    });
  });

  it("validates a subagent's name against its FILENAME STEM, not its directory", () => {
    // name equals the stem → clean; the dir ("subagents") must play no part.
    const ok = deriveFileResponse({
      path: ".outerlayer/subagents/reviewer.md",
      kind: "subagent",
      blobSha: "b7",
      commitSha: "abc123",
      content: "---\nname: reviewer\ndescription: reviews\n---\n",
    });
    expect(ok.frontmatter.issues).toEqual([]);

    const mismatched = deriveFileResponse({
      path: ".outerlayer/subagents/reviewer.md",
      kind: "subagent",
      blobSha: "b7",
      commitSha: "abc123",
      content: "---\nname: other\ndescription: reviews\n---\n",
    });
    expect(mismatched.frontmatter.issues.map((i) => i.code)).toEqual(["name_mismatch"]);
  });

  it("derives the skill dir name from the segment AFTER skills/ even when nested deep", () => {
    // A scoped skill: the dir-name check must find "writing", not "apps" or "web".
    const res = deriveFileResponse({
      path: "apps/web/.outerlayer/skills/writing/SKILL.md",
      kind: "skill",
      blobSha: "b8",
      commitSha: "abc123",
      content: "---\nname: writing\ndescription: x\n---\n",
    });
    expect(res.frontmatter.issues).toEqual([]);
  });

  it("counts servers from supplied mcp content, and a malformed blob counts as 0", () => {
    const rows = [
      { path: ".outerlayer/mcp.json", blobSha: "m1" },
      { path: "apps/web/.outerlayer/mcp.json", blobSha: "m2" },
    ];
    const res = deriveTreeResponse({
      gitConnection: CONN,
      head: HEAD,
      rows,
      mcpContents: new Map([
        [".outerlayer/mcp.json", "{ not json"],
        ["apps/web/.outerlayer/mcp.json", JSON.stringify({ mcpServers: { a: {}, b: {} } })],
      ]),
    });
    expect(res.mcpServerCounts).toEqual([
      { path: ".outerlayer/mcp.json", count: 0, servers: [] },
      { path: "apps/web/.outerlayer/mcp.json", count: 2, servers: ["a", "b"] },
    ]);
  });

  it("omits a count for an mcp entry whose blob is NOT in the supplied map", () => {
    const res = deriveTreeResponse({
      gitConnection: CONN,
      head: HEAD,
      rows: [
        { path: ".outerlayer/mcp.json", blobSha: "m1" },
        { path: "apps/web/.outerlayer/mcp.json", blobSha: "m2" },
      ],
      mcpContents: new Map([
        ["apps/web/.outerlayer/mcp.json", JSON.stringify({ mcpServers: { a: {} } })],
      ]),
    });
    expect(res.mcpServerCounts).toEqual([{ path: "apps/web/.outerlayer/mcp.json", count: 1, servers: ["a"] }]);
  });

  it("treats an mcpServers value that is not an object as 0 servers", () => {
    const res = deriveTreeResponse({
      gitConnection: CONN,
      head: HEAD,
      rows: [{ path: ".outerlayer/mcp.json", blobSha: "m1" }],
      mcpContents: new Map([
        [".outerlayer/mcp.json", JSON.stringify({ mcpServers: "nope" })],
      ]),
    });
    expect(res.mcpServerCounts).toEqual([{ path: ".outerlayer/mcp.json", count: 0, servers: [] }]);
  });
});
