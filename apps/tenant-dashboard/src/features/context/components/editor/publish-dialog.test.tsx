// @vitest-environment jsdom
/**
 * Behavior tests for the publish (review) dialog: what it renders per draft
 * (name/parent/new chip, exact diff stats), the partial-publish checkbox
 * contract (onPublish receives exactly the checked, publishable paths), the
 * blocked states (invalid + conflicted rows can't publish but the valid rest
 * can), the deleted-conflict "Keep as new file" affordance, and the stated
 * radio's policy-driven default.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishDialog } from "./publish-dialog";
import type { ContextDraft } from "../use-context-drafts";

// Render with the real i18n + en.json so the subtitle/button copy assertions
// (e.g. "Publishing 1 of 2 files", "Publish 1 change") prove the translation
// keys and interpolation params resolve to the shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});
import type { ContextBatchFileConflict } from "@/lib/adapters/context-save";

const AGENTS = ".outerlayer/AGENTS.md";
const DEPLOY = ".outerlayer/commands/deploy.md";
const SKILL = ".outerlayer/skills/deploy/SKILL.md";

function editDraft(path: string, baseContent: string, content: string): ContextDraft {
  return { path, content, baseBlobSha: "sha-1", baseContent, changeType: "edit" };
}
function createDraft(path: string, content: string): ContextDraft {
  return { path, content, baseBlobSha: null, baseContent: "", changeType: "create" };
}
function deleteDraft(path: string, baseContent: string): ContextDraft {
  return { path, content: "", baseBlobSha: "sha-1", baseContent, changeType: "delete" };
}

function renderDialog(props?: Partial<React.ComponentProps<typeof PublishDialog>>) {
  const handlers = {
    onDiscardDraft: vi.fn(),
    onRefreshDraft: vi.fn(),
    onRestoreAsNew: vi.fn(),
    onDiscardAll: vi.fn(),
    onPublish: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <PublishDialog
      open
      drafts={props?.drafts ?? [editDraft(AGENTS, "hello\n", "hello\nworld\n")]}
      branch="main"
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

afterEach(cleanup);

describe("PublishDialog", () => {
  it("renders one row per draft with its filename, parent path, and a new chip only for creates", () => {
    renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hello\nworld\n"), createDraft(DEPLOY, "---\ndescription: d\n---\n\n")],
    });

    const rows = screen.getAllByTestId("publish-file-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("AGENTS.md")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(".outerlayer")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("deploy.md")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(".outerlayer/commands")).toBeInTheDocument();

    // The new chip marks the create row only.
    const chips = screen.getAllByTestId("publish-row-new-chip");
    expect(chips).toHaveLength(1);
    expect(within(rows[1]!).getByTestId("publish-row-new-chip")).toBeInTheDocument();
  });

  it("shows the full repo-relative path in a tooltip on hover, even when the parent path is deeply nested and ellipsized", async () => {
    const user = userEvent.setup();
    const longPath =
      ".outerlayer/skills/writing-comprehensive-technical-documentation-guides/reference/style-guide.md";
    renderDialog({ drafts: [createDraft(longPath, "---\ndescription: d\n---\n\n")] });

    const row = screen.getByTestId("publish-file-row");
    const parentEl = within(row).getByText(
      ".outerlayer/skills/writing-comprehensive-technical-documentation-guides/reference",
    );

    await user.hover(parentEl);
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText(longPath)).toBeInTheDocument();
  });

  it("marks a delete row with a struck-through name, a deleted chip, the full-file −N count and no +adds, and its checked path publishes", () => {
    const onPublish = renderDialog({
      drafts: [deleteDraft(DEPLOY, "one\ntwo\nthree\n")],
    }).onPublish;

    const row = screen.getByTestId("publish-file-row");
    expect(within(row).getByTestId("publish-row-deleted-chip")).toHaveTextContent("deleted");
    // No "new" chip on a delete row.
    expect(within(row).queryByTestId("publish-row-new-chip")).not.toBeInTheDocument();
    const name = within(row).getByText("deploy.md");
    expect(name).toHaveStyle({ textDecoration: "line-through" });
    // A delete only removes lines: the full file's 3 lines are the −count and
    // there is no +adds element at all.
    expect(within(row).getByTestId("publish-row-dels")).toHaveTextContent("−3");
    expect(within(row).queryByTestId("publish-row-adds")).not.toBeInTheDocument();

    // A delete is publishable (never content-blocked) and rides the checked set.
    fireEvent.click(screen.getByTestId("publish-submit"));
    expect(onPublish).toHaveBeenCalledWith("Update context files", [DEPLOY]);
  });

  it("never content-blocks a delete row even when the deleted file's own content would be invalid", () => {
    // A SKILL.md with unparseable frontmatter is a hard error for an edit/create,
    // but deleting it writes no content — the row must stay publishable.
    const onPublish = renderDialog({
      drafts: [deleteDraft(SKILL, "---\nname: [unclosed\n---\n# Body\n")],
    }).onPublish;

    const row = screen.getByTestId("publish-file-row");
    expect(within(row).queryByTestId("publish-row-invalid")).not.toBeInTheDocument();
    expect(within(row).getByTestId("publish-row-checkbox").querySelector("input")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("publish-submit"));
    expect(onPublish).toHaveBeenCalledWith("Update context files", [SKILL]);
  });

  it("expands a delete row's diff to the removal of every line", () => {
    renderDialog({ drafts: [deleteDraft(DEPLOY, "alpha\nbeta\n")] });

    fireEvent.click(screen.getByTestId("publish-row-diff-toggle"));
    const diff = screen.getByTestId("publish-row-diff");
    expect(within(diff).getByText("alpha")).toBeInTheDocument();
    expect(within(diff).getByText("beta")).toBeInTheDocument();
  });

  it("labels a .gitkeep create row as the folder it keeps, not the bare filename", () => {
    renderDialog({ drafts: [createDraft(".outerlayer/docs/guides/.gitkeep", "")] });

    const row = screen.getByTestId("publish-file-row");
    // The folder name (with a trailing slash), its parent path, and a "new folder" chip.
    expect(within(row).getByText("guides/")).toBeInTheDocument();
    expect(within(row).getByText(".outerlayer/docs")).toBeInTheDocument();
    expect(within(row).getByTestId("publish-row-new-chip")).toHaveTextContent("new folder");
    expect(within(row).queryByText(".gitkeep")).toBeNull();
  });

  it("shows the exact added/deleted line counts from the structured diff", () => {
    renderDialog({ drafts: [editDraft(AGENTS, "one\ntwo\nthree\n", "one\ntwo-changed\nthree\nfour\n")] });

    // Line 2 replaced (−1 +1) plus an appended line (+1) → +2 / −1.
    expect(screen.getByTestId("publish-row-adds")).toHaveTextContent("+2");
    expect(screen.getByTestId("publish-row-dels")).toHaveTextContent("−1");
  });

  it("auto-closes when the last draft drains while open (no 'Publish 0 changes')", () => {
    const onClose = vi.fn();
    const handlers = {
      onDiscardDraft: vi.fn(),
      onRefreshDraft: vi.fn(),
      onRestoreAsNew: vi.fn(),
      onDiscardAll: vi.fn(),
      onPublish: vi.fn(),
      onClose,
    };
    const { rerender } = render(
      <PublishDialog open drafts={[editDraft(AGENTS, "a\n", "b\n")]} branch="main" {...handlers} />,
    );
    expect(onClose).not.toHaveBeenCalled();

    // A conflict-row Refresh (etc.) dropped the last remaining draft.
    rerender(<PublishDialog open drafts={[]} branch="main" {...handlers} />);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("expands a unified diff under the row on demand", () => {
    renderDialog({ drafts: [editDraft(AGENTS, "hello\n", "hello\nworld\n")] });
    expect(screen.queryByTestId("publish-row-diff")).toBeNull();

    fireEvent.click(screen.getByTestId("publish-row-diff-toggle"));

    const diff = screen.getByTestId("publish-row-diff");
    expect(within(diff).getByText("world")).toBeInTheDocument();
  });

  it("recomputes the correct rows on reopen after sitting closed with the same drafts", () => {
    const handlers = {
      onDiscardDraft: vi.fn(),
      onRefreshDraft: vi.fn(),
      onRestoreAsNew: vi.fn(),
      onDiscardAll: vi.fn(),
      onPublish: vi.fn(),
      onClose: vi.fn(),
    };
    const drafts = [editDraft(AGENTS, "hello\n", "hello\nworld\n"), createDraft(DEPLOY, "---\ndescription: d\n---\n\n")];
    const { rerender } = render(<PublishDialog open={false} drafts={drafts} branch="main" {...handlers} />);

    expect(screen.queryAllByTestId("publish-file-row")).toHaveLength(0);

    rerender(<PublishDialog open drafts={drafts} branch="main" {...handlers} />);

    const rows = screen.getAllByTestId("publish-file-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("AGENTS.md")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("deploy.md")).toBeInTheDocument();
  });

  it("publishes exactly the checked, publishable paths as one commit with the default message", () => {
    const { onPublish } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n"), createDraft(DEPLOY, "---\ndescription: d\n---\n\n")],
    });

    // Uncheck the first row, leaving only DEPLOY checked.
    const checkboxes = screen.getAllByTestId("publish-row-checkbox").map((el) => within(el).getByRole("checkbox"));
    fireEvent.click(checkboxes[0]!);

    fireEvent.click(screen.getByTestId("publish-submit"));

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish).toHaveBeenCalledWith("Update context files", [DEPLOY]);
  });

  it("force-unchecks and disables an invalid row while keeping the valid rest publishable", () => {
    const { onPublish } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n"), createDraft(SKILL, "---\nname: [unclosed\n---\n# Body\n")],
    });

    // The invalid skill row (unparseable frontmatter) shows why and is disabled.
    expect(screen.getByTestId("publish-row-invalid")).toBeInTheDocument();
    const checkboxes = screen.getAllByTestId("publish-row-checkbox").map((el) => within(el).getByRole("checkbox"));
    expect(checkboxes[1]).toBeDisabled();
    expect(checkboxes[1]).not.toBeChecked();

    // The button counts only the publishable row, and publishes only it.
    expect(screen.getByTestId("publish-submit")).toHaveTextContent("Publish 1 change");
    fireEvent.click(screen.getByTestId("publish-submit"));
    expect(onPublish).toHaveBeenCalledWith("Update context files", [AGENTS]);
  });

  it("subtitle counts checked rows, switching to X-of-Y when some are excluded", () => {
    renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n"), createDraft(DEPLOY, "---\ndescription: d\n---\n\n")],
    });
    expect(screen.getByTestId("publish-subtitle")).toHaveTextContent("2 files → main · one commit");
    expect(screen.queryByTestId("publish-row-excluded-hint")).toBeNull();

    const checkboxes = screen.getAllByTestId("publish-row-checkbox").map((el) => within(el).getByRole("checkbox"));
    fireEvent.click(checkboxes[0]!);
    expect(screen.getByTestId("publish-subtitle")).toHaveTextContent(
      "Publishing 1 of 2 files → main · one commit",
    );
    expect(screen.getByTestId("publish-row-excluded-hint")).toHaveTextContent(
      "This file won't be published.",
    );
  });

  it("an invalid (force-unchecked) row also states it won't be published", () => {
    renderDialog({
      drafts: [createDraft(DEPLOY, "---\n[unparseable\n---\n\n")],
    });
    expect(screen.getByTestId("publish-row-invalid")).toBeInTheDocument();
    expect(screen.getByTestId("publish-row-excluded-hint")).toHaveTextContent(
      "This file won't be published.",
    );
  });

  it("warns (does not block) an empty-description file: enabled, checked, amber copy, still published", () => {
    const { onPublish } = renderDialog({
      drafts: [createDraft(SKILL, "---\nname: deploy\ndescription: \n---\n# Body\n")],
    });

    // Warning tier: no hard-error block, an amber warning row with humanized copy.
    expect(screen.queryByTestId("publish-row-invalid")).toBeNull();
    expect(screen.getByTestId("publish-row-warning")).toHaveTextContent(
      "Missing description — publishes as-is.",
    );

    // The row stays enabled and checked by default, and publishes.
    const checkbox = within(screen.getByTestId("publish-row-checkbox")).getByRole("checkbox");
    expect(checkbox).toBeEnabled();
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByTestId("publish-submit"));
    expect(onPublish).toHaveBeenCalledWith("Update context files", [SKILL]);
  });

  it("a modified conflict offers Refresh but not Keep-as-new; the row can't publish", () => {
    const conflict: ContextBatchFileConflict = { path: AGENTS, remoteSha: "moved", reason: "modified" };
    const { onRefreshDraft, onPublish } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      conflicts: { [AGENTS]: conflict },
    });

    expect(screen.getByTestId("publish-row-conflict")).toBeInTheDocument();
    expect(screen.queryByTestId("publish-row-restore-new")).toBeNull();
    // Nothing publishable → submit disabled.
    expect(screen.getByTestId("publish-submit")).toBeDisabled();

    fireEvent.click(screen.getByTestId("publish-row-refresh"));
    expect(onRefreshDraft).toHaveBeenCalledWith(AGENTS);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("an in-flight publish holds the submit busy and takes no second request", () => {
    const { onPublish } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      publishing: true,
    });

    const submit = screen.getByTestId("publish-submit");
    expect(submit).toBeDisabled();
    // A batch commit is not idempotent, so a submit that stays clickable while
    // its request is in flight can commit the same drafts twice.
    fireEvent.click(submit);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("an in-flight row refresh holds only that row's button busy", () => {
    const conflict: ContextBatchFileConflict = { path: AGENTS, remoteSha: "moved", reason: "modified" };
    const { onRefreshDraft } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      conflicts: { [AGENTS]: conflict },
      refreshingPath: AGENTS,
    });

    const refresh = screen.getByTestId("publish-row-refresh");
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(onRefreshDraft).not.toHaveBeenCalled();
  });

  it("a deleted conflict offers Keep-as-new alongside Refresh, wired to onRestoreAsNew", () => {
    const conflict: ContextBatchFileConflict = { path: AGENTS, remoteSha: null, reason: "deleted" };
    const { onRestoreAsNew } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      conflicts: { [AGENTS]: conflict },
    });

    expect(screen.getByTestId("publish-row-refresh")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("publish-row-restore-new"));
    expect(onRestoreAsNew).toHaveBeenCalledWith(AGENTS);
  });

  it("a modified conflict on a staged delete reads 'changed on the remote since you marked it' and offers Restore + Confirm delete, never Keep-as-new", () => {
    const conflict: ContextBatchFileConflict = { path: AGENTS, remoteSha: "moved", reason: "modified" };
    const { onDiscardDraft, onRefreshDraft } = renderDialog({
      drafts: [deleteDraft(AGENTS, "hello\n")],
      conflicts: { [AGENTS]: conflict },
    });

    expect(screen.getByTestId("publish-row-conflict")).toHaveTextContent(
      "Changed on the remote since you marked it.",
    );
    expect(screen.queryByTestId("publish-row-restore-new")).toBeNull();

    fireEvent.click(screen.getByTestId("publish-row-restore-delete"));
    expect(onDiscardDraft).toHaveBeenCalledWith(AGENTS);

    fireEvent.click(screen.getByTestId("publish-row-refresh"));
    expect(onRefreshDraft).toHaveBeenCalledWith(AGENTS);
    expect(screen.getByTestId("publish-row-refresh")).toHaveTextContent("Confirm delete");
  });

  it("a deleted conflict on a staged delete offers only Refresh (already gone remotely) — Keep-as-new never applies to a delete", () => {
    const conflict: ContextBatchFileConflict = { path: AGENTS, remoteSha: null, reason: "deleted" };
    renderDialog({
      drafts: [deleteDraft(AGENTS, "hello\n")],
      conflicts: { [AGENTS]: conflict },
    });

    expect(screen.queryByTestId("publish-row-restore-new")).toBeNull();
    expect(screen.queryByTestId("publish-row-restore-delete")).toBeNull();
    expect(screen.getByTestId("publish-row-refresh")).toBeInTheDocument();
  });

  it("surfaces a server-only validation error on its row and blocks that row from publishing", () => {
    const { onPublish } = renderDialog({
      // Client-valid draft: the only error comes from the server.
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      fileErrors: [
        { path: AGENTS, errors: [{ path: "(frontmatter)", code: "server_rejected", message: "server says no" }] },
      ],
    });

    const invalid = screen.getByTestId("publish-row-invalid");
    expect(within(invalid).getByText("(frontmatter): server says no")).toBeInTheDocument();

    const checkbox = within(screen.getByTestId("publish-row-checkbox")).getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    expect(screen.getByTestId("publish-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("publish-submit"));
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("dedupes issues that share a path and code, keeping the first message", () => {
    renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      fileErrors: [
        {
          path: AGENTS,
          errors: [
            { path: "(frontmatter)", code: "server_rejected", message: "first message" },
            { path: "(frontmatter)", code: "server_rejected", message: "second message" },
          ],
        },
      ],
    });

    const invalid = screen.getByTestId("publish-row-invalid");
    expect(within(invalid).getByText("(frontmatter): first message")).toBeInTheDocument();
    expect(within(invalid).queryByText("(frontmatter): second message")).toBeNull();
  });

  it("shows a per-row refresh error while keeping the Refresh button", () => {
    const conflict: ContextBatchFileConflict = { path: AGENTS, remoteSha: "moved", reason: "modified" };
    renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      conflicts: { [AGENTS]: conflict },
      refreshErrors: { [AGENTS]: "Couldn't check the remote. Try again." },
    });

    expect(screen.getByTestId("publish-row-refresh-error")).toHaveTextContent(
      "Couldn't check the remote. Try again.",
    );
    expect(screen.getByTestId("publish-row-refresh")).toBeInTheDocument();
  });

  it("states the pull-request outcome when app settings require one, and publishes without a destination", () => {
    const { onPublish } = renderDialog({
      drafts: [editDraft(AGENTS, "hello\n", "hi\n")],
      requirePullRequest: true,
    });

    expect(screen.getByTestId("publish-outcome-pr")).toHaveTextContent(
      "Opens a pull request — required by this app's settings.",
    );

    fireEvent.click(screen.getByTestId("publish-submit"));
    expect(onPublish).toHaveBeenCalledWith("Update context files", [AGENTS]);
  });

  it("shows no landing note when app policy allows direct publishing", () => {
    renderDialog({ drafts: [editDraft(AGENTS, "hello\n", "hi\n")] });
    expect(screen.queryByTestId("publish-outcome-pr")).toBeNull();
  });
});
