// @vitest-environment jsdom
/**
 * Row-action behavior on the context tree: which directories offer "New file" /
 * "New folder" (the per-location rules), that a file action opens the popover
 * pre-targeted at the right location + kind, and the inline folder-naming flow
 * (Enter stages a `.gitkeep` draft; an invalid name is refused).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextTree from "../context-tree";
import type { ContextTreeResponse } from "../../types";

vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

const RESPONSE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "abc", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/agents/reviewer.md", kind: "subagent", scopePath: "", blobSha: "b1" },
    { path: ".outerlayer/commands/deploy/ship.md", kind: "command", scopePath: "", blobSha: "b2" },
    { path: ".outerlayer/skills/writing/SKILL.md", kind: "skill", scopePath: "", skillName: "writing", blobSha: "b3" },
    { path: ".outerlayer/docs/notes.md", kind: "reference", scopePath: "", blobSha: "b4" },
  ],
  excludedCounts: [],
  issues: [],
  mcpServerCounts: [],
};

function renderTree(props?: Partial<React.ComponentProps<typeof ContextTree>>) {
  const onNewFile = vi.fn();
  const onNewFolder = vi.fn();
  const onDeleteFolder = vi.fn();
  render(
    <ContextTree
      response={RESPONSE}
      selectedPath={null}
      onSelect={() => {}}
      onNewFile={onNewFile}
      onNewFolder={onNewFolder}
      onDeleteFolder={onDeleteFolder}
      {...props}
    />,
  );
  return { onNewFile, onNewFolder, onDeleteFolder };
}

afterEach(cleanup);

describe("context tree row actions — location rules", () => {
  it("offers a file action but NO folder action inside agents/ (subagents are flat)", () => {
    renderTree();
    expect(screen.getByTestId("new-file-.outerlayer/agents")).toBeInTheDocument();
    expect(screen.queryByTestId("new-folder-.outerlayer/agents")).toBeNull();
  });

  it("offers both actions inside a command namespace dir", () => {
    renderTree();
    expect(screen.getByTestId("new-file-.outerlayer/commands/deploy")).toBeInTheDocument();
    expect(screen.getByTestId("new-folder-.outerlayer/commands/deploy")).toBeInTheDocument();
  });

  it("offers both actions on a skill dir (targeting its references/)", () => {
    renderTree();
    expect(screen.getByTestId("new-file-.outerlayer/skills/writing")).toBeInTheDocument();
    expect(screen.getByTestId("new-folder-.outerlayer/skills/writing")).toBeInTheDocument();
  });

  it("offers BOTH actions on the bare skills/ dir (new skill + new folder)", () => {
    renderTree();
    expect(screen.getByTestId("new-file-.outerlayer/skills")).toBeInTheDocument();
    expect(screen.getByTestId("new-folder-.outerlayer/skills")).toBeInTheDocument();
  });

  it("offers both actions on a generic dir and on the scope's .outerlayer root", () => {
    renderTree();
    expect(screen.getByTestId("new-file-.outerlayer/docs")).toBeInTheDocument();
    expect(screen.getByTestId("new-folder-.outerlayer/docs")).toBeInTheDocument();
    expect(screen.getByTestId("new-file-.outerlayer")).toBeInTheDocument();
    expect(screen.getByTestId("new-folder-.outerlayer")).toBeInTheDocument();
  });

  it("hides all row actions when the caller supplies no create callbacks (no insert permission)", () => {
    render(<ContextTree response={RESPONSE} selectedPath={null} onSelect={() => {}} />);
    expect(screen.queryByTestId("new-file-.outerlayer/docs")).toBeNull();
    expect(screen.queryByTestId("new-folder-.outerlayer/docs")).toBeNull();
  });
});

describe("context tree row actions — folder delete affordance", () => {
  it("refuses a delete action on the four bare scope dirs", () => {
    renderTree();
    expect(screen.queryByTestId("delete-folder-.outerlayer")).toBeNull();
    expect(screen.queryByTestId("delete-folder-.outerlayer/agents")).toBeNull();
    expect(screen.queryByTestId("delete-folder-.outerlayer/skills")).toBeNull();
  });

  it("offers a delete action on a generic dir, a command namespace dir, and a skill's own dir", () => {
    renderTree();
    expect(screen.getByTestId("delete-folder-.outerlayer/docs")).toBeInTheDocument();
    expect(screen.getByTestId("delete-folder-.outerlayer/commands/deploy")).toBeInTheDocument();
    expect(screen.getByTestId("delete-folder-.outerlayer/skills/writing")).toBeInTheDocument();
  });

  it("clicking a generic dir's delete action reports a `dir` target", () => {
    const { onDeleteFolder } = renderTree();
    fireEvent.click(screen.getByTestId("delete-folder-.outerlayer/docs"));
    expect(onDeleteFolder).toHaveBeenCalledWith({ kind: "dir", dirPath: ".outerlayer/docs" });
  });

  it("clicking a skill's own dir delete action reports a `skill` target, not a generic `dir`", () => {
    const { onDeleteFolder } = renderTree();
    fireEvent.click(screen.getByTestId("delete-folder-.outerlayer/skills/writing"));
    expect(onDeleteFolder).toHaveBeenCalledWith({ kind: "skill", skillDir: ".outerlayer/skills/writing" });
  });

  it("hides every delete action when the caller supplies no onDeleteFolder callback (no delete permission)", () => {
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("delete-folder-.outerlayer/docs")).toBeNull();
    expect(screen.queryByTestId("delete-folder-.outerlayer/skills/writing")).toBeNull();
  });

  it("a delete-only role (no insert) still gets the folder-delete action, with no create actions", () => {
    const onDeleteFolder = vi.fn();
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        onDeleteFolder={onDeleteFolder}
      />,
    );
    // Delete is independent of insert — composition, not one bundle.
    expect(screen.getByTestId("delete-folder-.outerlayer/docs")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("delete-folder-.outerlayer/docs"));
    expect(onDeleteFolder).toHaveBeenCalledWith({ kind: "dir", dirPath: ".outerlayer/docs" });
    expect(screen.queryByTestId("new-file-.outerlayer/docs")).toBeNull();
    expect(screen.queryByTestId("new-folder-.outerlayer/docs")).toBeNull();
    // The scope header (whose dir never gets a delete affordance) shows nothing at all.
    expect(screen.queryByTestId("new-file-header-.outerlayer")).toBeNull();
  });

  it("an insert-only role (no delete) gets create actions but never the folder-delete action", () => {
    render(
      <ContextTree
        response={RESPONSE}
        selectedPath={null}
        onSelect={() => {}}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByTestId("new-file-.outerlayer/docs")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-folder-.outerlayer/docs")).toBeNull();
  });
});

describe("context tree row actions — targets and folder creation", () => {
  it("opens the file popover pre-targeted with the command kind + namespace dir", () => {
    const { onNewFile } = renderTree();
    fireEvent.click(screen.getByTestId("new-file-.outerlayer/commands/deploy"));
    expect(onNewFile).toHaveBeenCalledTimes(1);
    expect(onNewFile.mock.calls[0]![0]).toEqual({
      scope: "",
      baseDir: ".outerlayer/commands/deploy",
      presetKind: "command",
    });
  });

  it("targets a skill dir's file action at its references/ as a document", () => {
    const { onNewFile } = renderTree();
    fireEvent.click(screen.getByTestId("new-file-.outerlayer/skills/writing"));
    expect(onNewFile.mock.calls[0]![0]).toEqual({
      scope: "",
      baseDir: ".outerlayer/skills/writing/references",
      presetKind: "document",
    });
  });

  it("pre-targets the bare skills/ file action at the skill kind", () => {
    const { onNewFile } = renderTree();
    fireEvent.click(screen.getByTestId("new-file-.outerlayer/skills"));
    expect(onNewFile.mock.calls[0]![0]).toEqual({
      scope: "",
      baseDir: ".outerlayer/skills",
      presetKind: "skill",
    });
  });

  it("stages a .gitkeep skill folder under skills/ when confirmed", () => {
    const { onNewFolder } = renderTree();
    fireEvent.click(screen.getByTestId("new-folder-.outerlayer/skills"));
    const input = screen.getByTestId("tree-new-folder-name");
    fireEvent.change(input, { target: { value: "research" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNewFolder).toHaveBeenCalledWith(".outerlayer/skills", "research");
  });

  it("opens the full menu (no preset kind) from the scope root", () => {
    const { onNewFile } = renderTree();
    fireEvent.click(screen.getByTestId("new-file-.outerlayer"));
    expect(onNewFile.mock.calls[0]![0]).toEqual({ scope: "", baseDir: ".outerlayer", presetKind: null });
  });

  it("stages a .gitkeep draft under the folder base when a valid folder name is confirmed", () => {
    const { onNewFolder } = renderTree();
    fireEvent.click(screen.getByTestId("new-folder-.outerlayer/docs"));
    const input = screen.getByTestId("tree-new-folder-name");
    fireEvent.change(input, { target: { value: "guides" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNewFolder).toHaveBeenCalledWith(".outerlayer/docs", "guides");
  });

  it("refuses a folder name with a path-traversal segment", () => {
    const { onNewFolder } = renderTree();
    fireEvent.click(screen.getByTestId("new-folder-.outerlayer/docs"));
    const input = screen.getByTestId("tree-new-folder-name");
    fireEvent.change(input, { target: { value: "../escape" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNewFolder).not.toHaveBeenCalled();
    expect(screen.getByText("Lowercase letters, digits, and single hyphens only.")).toBeInTheDocument();
  });

  it("cancels the inline folder input on Escape without staging anything", () => {
    const { onNewFolder } = renderTree();
    fireEvent.click(screen.getByTestId("new-folder-.outerlayer/docs"));
    const input = screen.getByTestId("tree-new-folder-name");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("tree-new-folder-input")).toBeNull();
    expect(onNewFolder).not.toHaveBeenCalled();
  });

  it("confirming the inline folder input with a real Enter keydown does not collapse the scope header behind it", () => {
    const { onNewFolder } = renderTree();
    const treeItemCountBefore = screen.getAllByRole("treeitem").length;
    const scopeHeader = document.querySelector('[data-path="scope:.outerlayer"]');
    expect(scopeHeader).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("new-folder-.outerlayer/docs"));
    const input = screen.getByTestId("tree-new-folder-name");
    fireEvent.change(input, { target: { value: "guides" } });
    // A real bubbling KeyboardEvent, not fireEvent.change alone — the tree
    // container's own onKeyDown also receives this event.
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onNewFolder).toHaveBeenCalledWith(".outerlayer/docs", "guides");
    // Without the input guard, the container's Enter handling would ALSO
    // fire on this same event — preventDefaulting the confirm keystroke and
    // clicking `items[0]` (the scope header, with no row ever focused),
    // toggling it closed. `aria-expanded` flips synchronously on that click
    // (ahead of the Collapse's own exit-transition unmount), so it catches
    // the regression even before any row actually leaves the DOM.
    expect(scopeHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("treeitem")).toHaveLength(treeItemCountBefore);
  });

  it("still moves the tree's roving tab-stop on ArrowDown fired from a focused row-action button", () => {
    renderTree();
    const trigger = screen.getByTestId("new-file-.outerlayer/docs");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    // The guard only holds back Enter/Space (native button activation) from
    // a button target — arrows still drive the roving tab-stop exactly as
    // they would from any treeitem, so focus can move back into the tree.
    const activeItem = document.activeElement;
    expect(activeItem).toHaveAttribute("role", "treeitem");
    expect(activeItem).toHaveAttribute("data-path", ".outerlayer");
  });
});
