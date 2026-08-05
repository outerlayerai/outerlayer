// @vitest-environment jsdom
/**
 * Render tests for the literal file tree. The exact structure is
 * pinned by the tree-model unit test; here we verify the component renders that
 * model faithfully — scope headers, node order, badge placement (once, on the
 * right node), the excluded-files line — and that selecting a file reports its
 * full path.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContextTree, { isOverflowing, buildOuterlayerNode } from "../context-tree";
import type { ContextTreeResponse } from "../../types";

// Render with the real i18n + en.json so the no-match / server-count copy
// assertions prove the translation keys and params resolve to shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

/** ClickHouse-format UTC timestamp `msAgo` before now — relative-time fixtures. */
const chTimestamp = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RESPONSE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "abc", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
    { path: ".outerlayer/commands/deploy.md", kind: "command", scopePath: "", blobSha: "b2" },
    { path: ".outerlayer/skills/writing/SKILL.md", kind: "skill", scopePath: "", skillName: "writing", blobSha: "b3" },
    { path: ".outerlayer/skills/orphan/references/note.md", kind: "reference", scopePath: "", blobSha: "b4" },
    { path: "apps/web/.outerlayer/commands/deploy.md", kind: "command", scopePath: "apps/web", blobSha: "b5" },
  ],
  excludedCounts: [{ scopePath: "", skillName: "writing", count: 3 }],
  issues: [
    { type: "missing-skill-md", path: ".outerlayer/skills/orphan/SKILL.md", scopePath: "", detail: 'skill "orphan" has no SKILL.md' },
    { type: "shadowed", path: ".outerlayer/commands/deploy.md", scopePath: "", detail: 'command "deploy" is shadowed by a nearer definition at "apps/web"' },
  ],
  mcpServerCounts: [],
};

function renderTree(props?: Partial<React.ComponentProps<typeof ContextTree>>) {
  const onSelect = props?.onSelect ?? (() => {});
  render(<ContextTree response={RESPONSE} selectedPath={null} onSelect={onSelect} {...props} />);
  return { onSelect };
}

describe("ContextTree", () => {
  it("labels each section by its scope repo path (root / apps/web) with the .outerlayer dir nested", () => {
    renderTree();
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.getByText("apps/web")).toBeInTheDocument();
    // The `.outerlayer/` directory renders as a row under each scope header.
    expect(screen.getAllByText(".outerlayer")).toHaveLength(2);
  });

  it("renders the rows in tree order, with the skill directory collapsed to one selectable row", () => {
    renderTree();
    // The selectable rows carry aria-selected: every file row, plus the collapsed
    // `writing` skill dir (a selectable treeitem now — selecting it opens the skill
    // pane). Plain dirs and scope headers are treeitems too but carry aria-expanded,
    // so filtering on aria-selected isolates the selectable rows in tree order.
    const names = screen
      .getAllByRole("treeitem")
      .filter((el) => el.hasAttribute("aria-selected"))
      .map((el) => el.textContent?.replace(/shadows$/, "").trim());
    // Root: commands/deploy.md, skills/orphan/references/note.md, the collapsed
    // `writing` skill dir, then AGENTS.md; then apps/web: commands/deploy.md. The
    // collapsed skill's SKILL.md is not rendered.
    expect(names).toEqual(["deploy.md", "note.md", "writing", "AGENTS.md", "deploy.md"]);
  });

  it("expands a collapsed skill directory from its chevron, without selecting it", () => {
    const onSelect = vi.fn();
    renderTree({ onSelect });
    // The skill's own SKILL.md is hidden while its directory is collapsed…
    expect(screen.queryByText("SKILL.md")).toBeNull();
    // …and the chevron (not the row) is the expand affordance.
    fireEvent.click(screen.getByTestId("tree-dir-chevron-.outerlayer/skills/writing"));
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking a skill directory row selects its dir path without expanding it", () => {
    const onSelect = vi.fn();
    renderTree({ onSelect });
    fireEvent.click(screen.getByText("writing"));
    expect(onSelect).toHaveBeenCalledWith(".outerlayer/skills/writing");
    // Selection is the pane's business — the dir stays collapsed.
    expect(screen.queryByText("SKILL.md")).toBeNull();
  });

  it("shows the shadows chip exactly once", () => {
    renderTree();
    expect(screen.getAllByText("shadows")).toHaveLength(1);
  });

  it("shows the missing-SKILL.md warning exactly once, on the orphan skill dir", () => {
    renderTree();
    expect(screen.getAllByLabelText("missing SKILL.md")).toHaveLength(1);
  });

  it("renders a misplaced warning on the offending file row and still lists the file", () => {
    render(
      <ContextTree
        response={{
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
              detail: "subagents live directly in agents/; the frontmatter \"name\" is the identity, so folders add nothing",
            },
          ],
          mcpServerCounts: [],
        }}
        selectedPath={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("reviewer.md")).toBeInTheDocument();
    expect(screen.getAllByLabelText("misplaced file")).toHaveLength(1);
  });

  it("reconstructs an empty folder from a .gitkeep entry without rendering a .gitkeep row", () => {
    render(
      <ContextTree
        response={{
          ...RESPONSE,
          entries: [
            { path: ".outerlayer/docs/guides/.gitkeep", kind: "folder", scopePath: "", blobSha: "f1" },
          ],
          excludedCounts: [],
          issues: [],
          mcpServerCounts: [],
        }}
        selectedPath={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("guides")).toBeInTheDocument();
    expect(screen.queryByText(".gitkeep")).toBeNull();
  });

  it("appends the server count to an mcp.json row", () => {
    render(
      <ContextTree
        response={{
          ...RESPONSE,
          entries: [{ path: ".outerlayer/mcp.json", kind: "mcp", scopePath: "", blobSha: "m1" }],
          excludedCounts: [],
          issues: [],
          mcpServerCounts: [{ path: ".outerlayer/mcp.json", count: 2, servers: ["alpha", "beta"] }],
        }}
        selectedPath={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/·\s*2 servers/)).toBeInTheDocument();
  });

  describe("MCP adoption overlay — last-used column", () => {
    const MCP_RESPONSE = {
      ...RESPONSE,
      entries: [{ path: ".outerlayer/mcp.json", kind: "mcp" as const, scopePath: "", blobSha: "m1" }],
      excludedCounts: [],
      issues: [],
      mcpServerCounts: [{ path: ".outerlayer/mcp.json", count: 2, servers: ["alpha", "beta"] }],
    };
    const usageMap = (
      rows: Array<{ serverName: string; recentCalls: number; totalCalls: number; lastUsedAt: string }>,
    ) => new Map(rows.map((r) => [r.serverName, { ...r, totalSessions: 3 }]));

    it("shows NO time column when the usage overlay is not supplied (unknown ≠ never)", () => {
      render(<ContextTree response={MCP_RESPONSE} selectedPath={null} onSelect={() => {}} />);
      expect(screen.queryByTestId("tree-last-used")).toBeNull();
      expect(screen.queryByTestId("tree-last-used-never")).toBeNull();
    });

    it("a partially-used file shows the most recent use as a muted time — never 'never'", () => {
      // alpha used 3h ago; beta has no usage row. The row must not read as
      // "never" (one server IS used) and must carry the freshest timestamp.
      render(
        <ContextTree
          response={MCP_RESPONSE}
          selectedPath={null}
          onSelect={() => {}}
          mcpUsage={usageMap([
            { serverName: "alpha", recentCalls: 5, totalCalls: 9, lastUsedAt: chTimestamp(3 * HOUR) },
          ])}
        />,
      );
      expect(screen.getByTestId("tree-last-used")).toHaveTextContent("3h ago");
      expect(screen.queryByTestId("tree-last-used-never")).toBeNull();
    });

    it("all servers unused → the red 'never' mark, and no relative time", () => {
      render(
        <ContextTree response={MCP_RESPONSE} selectedPath={null} onSelect={() => {}} mcpUsage={new Map()} />,
      );
      expect(screen.getByTestId("tree-last-used-never")).toHaveTextContent("never");
      expect(screen.queryByTestId("tree-last-used")).toBeNull();
    });

    it("the row keeps only the name, server count, and time — no chips or call counts", () => {
      render(
        <ContextTree
          response={MCP_RESPONSE}
          selectedPath={null}
          onSelect={() => {}}
          mcpUsage={usageMap([
            { serverName: "alpha", recentCalls: 5, totalCalls: 9, lastUsedAt: chTimestamp(45 * DAY) },
            { serverName: "beta", recentCalls: 2, totalCalls: 2, lastUsedAt: chTimestamp(3 * HOUR) },
          ])}
        />,
      );
      const row = screen.getByText("mcp.json").closest('[role="treeitem"]');
      expect(row).toHaveTextContent(/^mcp\.json· 2 servers3h ago$/);
    });
  });

  it("renders the muted excluded-files line for the skill's non-content files once expanded", () => {
    renderTree();
    // The note lives inside the collapsed skill dir — expand it to reveal it.
    fireEvent.click(screen.getByTestId("tree-dir-chevron-.outerlayer/skills/writing"));
    expect(screen.getByText(/3 other files in git/)).toBeInTheDocument();
  });

  it("uses the singular excluded-files line for a count of one", () => {
    renderTree({ response: { ...RESPONSE, excludedCounts: [{ scopePath: "", skillName: "writing", count: 1 }] } });
    fireEvent.click(screen.getByTestId("tree-dir-chevron-.outerlayer/skills/writing"));
    expect(screen.getByText(/1 other file in git/)).toBeInTheDocument();
  });

  it("reports the full path of a selected file", () => {
    const onSelect = vi.fn();
    renderTree({ onSelect });
    fireEvent.click(screen.getByText("AGENTS.md"));
    expect(onSelect).toHaveBeenCalledWith(".outerlayer/AGENTS.md");
  });

  it("filters files by the search query, keeping ancestor dirs", () => {
    renderTree({ query: "note" });
    const names = screen
      .getAllByRole("treeitem")
      .filter((el) => el.hasAttribute("aria-selected"))
      .map((el) => el.textContent);
    expect(names).toEqual(["note.md"]);
    expect(screen.getByText("skills")).toBeInTheDocument();
  });

  it("shows a no-match message when the query matches nothing", () => {
    renderTree({ query: "zzz-nothing" });
    expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
    expect(screen.queryByText("skills")).toBeNull();
    expect(screen.getByText(/No files match/)).toBeInTheDocument();
  });

  it("force-opens a matched file inside an otherwise-collapsed skill directory", () => {
    // SKILL.md hides under the collapsed `writing` dir with no filter…
    renderTree();
    expect(screen.queryByText("SKILL.md")).toBeNull();
    cleanup();
    // …but a filter that matches it expands the dir to reveal the match.
    renderTree({ query: "skill.md" });
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });

  it("a manual chevron click while filtered collapses the dir back — the filter's force-open doesn't win", async () => {
    renderTree({ query: "skill.md" });
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tree-dir-chevron-.outerlayer/skills/writing"));

    // The click must actually collapse it, not silently no-op under the filter
    // (the Collapse unmounts the child after its exit transition).
    await waitFor(() => expect(screen.queryByText("SKILL.md")).toBeNull());
  });

  it("a manual collapse-then-reopen toggle still works while the same filter stays active", async () => {
    renderTree({ query: "skill.md" });
    const chevron = screen.getByTestId("tree-dir-chevron-.outerlayer/skills/writing");

    fireEvent.click(chevron);
    await waitFor(() => expect(screen.queryByText("SKILL.md")).toBeNull());
    fireEvent.click(chevron);
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });

  it("clearing the filter resets the override, so the NEXT search force-opens again", async () => {
    const { rerender } = render(
      <ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} query="skill.md" />,
    );
    fireEvent.click(screen.getByTestId("tree-dir-chevron-.outerlayer/skills/writing"));
    await waitFor(() => expect(screen.queryByText("SKILL.md")).toBeNull());

    // Clear the filter, then start a new one that matches the same file.
    rerender(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} query="" />);
    rerender(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} query="skill.md" />);

    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });
});

const DRAFT_RESPONSE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "abc", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/skills/deploy/SKILL.md", kind: "skill", scopePath: "", skillName: "deploy", blobSha: "b1" },
    { path: ".outerlayer/skills/deploy/references/style.md", kind: "skill-reference", scopePath: "", skillName: "deploy", blobSha: "b2" },
  ],
  excludedCounts: [],
  issues: [],
  mcpServerCounts: [],
};

describe("ContextTree — auto-expand to the selected path", () => {
  const SKILL_MD = ".outerlayer/skills/deploy/SKILL.md";
  const SKILL_REF = ".outerlayer/skills/deploy/references/style.md";

  it("auto-expands the collapsed skill directory that holds the selected path", () => {
    render(<ContextTree response={DRAFT_RESPONSE} selectedPath={SKILL_MD} onSelect={() => {}} />);
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });

  it("expands a nested dir when the selection changes to a path inside it", () => {
    const { rerender } = render(
      <ContextTree response={DRAFT_RESPONSE} selectedPath={null} onSelect={() => {}} />,
    );
    expect(screen.queryByText("style.md")).toBeNull();

    rerender(<ContextTree response={DRAFT_RESPONSE} selectedPath={SKILL_REF} onSelect={() => {}} />);
    expect(screen.getByText("style.md")).toBeInTheDocument();
  });
});

describe("ContextTree — an ancestor dir of the selected file can still collapse", () => {
  // Two files under a plain (non-skill) `commands` dir, open by default.
  const RESP: ContextTreeResponse = {
    gitConnection: { repository: "acme/app", branch: "main" },
    head: { commitSha: "abc", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
    entries: [
      { path: ".outerlayer/commands/deploy.md", kind: "command", scopePath: "", blobSha: "b1" },
      { path: ".outerlayer/commands/release.md", kind: "command", scopePath: "", blobSha: "b2" },
    ],
    excludedCounts: [],
    issues: [],
    mcpServerCounts: [],
  };
  const DEPLOY = ".outerlayer/commands/deploy.md";
  const RELEASE = ".outerlayer/commands/release.md";

  it("collapses the holding dir on click, then re-opens when a different file inside it is selected", async () => {
    const { rerender } = render(
      <ContextTree response={RESP} selectedPath={DEPLOY} onSelect={() => {}} />,
    );
    // The dir holding the selected file is open: both siblings render.
    expect(screen.getByText("deploy.md")).toBeInTheDocument();
    expect(screen.getByText("release.md")).toBeInTheDocument();

    // Clicking the holding dir collapses it — children unmount even though the
    // selection still lives inside.
    fireEvent.click(screen.getByText("commands"));
    await waitFor(() => expect(screen.queryByText("deploy.md")).toBeNull());
    expect(screen.queryByText("release.md")).toBeNull();

    // Selecting a different file under the now-collapsed dir re-opens it.
    rerender(<ContextTree response={RESP} selectedPath={RELEASE} onSelect={() => {}} />);
    expect(screen.getByText("release.md")).toBeInTheDocument();
    expect(screen.getByText("deploy.md")).toBeInTheDocument();
  });
});

describe("ContextTree — monotonic indent under the scope header", () => {
  // Root scope only, with a top-level file and a nested dir so both a
  // scope-level dir row and a scope-level file row are present.
  const RESP: ContextTreeResponse = {
    gitConnection: { repository: "acme/app", branch: "main" },
    head: { commitSha: "abc", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
    entries: [
      { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
      { path: ".outerlayer/commands/deploy.md", kind: "command", scopePath: "", blobSha: "b2" },
    ],
    excludedCounts: [],
    issues: [],
    mcpServerCounts: [],
  };

  it("pins the scope dir chevron right of the header and files right of their dir", () => {
    render(<ContextTree response={RESP} selectedPath={null} onSelect={() => {}} />);

    // `.outerlayer` renders at depth 0 → 0*16 + 24.
    const outerlayerRow = screen.getByText(".outerlayer").closest(".MuiStack-root");
    expect(outerlayerRow).toHaveStyle({ paddingLeft: "24px" });

    // `commands` nests one step under `.outerlayer` (depth 1 → 1*16 + 24 = 40),
    // strictly right of the scope dir chevron.
    const commandsRow = screen.getByText("commands").closest(".MuiStack-root");
    expect(commandsRow).toHaveStyle({ paddingLeft: "40px" });

    // A file directly under `.outerlayer` (depth 1 → 1*16 + 44 = 60) aligns its
    // label with a dir's label at the same depth.
    const fileRow = screen.getByText("AGENTS.md").closest('[role="treeitem"]');
    expect(fileRow).toHaveStyle({ paddingLeft: "60px" });
  });
});

describe("ContextTree — pending-PR + empty rendering", () => {
  it("renders a muted PR tag for a pending-PR path merged into the tree", () => {
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        pendingPrPaths={new Set([".outerlayer/commands/release.md"])}
      />,
    );
    expect(screen.getByText("release.md")).toBeInTheDocument();
    expect(screen.getByTestId("tree-pending-pr-tag")).toHaveTextContent("PR");
  });

  it("renders nothing for an empty tree with no active filter", () => {
    const { container } = render(
      <ContextTree
        response={{ ...RESPONSE, entries: [], excludedCounts: [], issues: [] }}
        selectedPath={null}
        onSelect={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ContextTree — draft dots bubble to the collapsed skill directory", () => {
  it("bubbles an amber dot when a file inside a collapsed skill dir is dirty", () => {
    const drafts = new Map<string, "edit" | "create">([[".outerlayer/skills/deploy/SKILL.md", "edit"]]);
    render(
      <ContextTree response={DRAFT_RESPONSE} selectedPath={null} onSelect={() => {}} draftChangeTypes={drafts} />,
    );
    // The dir stays collapsed (its SKILL.md is hidden), and the dot bubbles up.
    expect(screen.queryByText("SKILL.md")).toBeNull();
    expect(screen.getByLabelText("Contains unsaved changes")).toBeInTheDocument();
  });

  it("bubbles a green (new) dot — new outranks dirty when a dir holds both", () => {
    const drafts = new Map<string, "edit" | "create">([
      [".outerlayer/skills/deploy/SKILL.md", "edit"],
      [".outerlayer/skills/deploy/references/added.md", "create"],
    ]);
    render(
      <ContextTree response={DRAFT_RESPONSE} selectedPath={null} onSelect={() => {}} draftChangeTypes={drafts} />,
    );
    expect(screen.getByLabelText("Contains a new file")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contains unsaved changes")).toBeNull();
  });
});

describe("ContextTree — marked-for-deletion presentation", () => {
  it("renders a struck-through name and a red dot on a file staged for deletion", () => {
    const drafts = new Map<string, "edit" | "create" | "delete">([[".outerlayer/AGENTS.md", "delete"]]);
    render(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} draftChangeTypes={drafts} />);

    expect(screen.getByLabelText("Marked for deletion")).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md")).toHaveStyle({ textDecoration: "line-through" });
    // The deletion dot replaces the dirty/new dot — never both on one row.
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
    expect(screen.queryByLabelText("New file")).toBeNull();
  });

  it("bubbles the deleted dot to a collapsed skill directory only once EVERY file under it is marked", () => {
    const allDeleted = new Map<string, "edit" | "create" | "delete">([
      [".outerlayer/skills/deploy/SKILL.md", "delete"],
      [".outerlayer/skills/deploy/references/style.md", "delete"],
    ]);
    render(
      <ContextTree response={DRAFT_RESPONSE} selectedPath={null} onSelect={() => {}} draftChangeTypes={allDeleted} />,
    );
    // The skill dir stays collapsed (its children are hidden) and reads as deleted itself;
    // the badge bubbles further up through "skills" and the scope's ".outerlayer" root, since
    // every file in the fixture is staged for deletion.
    expect(screen.queryByText("SKILL.md")).toBeNull();
    expect(screen.getAllByLabelText("Marked for deletion")).toHaveLength(3);
    expect(screen.getByText("deploy")).toHaveStyle({ textDecoration: "line-through" });
    expect(screen.getByText("skills")).toHaveStyle({ textDecoration: "line-through" });
  });

  it("does NOT mark the directory when only some of its files are staged for deletion", () => {
    const partiallyDeleted = new Map<string, "edit" | "create" | "delete">([
      [".outerlayer/skills/deploy/SKILL.md", "delete"],
    ]);
    render(
      <ContextTree
        response={DRAFT_RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        draftChangeTypes={partiallyDeleted}
      />,
    );
    expect(screen.queryByLabelText("Marked for deletion")).toBeNull();
  });
});

describe("ContextTree — discard from the tree's change dots", () => {
  afterEach(cleanup);
  const AGENTS = ".outerlayer/AGENTS.md";
  const SKILL_MD = ".outerlayer/skills/deploy/SKILL.md";
  const STYLE_MD = ".outerlayer/skills/deploy/references/style.md";
  const ADDED_MD = ".outerlayer/skills/deploy/references/added.md";

  it("opens a popover from a file's dirty dot and discards exactly that path, without selecting the row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDiscardDrafts = vi.fn();
    const drafts = new Map<string, "edit" | "create" | "delete">([[AGENTS, "edit"]]);
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={onSelect}
        draftChangeTypes={drafts}
        onDiscardDrafts={onDiscardDrafts}
      />,
    );

    await user.click(screen.getByTestId("tree-dirty-dot-trigger"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByTestId("tree-dirty-dot-action"));

    expect(onDiscardDrafts).toHaveBeenCalledTimes(1);
    expect(onDiscardDrafts).toHaveBeenCalledWith([AGENTS]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not select the row behind the popover when clicking its body text or dismissing via the backdrop", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDiscardDrafts = vi.fn();
    const drafts = new Map<string, "edit" | "create" | "delete">([[AGENTS, "edit"]]);
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={onSelect}
        draftChangeTypes={drafts}
        onDiscardDrafts={onDiscardDrafts}
      />,
    );

    await user.click(screen.getByTestId("tree-dirty-dot-trigger"));
    // The Popover is a React-tree (not DOM-tree) descendant of the row, so a
    // click on its own body text still bubbles through React unless guarded.
    await user.click(screen.getByText("Unsaved changes"));
    expect(onSelect).not.toHaveBeenCalled();

    const backdrop = document.querySelector(".MuiBackdrop-root");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDiscardDrafts).not.toHaveBeenCalled();
    // The backdrop click's job is dismissal — assert the popover actually
    // closed, not just that it failed to leak a click to the row. A
    // root-level stopPropagation that swallowed the backdrop's own onClose
    // handling would pass the two assertions above while leaving this false.
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });

  it("lets Enter activate a focused dot trigger instead of the tree's own Enter/Space row handling", async () => {
    const user = userEvent.setup();
    const onDiscardDrafts = vi.fn();
    const drafts = new Map<string, "edit" | "create" | "delete">([[AGENTS, "edit"]]);
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        draftChangeTypes={drafts}
        onDiscardDrafts={onDiscardDrafts}
      />,
    );
    // Queried by DOM attribute, not accessible role — an open Popover marks
    // the rest of the page `aria-hidden` (expected modal behavior), which
    // would otherwise make `getAllByRole` undercount for reasons unrelated
    // to what this test is pinning.
    const treeItemCountBefore = document.querySelectorAll('[role="treeitem"]').length;
    const trigger = screen.getByTestId("tree-dirty-dot-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");

    // Without the target guard, the container's handler would preventDefault
    // the button's own activation and click `items[0]` instead (the scope
    // header, collapsing it) — the popover opens and the tree is untouched.
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(treeItemCountBefore);
  });

  it("restores a deleted file immediately from its dot — no confirm dialog", async () => {
    const user = userEvent.setup();
    const onDiscardDrafts = vi.fn();
    const drafts = new Map<string, "edit" | "create" | "delete">([[AGENTS, "delete"]]);
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        draftChangeTypes={drafts}
        onDiscardDrafts={onDiscardDrafts}
      />,
    );

    await user.click(screen.getByTestId("tree-deleted-dot-trigger"));
    await user.click(screen.getByTestId("tree-deleted-dot-action"));

    expect(onDiscardDrafts).toHaveBeenCalledWith([AGENTS]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a collapsed skill dir's mixed-draft dot shows the counts and, on confirm, discards the full sorted path set", async () => {
    const user = userEvent.setup();
    const onDiscardDrafts = vi.fn();
    const drafts = new Map<string, "edit" | "create" | "delete">([
      [SKILL_MD, "edit"],
      [ADDED_MD, "create"],
    ]);
    render(
      <ContextTree
        response={DRAFT_RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        draftChangeTypes={drafts}
        onDiscardDrafts={onDiscardDrafts}
      />,
    );

    await user.click(screen.getByTestId("tree-dir-draft-dot-trigger"));
    expect(screen.getByText("1 edit · 1 new file")).toBeInTheDocument();
    await user.click(screen.getByTestId("tree-dir-draft-dot-action"));

    // A bulk edit/create discard is destructive, so it's confirmed first —
    // nothing is discarded on the popover click alone.
    expect(onDiscardDrafts).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("This discards 1 edit · 1 new file in this folder. Buffered edits and new files are lost; deletions are restored. This can't be undone.")).toBeInTheDocument();

    await user.click(screen.getByTestId("tree-dir-draft-dot-confirm-confirm"));

    expect(onDiscardDrafts).toHaveBeenCalledTimes(1);
    expect(onDiscardDrafts).toHaveBeenCalledWith([ADDED_MD, SKILL_MD]);
  });

  it("an all-deletes dir's dot restores the folder straight through, with no confirm dialog", async () => {
    const user = userEvent.setup();
    const onDiscardDrafts = vi.fn();
    const drafts = new Map<string, "edit" | "create" | "delete">([
      [SKILL_MD, "delete"],
      [STYLE_MD, "delete"],
    ]);
    render(
      <ContextTree
        response={DRAFT_RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        draftChangeTypes={drafts}
        onDiscardDrafts={onDiscardDrafts}
      />,
    );

    // The all-deleted badge bubbles to every ancestor (skills/, .outerlayer/)
    // since the whole scope is two files, both staged for deletion — scope the
    // click to the "deploy" dir's own row, not an ancestor's.
    const deployRow = screen.getByText("deploy").closest('[role="treeitem"]') as HTMLElement;
    await user.click(within(deployRow).getByTestId("tree-dir-deleted-dot-trigger"));
    expect(screen.getByText("2 deletions")).toBeInTheDocument();
    await user.click(screen.getByTestId("tree-dir-deleted-dot-action"));

    expect(onDiscardDrafts).toHaveBeenCalledTimes(1);
    expect(onDiscardDrafts).toHaveBeenCalledWith([STYLE_MD, SKILL_MD]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the dots as plain, non-interactive marks when no discard bundle is supplied", () => {
    const drafts = new Map<string, "edit" | "create" | "delete">([[AGENTS, "edit"]]);
    render(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} draftChangeTypes={drafts} />);
    expect(screen.queryByTestId("tree-dirty-dot-trigger")).toBeNull();
    expect(screen.getByTestId("tree-dirty-dot")).toBeInTheDocument();
  });
});

describe("ContextTree — skill adoption last-used column", () => {
  afterEach(cleanup);

  const withAdoption = (lastActivatedAt: string | null) =>
    new Map([[
      "writing",
      { skillName: "writing", recentActivations: 12, totalActivations: 40, totalSessions: 6, lastActivatedAt },
    ]]);

  it("renders a recent activation as a muted relative time — no chips, no counts", () => {
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        skillActivations={withAdoption(chTimestamp(2 * HOUR))}
      />,
    );
    expect(screen.getByTestId("tree-last-used")).toHaveTextContent("2h ago");
    // The whole row is just the name and the time — the chip/count vocabulary
    // ("8×", "quiet", "never used") is gone from the tree.
    const row = screen.getByText("writing").closest('[role="treeitem"]');
    expect(row).toHaveTextContent(/^writing2h ago$/);
  });

  it("buckets an old activation into days ('45d ago' reads as going stale)", () => {
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        skillActivations={withAdoption(chTimestamp(45 * DAY))}
      />,
    );
    expect(screen.getByTestId("tree-last-used")).toHaveTextContent("45d ago");
  });

  it("marks an installed-but-unactivated skill with the red 'never' (map present, skill absent)", () => {
    render(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} skillActivations={new Map()} />);
    expect(screen.getByTestId("tree-last-used-never")).toHaveTextContent("never");
    expect(screen.queryByTestId("tree-last-used")).toBeNull();
  });

  it("suppresses the 'never used' mark while the skill is a brand-new unpublished draft", () => {
    const drafts = new Map<string, "edit" | "create">([
      [".outerlayer/skills/writing/SKILL.md", "create"],
    ]);
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        skillActivations={new Map()}
        draftChangeTypes={drafts}
      />,
    );
    // No usage history is expected for something not yet published — the mark is noise.
    expect(screen.queryByTestId("tree-last-used-never")).toBeNull();
  });

  it("shows NO time column when no activation data is supplied (unknown ≠ never)", () => {
    render(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} />);
    expect(screen.queryByTestId("tree-last-used")).toBeNull();
    expect(screen.queryByTestId("tree-last-used-never")).toBeNull();
  });

  it("a draft dot and the time coexist on one row — usage never reuses the dot form", () => {
    const drafts = new Map<string, "edit" | "create">([[".outerlayer/skills/writing/SKILL.md", "edit"]]);
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        draftChangeTypes={drafts}
        skillActivations={withAdoption(chTimestamp(2 * HOUR))}
      />,
    );
    // The bubbled amber draft dot and the muted time both render; the time is
    // text, not another dot.
    expect(screen.getByLabelText("Contains unsaved changes")).toBeInTheDocument();
    expect(screen.getByTestId("tree-last-used")).toHaveTextContent("2h ago");
  });
});

describe("buildOuterlayerNode — the root .outerlayer row's node shape", () => {
  it("wraps the given nodes as the .outerlayer dir's children, without cloning the array", () => {
    const nodes = [
      { type: "file", path: ".outerlayer/AGENTS.md", name: "AGENTS.md", kind: "instructions", badges: [] },
    ] as unknown as Parameters<typeof buildOuterlayerNode>[1];

    const node = buildOuterlayerNode(".outerlayer", nodes);

    expect(node).toEqual({
      type: "dir",
      path: ".outerlayer",
      name: ".outerlayer",
      badges: [],
      excludedCount: null,
      children: nodes,
    });
    // Same array reference, not a copy — a caller memoizing on `[scopeDir,
    // nodes]` depends on this to keep the wrapped node's identity stable
    // whenever `nodes` itself hasn't changed.
    expect(node.children).toBe(nodes);
  });
});

describe("isOverflowing — truncated-name tooltip gating", () => {
  const fake = (scrollWidth: number, clientWidth: number) =>
    ({ scrollWidth, clientWidth }) as HTMLElement;

  it("is true only when the rendered text is wider than its box", () => {
    expect(isOverflowing(fake(200, 100))).toBe(true);
    expect(isOverflowing(fake(100, 100))).toBe(false);
    expect(isOverflowing(fake(80, 100))).toBe(false);
    expect(isOverflowing(null)).toBe(false);
  });
});

describe("ContextTree — ARIA hierarchy (level/group/set)", () => {
  const levelOf = (path: string) =>
    screen.getAllByRole("treeitem").find((el) => el.getAttribute("data-path") === path)?.getAttribute("aria-level");

  it("assigns aria-level by nesting depth, 1-based from the scope header", () => {
    renderTree();
    expect(levelOf("scope:.outerlayer")).toBe("1");
    expect(levelOf(".outerlayer")).toBe("2");
    expect(levelOf(".outerlayer/commands")).toBe("3");
    expect(levelOf(".outerlayer/commands/deploy.md")).toBe("4");
    expect(levelOf(".outerlayer/skills/orphan/references")).toBe("5");
    expect(levelOf(".outerlayer/skills/orphan/references/note.md")).toBe("6");
  });

  it("wraps a dir's children in role=group, distinct from the treeitems themselves", () => {
    renderTree();
    const groups = document.querySelectorAll('[role="group"]');
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.getAttribute("role")).not.toBe("treeitem");
  });

  it("gives every set of siblings a consistent aria-setsize and a gap-free 1..N aria-posinset", () => {
    renderTree();
    const treeitems = screen.getAllByRole("treeitem");
    const groups = new Map<Element, HTMLElement[]>();
    for (const item of treeitems) {
      const parentGroup = item.parentElement?.closest('[role="group"], [role="tree"]');
      if (!parentGroup) continue;
      const members = groups.get(parentGroup) ?? [];
      members.push(item);
      groups.set(parentGroup, members);
    }
    // Multiple distinct sibling sets exist (scope-level, .outerlayer's children, etc.).
    expect(groups.size).toBeGreaterThan(1);
    for (const members of groups.values()) {
      const setSizes = new Set(members.map((el) => el.getAttribute("aria-setsize")));
      expect(setSizes.size).toBe(1);
      expect(Number([...setSizes][0])).toBe(members.length);
      const posInsets = members.map((el) => Number(el.getAttribute("aria-posinset"))).sort((a, b) => a - b);
      expect(posInsets).toEqual(Array.from({ length: members.length }, (_, i) => i + 1));
    }
  });
});

describe("ContextTree — keyboard navigation (WAI-ARIA tree)", () => {
  const pathOf = (el: Element | null) => el?.getAttribute("data-path");

  it("exposes exactly one tab-stop (roving tabindex) on the first row", () => {
    renderTree();
    const tabbable = screen.getAllByRole("treeitem").filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute("data-path", "scope:.outerlayer");
  });

  it("Down/Up move the focus and the tab-stop across the visible rows in order", () => {
    renderTree();
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(pathOf(document.activeElement)).toBe(".outerlayer");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(pathOf(document.activeElement)).toBe(".outerlayer/commands");
    // The moved-to row is now the only tab-stop.
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(pathOf(document.activeElement)).toBe(".outerlayer");
  });

  it("Enter on a file row opens it with its full path", () => {
    const onSelect = vi.fn();
    renderTree({ onSelect });
    const tree = screen.getByRole("tree");
    // scope header → .outerlayer → commands → deploy.md
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(pathOf(document.activeElement)).toBe(".outerlayer/commands/deploy.md");
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(".outerlayer/commands/deploy.md");
  });

  it("Right expands a collapsed dir and Left collapses it again", async () => {
    renderTree();
    const tree = screen.getByRole("tree");
    const writing = tree.querySelector('[data-path=".outerlayer/skills/writing"]') as HTMLElement;
    expect(writing).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("SKILL.md")).toBeNull();

    fireEvent.focus(writing);
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(writing).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();

    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(writing).toHaveAttribute("aria-expanded", "false");
    // The Collapse unmounts the child after its exit transition.
    await waitFor(() => expect(screen.queryByText("SKILL.md")).toBeNull());
  });

  it("Left on a file moves to its parent directory", () => {
    renderTree();
    const tree = screen.getByRole("tree");
    const note = tree.querySelector(
      '[data-path=".outerlayer/skills/orphan/references/note.md"]',
    ) as HTMLElement;
    fireEvent.focus(note);
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(pathOf(document.activeElement)).toBe(".outerlayer/skills/orphan/references");
  });

  it("a focused dir row's create actions are reachable by Tab (they live in the row)", async () => {
    const user = userEvent.setup();
    renderTree({ onNewFile: vi.fn(), onNewFolder: vi.fn() });
    const tree = screen.getByRole("tree");
    const commands = tree.querySelector('[data-path=".outerlayer/commands"]') as HTMLElement;
    commands.focus();
    expect(pathOf(document.activeElement)).toBe(".outerlayer/commands");
    await user.tab();
    // Tab lands on the row's own create-file action button, not out of the row.
    expect(document.activeElement).toHaveAttribute("data-testid", "new-file-.outerlayer/commands");
  });
});
