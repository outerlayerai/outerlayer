// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextEditor } from "./context-editor";
import type { ContextFileHandle } from "./types";

// Stand in for the CodeMirror surface — a plain textarea driving onChange.
vi.mock("./code-editor", () => ({
  CodeEditor: ({ value, onChange, readOnly }: any) => (
    <textarea
      data-testid="code-input"
      value={value}
      readOnly={readOnly}
      onChange={(e) => {
        if (!readOnly) onChange(e.target.value);
      }}
    />
  ),
}));

// Stand in for the Milkdown surface (rich is the DEFAULT for markdown kinds) —
// body-only textarea contract.
vi.mock("@/features/context/components/rich-editor/rich-markdown-editor", () => ({
  RichMarkdownEditor: ({ value, onChange, readOnly }: any) => (
    <textarea
      data-testid="rich-input"
      value={value}
      readOnly={readOnly}
      onChange={(e) => {
        if (!readOnly) onChange(e.target.value);
      }}
    />
  ),
}));

const VALID = `---
name: deploy-checklist
description: Steps to run before a deploy
---
# Deploy checklist
`;
const FRONTMATTER = `---
name: deploy-checklist
description: Steps to run before a deploy
---
`;
const BODY = "# Deploy checklist\n";

const FILE: ContextFileHandle = {
  path: ".outerlayer/skills/deploy-checklist/SKILL.md",
  kind: "skill",
  content: VALID,
  baseBlobSha: "blob-base-1",
  baseCommitSha: "commit-base-1",
  skillDirName: "deploy-checklist",
};

const NO_FRONTMATTER_FILE: ContextFileHandle = {
  path: ".outerlayer/AGENTS.md",
  kind: "instructions",
  content: "# Agents\n\nBody only.\n",
  baseBlobSha: "blob-base-2",
  baseCommitSha: "commit-base-2",
};

// A file whose bytes do NOT end in a newline — the phantom-edit trigger.
const NO_EOL_FILE: ContextFileHandle = {
  path: ".outerlayer/AGENTS.md",
  kind: "instructions",
  content: "# Agents\n\nNo trailing newline",
  baseBlobSha: "blob-base-3",
  baseCommitSha: "commit-base-3",
};

/** Renders the editor controlled — content state lives here, like the page. */
function ControlledEditor({
  file = FILE,
  readOnly,
  onDelete,
  canDelete,
  onContent,
  onPublish,
  draftCount,
}: {
  file?: ContextFileHandle;
  readOnly?: boolean;
  onDelete?: () => void;
  canDelete?: boolean;
  onContent?: (content: string) => void;
  onPublish?: () => void;
  draftCount?: number;
}) {
  const [content, setContent] = useState(file.content);
  return (
    <ContextEditor
      file={file}
      content={content}
      onContentChange={(c) => {
        setContent(c);
        onContent?.(c);
      }}
      readOnly={readOnly}
      onDelete={onDelete}
      canDelete={canDelete}
      onPublish={onPublish}
      draftCount={draftCount}
    />
  );
}

/** Switch to the raw surface (rich is the default for markdown kinds). */
function toRaw() {
  const rawToggle = screen.queryByRole("button", { name: "raw" });
  if (rawToggle && rawToggle.getAttribute("aria-pressed") !== "true") {
    fireEvent.click(rawToggle);
  }
}

describe("ContextEditor", () => {
  it("defaults to the RICH surface for markdown kinds and keeps content across a raw⇄rich toggle", async () => {
    render(<ControlledEditor />);
    expect(await screen.findByTestId("rich-input")).toBeInTheDocument();
    expect(screen.queryByTestId("code-input")).not.toBeInTheDocument();

    toRaw();
    fireEvent.change(screen.getByTestId("code-input"), { target: { value: `${VALID}\nedit\n` } });
    fireEvent.click(screen.getByRole("button", { name: "rich" }));
    expect(await screen.findByTestId("rich-input")).toBeInTheDocument();
    expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
  });

  it("renders rich mode as a pure document — the frontmatter block is NOT shown there, only in Raw", async () => {
    render(<ControlledEditor />);
    const rich = (await screen.findByTestId("rich-input")) as HTMLTextAreaElement;
    // Body only: the frontmatter never bleeds into the rich surface.
    expect(rich.value).toBe(BODY);
    expect(rich.value).not.toContain("name: deploy-checklist");

    // Raw mode is where the whole file — frontmatter included — is visible.
    toRaw();
    expect((screen.getByTestId("code-input") as HTMLTextAreaElement).value).toBe(VALID);
  });

  it("edits frontmatter in Raw mode and lifts the whole file byte-exactly", async () => {
    const onContent = vi.fn();
    render(<ControlledEditor onContent={onContent} />);
    await screen.findByTestId("rich-input");
    toRaw();

    const edited = `---
name: deploy-checklist
description: Steps to run before every deploy
---
# Deploy checklist
`;
    fireEvent.change(screen.getByTestId("code-input"), { target: { value: edited } });

    // Raw is the whole-file surface — the lifted content is byte-identical.
    expect(onContent).toHaveBeenLastCalledWith(edited);
  });

  it("lifts a body edit as the whole file (frontmatter re-attached verbatim)", async () => {
    const onContent = vi.fn();
    render(<ControlledEditor onContent={onContent} />);
    const rich = await screen.findByTestId("rich-input");

    fireEvent.change(rich, { target: { value: "# New body\n" } });

    expect(onContent).toHaveBeenLastCalledWith(FRONTMATTER + "# New body\n");
  });

  it("shows the full document in rich mode for a file that has no frontmatter", async () => {
    render(<ControlledEditor file={NO_FRONTMATTER_FILE} />);
    const rich = (await screen.findByTestId("rich-input")) as HTMLTextAreaElement;
    // Nothing to peel — the rich body is the entire file.
    expect(rich.value).toBe(NO_FRONTMATTER_FILE.content);
  });

  it("does not phantom-flag a newline-less file when a rich round-trip re-adds the EOF newline", async () => {
    render(<ControlledEditor file={NO_EOL_FILE} />);
    const rich = (await screen.findByTestId("rich-input")) as HTMLTextAreaElement;
    // Body is the whole file (no frontmatter) and starts clean.
    expect(rich.value).toBe(NO_EOL_FILE.content);
    expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();

    // Milkdown re-serializes the identical body but always appends a trailing \n.
    fireEvent.change(rich, { target: { value: `${NO_EOL_FILE.content}\n` } });
    expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
  });

  it("still flags a genuine body edit on a newline-less file", async () => {
    render(<ControlledEditor file={NO_EOL_FILE} />);
    const rich = await screen.findByTestId("rich-input");
    fireEvent.change(rich, { target: { value: "# Agents\n\nReal change\n" } });
    expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
  });

  it("shows the unsaved indicator only while content differs from the loaded bytes", async () => {
    render(<ControlledEditor />);
    await screen.findByTestId("rich-input");
    expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();

    toRaw();
    fireEvent.change(screen.getByTestId("code-input"), { target: { value: `${VALID}\nedit\n` } });
    expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();

    // Editing back to the loaded bytes clears the indicator.
    fireEvent.change(screen.getByTestId("code-input"), { target: { value: VALID } });
    expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
  });

  it("renders every surface uneditable with no unsaved indicator when readOnly", async () => {
    render(<ControlledEditor readOnly canDelete={false} />);
    const rich = (await screen.findByTestId("rich-input")) as HTMLTextAreaElement;
    expect(rich).toHaveAttribute("readonly");
    fireEvent.change(rich, { target: { value: "# hacked" } });
    expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();

    toRaw();
    expect(screen.getByTestId("code-input")).toHaveAttribute("readonly");
    // No delete grant → no overflow menu at all.
    expect(screen.queryByTestId("editor-overflow-button")).not.toBeInTheDocument();
  });

  it("exposes Delete only with canDelete, inside the overflow menu, routed to onDelete", () => {
    const onDelete = vi.fn();
    const { rerender } = render(<ControlledEditor onDelete={onDelete} canDelete={false} />);
    expect(screen.queryByTestId("editor-overflow-button")).not.toBeInTheDocument();

    rerender(<ControlledEditor onDelete={onDelete} canDelete />);
    // Delete lives behind the overflow — closed by default.
    expect(screen.queryByTestId("context-delete-button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("editor-overflow-button"));
    fireEvent.click(screen.getByTestId("context-delete-button"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows the Publish button with a draft-count badge only when drafts exist", async () => {
    const onPublish = vi.fn();
    const { rerender } = render(<ControlledEditor onPublish={onPublish} draftCount={0} />);
    await screen.findByTestId("rich-input");
    // No drafts → no publish affordance in the header.
    expect(screen.queryByTestId("editor-publish-button")).not.toBeInTheDocument();

    rerender(<ControlledEditor onPublish={onPublish} draftCount={3} />);
    expect(screen.getByTestId("editor-publish-count")).toHaveTextContent("3");
    fireEvent.click(screen.getByTestId("editor-publish-button"));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});
