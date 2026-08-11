// @vitest-environment jsdom
/**
 * Component tests for the Context tab shell (`<ContextView>`): empty-state
 * selection, tree+viewer composition, `?file=` selection, permission-gated
 * edit/delete, and the multi-file draft → publish-dialog wiring (footer
 * summary, batch commit outcomes, per-row conflict recovery). Drafts are
 * ephemeral (in-memory) and seeded through the UI (probe-edit / the create
 * popover's onCreate), never localStorage.
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md):
 *  - The tree/file/skill reads are seeded by a React Server Component (RSC)
 *    as props, with the REAL SWR hooks
 *    running; their read-action revalidation door (`@/features/context/
 *    read-actions`) is the server seam → `vi.mock`.
 *  - `@/lib/app-shell/app-context`, `@/auth/hooks/use-app-permissions` are seams.
 *  - `resyncContextAction` / `readRemoteContextFileAction` /
 *    `commitContextChangesAction` are server-action seams → `vi.mock`.
 *  - `./editor` (ContextEditor, PublishDialog, CreateFilePopover,
 *    DeleteContextDialog, useUnsavedChangesGuard) is mocked to probes so the
 *    suite asserts THIS component's wiring without booting CodeMirror/Milkdown.
 *  - The real `useContextDrafts` runs.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Permissions } from "@/utils/permissions";
import type { ContextFileResponse, ContextTreeResponse } from "../../types";
import type { ContextEditorProps, DeleteTarget, PublishDialogProps, StagedDeleteTarget } from "../editor";
import type { ContextBatchCommitOutcome } from "@/lib/adapters/context-save";

type CommitResponse = { data: ContextBatchCommitOutcome } | { error: string };

// Render with the real i18n + en.json so the toggle/footer/banner copy
// assertions prove the translation keys and interpolation params resolve to the
// shipped English, and the <Translation> PR banner renders (the global stub has
// no Translation export).
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => ({ app: { id: "app-1", require_pull_request: false } }),
}));

const mockEnqueue = vi.fn((..._args: [message: string, options?: unknown]) => "snackbar-key");
const mockCloseSnackbar = vi.fn();
vi.mock("@/components/snackbar", () => ({
  useSnackbar: () => ({ enqueueSnackbar: mockEnqueue, closeSnackbar: mockCloseSnackbar }),
}));

// Captures the CreateFilePopover's onCreate so tests can seed create drafts
// through the store (drafts are ephemeral — there's no localStorage to preseed).
const createHandleRef = vi.hoisted(() => ({
  current: null as null | ((f: { path: string; content: string }) => void),
}));

// Per-permission grant predicate so tests can diverge context.update from
// context.delete (a single boolean can't express a delete-only role).
let hasPermissionMock: (perm: string) => boolean = () => true;
vi.mock("@/auth/hooks/use-app-permissions", () => ({
  useAppPermissions: () => ({
    permissions: [],
    isLoading: false,
    hasPermission: (perm: string) => hasPermissionMock(perm),
  }),
}));

const mockResync = vi.fn(async (..._args: unknown[]) => ({ data: { kind: "synced" } }));

type RemoteReadResult =
  | { data: { content: string | null; blobSha: string | null; commitSha: string | null } }
  | { error: string };
const mockReadRemote = vi.fn(
  async (..._args: unknown[]): Promise<RemoteReadResult> => ({
    data: { content: "# remote", blobSha: "remote-sha", commitSha: "head-sha" },
  }),
);

const mockCommit = vi.fn(
  async (..._args: unknown[]): Promise<CommitResponse> => ({
    data: { status: "saved", result: { landed: "branch", commitSha: "head-sha", branch: "main" }, warnings: [] },
  }),
);
const mockCheckPendingPrs = vi.fn(async (..._args: unknown[]) => ({ data: { decided: [] as number[] } }));
vi.mock("@/features/context/action-adapters", () => ({
  readRemoteContextFileAction: (...args: unknown[]) => mockReadRemote(...args),
  commitContextChangesAction: (...args: unknown[]) => mockCommit(...args),
  checkPendingPullRequestsAction: (...args: unknown[]) => mockCheckPendingPrs(...args),
  resyncContextAction: (...args: unknown[]) => mockResync(...args),
}));

// The tree/file/skill reads are RSC-seeded (props) and re-read on demand through
// the context read actions. Mock that server seam over mutable state so the RSC
// seed (via `renderView` props) and every `mutate()` revalidation resolve from
// the same source — a stand-in for the mirror the real actions read.
const { ctxState } = vi.hoisted(() => ({
  ctxState: {
    tree: null as unknown as import("../../types").ContextTreeResponse,
    files: [] as import("../../types").ContextFileResponse[],
  },
}));
// The read actions gate on context.read, so they resolve to the action-kit
// result envelope; the hooks unwrap it. A not-found file rejects (the same
// error state the deleted route's 404 produced).
vi.mock("@/features/context/read-actions", () => ({
  getContextTree: vi.fn(async () => ({ ok: true, data: ctxState.tree })),
  getContextFile: vi.fn(async ({ path }: { path: string }) => {
    const match = ctxState.files.find((f) => f.path === path);
    if (!match) throw new Error("context file not found");
    return { ok: true, data: match };
  }),
  getContextOverview: vi.fn(async () => ({
    ok: true,
    data: {
      range: "30d",
      recentDays: 14,
      lookbackDays: 90,
      degraded: false,
      skills: [],
      mcpServers: [],
      coverage: {
        sessions: 0,
        sessionsWithSkill: 0,
        priorSessions: 0,
        priorSessionsWithSkill: 0,
        lookbackSessions: 0,
      },
      topics: [],
      inventory: { instructionScopes: 0, commands: 0, subagents: 0 },
    },
  })),
  getContextSkillDrilldown: vi.fn(async () => ({ ok: true, data: { trend: [], sessions: [], topics: [], lookbackDays: 90 } })),
  getContextMcpDrilldown: vi.fn(async () => ({ ok: true, data: { tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 } })),
}));

// Probe editor: lifts content changes up (controlled) and exposes publish/delete.
vi.mock("../editor", () => ({
  useUnsavedChangesGuard: () => {},
  ContextEditor: (props: ContextEditorProps) => (
    <div
      data-testid="editor-probe"
      data-path={props.file.path}
      data-readonly={String(props.readOnly ?? false)}
      data-candelete={String(props.canDelete ?? false)}
      data-createdraft={String(props.isCreateDraft ?? false)}
      data-draftcount={String(props.draftCount ?? 0)}
      data-content={props.content}
    >
      <button data-testid="probe-edit" onClick={() => props.onContentChange(`${props.content}\nedit`)}>
        edit
      </button>
      <button data-testid="probe-revert" onClick={() => props.onContentChange(props.file.content)}>
        revert
      </button>
      <button data-testid="probe-publish" onClick={() => props.onPublish?.()}>
        publish
      </button>
      <button data-testid="probe-delete" onClick={() => props.onDelete?.()}>
        delete
      </button>
    </div>
  ),
  PublishDialog: (props: PublishDialogProps) =>
    props.open ? (
      <div
        data-testid="publish-dialog-probe"
        data-count={props.drafts.length}
        data-paths={props.drafts.map((d) => d.path).join(",")}
        data-createpaths={props.drafts.filter((d) => d.changeType === "create").map((d) => d.path).join(",")}
        data-conflicts={Object.keys(props.conflicts ?? {}).join(",")}
        data-conflict-reasons={Object.entries(props.conflicts ?? {})
          .map(([path, c]) => `${path}:${c.reason}`)
          .join(",")}
        data-fileerrors={(props.fileErrors ?? []).map((f) => f.path).join(",")}
        data-refresh-errors={Object.keys(props.refreshErrors ?? {}).join(",")}
        data-error={props.errorMessage ?? ""}
        data-publishing={String(props.publishing ?? false)}
        data-requirepr={String(props.requirePullRequest ?? false)}
        data-branch={props.branch}
      >
        <button
          data-testid="probe-publish-direct"
          onClick={() => props.onPublish("Publish message", props.drafts.map((d) => d.path))}
        >
          publish-direct
        </button>
        <button
          data-testid="probe-publish-pr"
          onClick={() => props.onPublish("Publish message", props.drafts.map((d) => d.path))}
        >
          publish-pr
        </button>
        <button
          data-testid="probe-publish-first"
          onClick={() => props.onPublish("Publish message", [props.drafts[0]!.path])}
        >
          publish-first
        </button>
        <button data-testid="probe-refresh-one" onClick={() => props.onRefreshDraft(props.drafts[0]!.path)}>
          refresh
        </button>
        <button data-testid="probe-restore-new" onClick={() => props.onRestoreAsNew(props.drafts[0]!.path)}>
          restore-new
        </button>
        <button data-testid="probe-discard-one" onClick={() => props.onDiscardDraft(props.drafts[0]!.path)}>
          discard-one
        </button>
        <button data-testid="probe-discard-all" onClick={() => props.onDiscardAll()}>
          discard-all
        </button>
        <button data-testid="probe-publish-close" onClick={() => props.onClose()}>
          close
        </button>
      </div>
    ) : null,
  CreateFilePopover: (props: { onCreate: (f: { path: string; content: string }) => void }) => {
    createHandleRef.current = props.onCreate;
    return null;
  },
  DeleteContextDialog: (props: {
    onStage: (targets: StagedDeleteTarget[]) => void;
    target: DeleteTarget;
  }) => (
    <div data-testid="delete-probe">
      <button
        data-testid="probe-stage-delete"
        onClick={() =>
          props.onStage(
            props.target.kind === "file"
              ? [{ path: props.target.path, baseBlobSha: props.target.baseBlobSha, baseContent: props.target.content }]
              : props.target.kind === "skill"
                ? [{ path: `${props.target.skillDir}/SKILL.md`, baseBlobSha: "probe-sha", baseContent: "" }]
                : [{ path: `${props.target.dirPath}/probe.md`, baseBlobSha: "probe-sha", baseContent: "" }],
          )
        }
      >
        stage-delete
      </button>
    </div>
  ),
}));

import { ContextView } from "../context-view";
import { getContextTree, getContextFile } from "../../read-actions";

const TREE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "head-sha", snapshotId: "snap-1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
    { path: ".outerlayer/commands/deploy.md", kind: "command", scopePath: "", blobSha: "b2" },
    { path: ".outerlayer/skills/deploy/SKILL.md", kind: "skill", scopePath: "", skillName: "deploy", blobSha: "b3" },
  ],
  excludedCounts: [],
  issues: [],
  mcpServerCounts: [],
  requirePullRequest: false,
};

const AGENTS_FILE: ContextFileResponse = {
  path: ".outerlayer/AGENTS.md",
  kind: "instructions",
  blobSha: "b1",
  commitSha: "head-sha",
  content: "# Hello\n\nBody text.\n",
  oversize: false,
  frontmatter: { parsed: null, issues: [] },
};

const SKILL_FILE: ContextFileResponse = {
  path: ".outerlayer/skills/deploy/SKILL.md",
  kind: "skill",
  blobSha: "b3",
  commitSha: "head-sha",
  content: "---\nname: deploy\ndescription: d\n---\n# Deploy\n",
  oversize: false,
  frontmatter: { parsed: { name: "deploy", description: "d" }, issues: [] },
};

const EXTERNAL_FILE: ContextFileResponse = {
  path: "AGENTS.md",
  kind: "external-instructions",
  blobSha: "bx",
  commitSha: "head-sha",
  content: "# Root instructions, not managed by OuterLayer\n",
  oversize: false,
  frontmatter: { parsed: null, issues: [] },
};

function seedContextApi(tree: ContextTreeResponse, files: ContextFileResponse[] = []) {
  ctxState.tree = tree;
  ctxState.files = files;
}

// The `?file=` the RSC seeded `initialFile` for — mirrors the real page, where
// the RSC re-runs on a `?file=` change and reseeds the selected file. This
// suite exercises the FILES view, so the explicit `view=files` param rides
// along (the bare URL lands on the Overview; its suite lives next door).
let currentSelectedPath: string | null = null;
function setSelectedFile(path: string | null) {
  currentSelectedPath = path;
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(path ? { view: "files", file: path } : { view: "files" }) as never,
  );
}

/** Seeds a create draft through the real store via the create popover's onCreate (post-render). */
function createDraftViaUi(path: string, content = "---\ndescription: d\n---\n") {
  act(() => createHandleRef.current!({ path, content }));
}

const replaceSpy = vi.fn();

function renderView() {
  const initialFile = currentSelectedPath
    ? (ctxState.files.find((f) => f.path === currentSelectedPath) ?? null)
    : null;
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ContextView
        appId="app-1"
        initialTree={ctxState.tree}
        initialFile={initialFile}
        initialSelectedPath={currentSelectedPath}
      />
    </SWRConfig>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  createHandleRef.current = null;
  currentSelectedPath = null;
  ctxState.tree = null as unknown as ContextTreeResponse;
  ctxState.files = [];
  hasPermissionMock = () => true;
  mockResync.mockClear();
  mockReadRemote.mockClear();
  mockEnqueue.mockClear();
  mockCloseSnackbar.mockClear();
  mockCommit.mockClear();
  mockCheckPendingPrs.mockClear();
  mockCheckPendingPrs.mockResolvedValue({ data: { decided: [] } });
  mockCommit.mockResolvedValue({
    data: { status: "saved", result: { landed: "branch", commitSha: "head-sha", branch: "main" }, warnings: [] },
  });
  replaceSpy.mockClear();
  vi.mocked(useParams).mockReturnValue({ orgName: "org-1", appName: "app-one" } as never);
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: replaceSpy,
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  } as never);
  setSelectedFile(null);
});

describe("<ContextView> — empty states", () => {
  it("shows the connect-repo state when the app has no git connection, CTA pointed at general settings", async () => {
    seedContextApi({ ...TREE, gitConnection: null, head: null, entries: [] });
    renderView();
    expect(await screen.findByText("No repository connected")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /Connect a repository/ });
    expect(cta).toHaveAttribute("href", "/orgs/org-1/apps/app-one/env/dev/settings/general");
    // The page-level state is the shared card, and its CTA has to survive the
    // move into the primitive's single `action` slot.
    expect(within(screen.getByTestId("empty-state")).getByRole("link", { name: /Connect a repository/ })).toBe(cta);
  });

  it("shows the never-synced state when connected but head is null, keeping both CTAs", async () => {
    seedContextApi({ ...TREE, head: null, entries: [] });
    renderView();

    const card = await screen.findByTestId("empty-state");
    expect(within(card).getByText("Set up context for this repo")).toBeInTheDocument();
    // Two actions in a slot typed for one node — the docs link and the resync
    // button, which is the pair a naive migration drops to a single CTA.
    expect(within(card).getByRole("link", { name: /Set up context/ })).toBeInTheDocument();
    expect(within(card).getByTestId("context-resync-button")).toBeInTheDocument();
    // Setup pending is not a fault: this card must not announce itself as one,
    // which is the structural difference from the failure card it resembles.
    expect(card).not.toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
  });

  it("shows the no-context state inside the editor pane, without nesting a card in it", async () => {
    seedContextApi({ ...TREE, entries: [] });
    renderView();
    expect(await screen.findByText("No context yet")).toBeInTheDocument();
    // This state renders inside the pane's own outlined box, so the shared card
    // would draw a box inside a box. Asserted as an absence because the failure
    // mode is a later sweep "finishing" the migration.
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
  });

  it("shows a retryable error — not an empty state — when the tree read fails", async () => {
    // No RSC seed and the revalidation rejects → the surface has no tree.
    vi.mocked(getContextTree).mockRejectedValueOnce(new Error("tree read failed"));
    renderView();

    const failure = await screen.findByTestId("error-state");
    // Asserted structurally, not by copy: the failure card and the empty cards
    // are deliberately near-identical to look at, so heading text cannot tell
    // them apart. What separates them is that a failure announces itself and
    // offers a way to retry.
    expect(failure).toHaveAttribute("role", "alert");
    expect(within(failure).getByTestId("error-state-retry")).toBeInTheDocument();
    // A failed load rendered as an empty state tells the user their context is
    // gone rather than unreachable.
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
  });

  it("retrying a failed tree read re-reads the tree", async () => {
    vi.mocked(getContextTree).mockRejectedValueOnce(new Error("tree read failed"));
    renderView();
    // Counted once the failure is on screen — the read is still in flight at
    // render, so a count taken before this is zero and proves nothing.
    const retry = await screen.findByTestId("error-state-retry");
    const callsBeforeRetry = vi.mocked(getContextTree).mock.calls.length;

    fireEvent.click(retry);

    // An error the user cannot retry from is a dead end, and a retry button
    // wired to nothing looks identical to a working one.
    await waitFor(() => {
      expect(vi.mocked(getContextTree).mock.calls.length).toBe(callsBeforeRetry + 1);
    });
  });
});

describe("<ContextView> — tree + viewer composition", () => {
  it("renders the header (repo · branch), the tree, and the select-a-file placeholder", async () => {
    seedContextApi(TREE);
    renderView();
    expect(await screen.findByText("acme/app · main")).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Context files" })).toBeInTheDocument();
    expect(screen.getByText("Select a file to view its contents.")).toBeInTheDocument();
  });

  it("puts the title, the repo caption and both header controls in the shared header's own slots", async () => {
    seedContextApi(TREE);
    renderView();

    // The caption slot, not just "somewhere in the header" — a repo line that
    // lands in the title or the actions row reads as a different page. Awaited
    // because the repo identity arrives with the tree, not at first paint.
    expect((await screen.findByTestId("page-header-caption")).textContent).toBe("acme/app · main");
    const header = screen.getByTestId("page-header");
    expect(within(header).getByRole("heading", { level: 4 }).textContent).toBe("Context");
    const actions = screen.getByTestId("page-header-actions");
    // By role, not label: the Tooltip clones `aria-label` onto its own wrapper
    // span, so a label query matches two nodes.
    expect(within(actions).getByRole("button", { name: "Resync context" })).toBeInTheDocument();
    expect(within(actions).getByRole("group", { name: "context view" })).toBeInTheDocument();
  });

  it("selecting a tree file writes ?file= via router.replace (shareable URL contract)", async () => {
    seedContextApi(TREE);
    renderView();
    fireEvent.click(await screen.findByText("AGENTS.md"));
    expect(replaceSpy).toHaveBeenCalledWith(
      "/test-path?view=files&file=.outerlayer%2FAGENTS.md",
      { scroll: false },
    );
  });

  it("always mounts the editor for the ?file= selection, writable under context.update", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    const probe = await screen.findByTestId("editor-probe");
    expect(probe.getAttribute("data-path")).toBe(".outerlayer/AGENTS.md");
    expect(probe.getAttribute("data-readonly")).toBe("false");
    expect(probe.getAttribute("data-candelete")).toBe("true");
    // Editor seeds from the loaded file content when there is no draft.
    expect(probe.getAttribute("data-content")).toBe(AGENTS_FILE.content);
  });

  it("mounts the editor READ-ONLY without the permission", async () => {
    hasPermissionMock = () => false;
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    const probe = await screen.findByTestId("editor-probe");
    expect(probe.getAttribute("data-readonly")).toBe("true");
    expect(probe.getAttribute("data-candelete")).toBe("false");
  });

  it("keeps Delete for a delete-granted user who lacks context.update (granular, not folded into the write gate)", async () => {
    // Delete + read granted, update denied — a normal file is read-only to edit
    // but still deletable.
    hasPermissionMock = (perm) => perm !== Permissions.CONTEXT_UPDATE;
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    const probe = await screen.findByTestId("editor-probe");
    expect(probe.getAttribute("data-readonly")).toBe("true");
    expect(probe.getAttribute("data-candelete")).toBe("true");
  });

  it("offers no delete for a read-only external-instructions file even with delete permission", async () => {
    // Full permissions — the file is read-only by kind, not by grant.
    seedContextApi(TREE, [EXTERNAL_FILE]);
    setSelectedFile(EXTERNAL_FILE.path);
    renderView();
    const probe = await screen.findByTestId("editor-probe");
    expect(probe.getAttribute("data-readonly")).toBe("true");
    // Hidden by kind, so the editor gets neither the delete grant nor the
    // handler → no overflow menu at all.
    expect(probe.getAttribute("data-candelete")).toBe("false");
  });

  it("shows the could-not-load placeholder when the file endpoint 404s", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(".outerlayer/gone.md");
    renderView();
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe("<ContextView> — drafts + footer", () => {
  it("hides the footer until an edit, then shows the summary; reverting to the loaded bytes drops the draft", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    await screen.findByTestId("editor-probe");
    expect(screen.queryByTestId("tree-draft-footer")).toBeNull();

    fireEvent.click(screen.getByTestId("probe-edit"));
    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 edited");

    fireEvent.click(screen.getByTestId("probe-revert"));
    expect(screen.queryByTestId("tree-draft-footer")).toBeNull();
  });

  it("summarizes edited and new counts separately in the footer", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    // One edit on the open file plus one freshly created file.
    fireEvent.click(await screen.findByTestId("probe-edit"));
    createDraftViaUi(".outerlayer/commands/added.md");

    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 edited · 1 new");
  });

  it("adds a deleted count alongside new/edited in the footer summary", async () => {
    seedContextApi(TREE, [SKILL_FILE]);
    setSelectedFile(SKILL_FILE.path);
    renderView();
    // A staged delete on the selected file, plus an independent new-file draft.
    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));
    createDraftViaUi(".outerlayer/commands/added.md");

    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 new · 1 deleted");
  });

  it("marks the edited file with a dirty dot in the tree", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    expect(screen.getByTestId("tree-dirty-dot")).toBeInTheDocument();
  });

  it("discarding an edit from the tree's dot drops the draft, and the snackbar's Undo restores the exact same draft", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    const editedContent = `${AGENTS_FILE.content}\nedit`;
    expect(screen.getByTestId("editor-probe")).toHaveAttribute("data-content", editedContent);

    fireEvent.click(screen.getByTestId("tree-dirty-dot-trigger"));
    fireEvent.click(screen.getByTestId("tree-dirty-dot-action"));

    // The tree reuses the exact PublishDialog discard path: dropped like any
    // other discard — no dirty dot, no footer, editor content reverts to head.
    expect(screen.queryByTestId("tree-dirty-dot")).toBeNull();
    expect(screen.queryByTestId("tree-draft-footer")).toBeNull();
    expect(screen.getByTestId("editor-probe")).toHaveAttribute("data-content", AGENTS_FILE.content);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [, options] = mockEnqueue.mock.calls[0]!;
    const undoButton = (options as { action: (key: string) => React.ReactElement }).action("snackbar-key");
    act(() => {
      (undoButton.props as { onClick: () => void }).onClick();
    });

    // The undo re-adds the SAME draft object (exact content round-trip), and
    // closes the snackbar it came from.
    expect(screen.getByTestId("tree-dirty-dot")).toBeInTheDocument();
    expect(screen.getByTestId("editor-probe")).toHaveAttribute("data-content", editedContent);
    expect(mockCloseSnackbar).toHaveBeenCalledWith("snackbar-key");
  });

  it("does not let a stale Undo clobber a fresh draft re-edited on the same path within the snackbar window", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));

    fireEvent.click(screen.getByTestId("tree-dirty-dot-trigger"));
    fireEvent.click(screen.getByTestId("tree-dirty-dot-action"));
    expect(screen.queryByTestId("tree-dirty-dot")).toBeNull();

    // Re-edit the SAME path before touching Undo — twice, so its content is
    // distinguishable from what a stale Undo would restore.
    fireEvent.click(screen.getByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-edit"));
    const freshContent = `${AGENTS_FILE.content}\nedit\nedit`;
    expect(screen.getByTestId("editor-probe")).toHaveAttribute("data-content", freshContent);

    const [, options] = mockEnqueue.mock.calls[0]!;
    const undoButton = (options as { action: (key: string) => React.ReactElement }).action("snackbar-key");
    act(() => {
      (undoButton.props as { onClick: () => void }).onClick();
    });

    // The captured (now-stale) draft is discarded, not restored over the newer one.
    expect(screen.getByTestId("editor-probe")).toHaveAttribute("data-content", freshContent);
    expect(mockCloseSnackbar).toHaveBeenCalledWith("snackbar-key");
  });

  it("clicking the footer opens the publish dialog with every staged draft and the app branch", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("tree-draft-footer"));

    const dialog = screen.getByTestId("publish-dialog-probe");
    expect(dialog.getAttribute("data-count")).toBe("1");
    expect(dialog.getAttribute("data-paths")).toBe(".outerlayer/AGENTS.md");
    expect(dialog.getAttribute("data-branch")).toBe("main");
  });

  it("passes the app PR policy through to the publish dialog", async () => {
    seedContextApi({ ...TREE, requirePullRequest: true }, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();

    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-requirepr")).toBe("true");
  });

  it("revalidates the tree when the publish dialog opens so a changed PR policy isn't stale", async () => {
    // Page loads with direct-publish policy…
    seedContextApi({ ...TREE, requirePullRequest: false }, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));

    // …then the app flips to require-PR after load. Opening the dialog must
    // revalidate and reflect the new landing, not the policy baked in at load.
    ctxState.tree = { ...TREE, requirePullRequest: true };
    fireEvent.click(screen.getByTestId("tree-draft-footer"));

    // Dialog opens immediately (stale), then flips once revalidation resolves.
    expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-requirepr")).toBe("false");
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-requirepr")).toBe("true"),
    );
  });

  it("Discard all wipes every draft after confirmation", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-discard-all"));
    fireEvent.click(screen.getByTestId("discard-all-confirm"));
    expect(screen.queryByTestId("tree-draft-footer")).toBeNull();
  });
});

describe("<ContextView> — publish outcomes", () => {
  it("commits the staged drafts through the batch action, then clears drafts and nudges a resync (branch landing)", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    expect(mockCommit).toHaveBeenCalledWith("app-1", {
      message: "Publish message",
      files: [{ path: ".outerlayer/AGENTS.md", content: `${AGENTS_FILE.content}\nedit`, baseBlobSha: "b1" }],
    });
    await waitFor(() => expect(screen.queryByTestId("tree-draft-footer")).toBeNull());
    expect(mockResync).toHaveBeenCalledWith("app-1");
  });

  it("a rejected commit action (e.g. a gateway timeout) clears publishing and surfaces an error, without an unhandled rejection", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    mockCommit.mockRejectedValueOnce(new Error("504"));
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    // The dialog stays open (not a dead spinner) with publishing cleared and an
    // error surfaced — no drafts were dropped, no resync fired.
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe")).toHaveAttribute("data-publishing", "false"),
    );
    expect(screen.getByTestId("publish-dialog-probe")).not.toHaveAttribute("data-error", "");
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("a PR landing pins the pending-PR banner on the committed file and never nudges a resync", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "saved",
        result: {
          landed: "pull_request",
          commitSha: "c1",
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          prAction: "created",
          reason: "config",
          branch: "main",
        },
        warnings: [],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-pr"));

    expect(await screen.findByTestId("viewer-pr-banner")).toHaveTextContent(
      /Change submitted.*PR #7/,
    );
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("drops the pending-PR tag once its PR is reported decided, without needing a page reload", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "saved",
        result: {
          landed: "pull_request",
          commitSha: "c1",
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          prAction: "created",
          reason: "config",
          branch: "main",
        },
        warnings: [],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-pr"));
    expect(await screen.findByTestId("viewer-pr-banner")).toBeInTheDocument();

    // Still open: a tree refresh must not clear the tag on its own.
    fireEvent.click(screen.getByRole("button", { name: "Resync context" }));
    await waitFor(() => expect(mockCheckPendingPrs).toHaveBeenCalledWith("app-1", [7]));
    expect(screen.getByTestId("viewer-pr-banner")).toBeInTheDocument();

    // The PR merges — the next check reports it decided.
    mockCheckPendingPrs.mockResolvedValue({ data: { decided: [7] } });
    fireEvent.click(screen.getByRole("button", { name: "Resync context" }));
    await waitFor(() => expect(screen.queryByTestId("viewer-pr-banner")).toBeNull());
  });

  it("keeps the unchecked drafts when only a subset is published", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    // Two staged drafts: an edit on the open file and a freshly created file.
    fireEvent.click(await screen.findByTestId("probe-edit"));
    createDraftViaUi(".outerlayer/commands/added.md");
    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    fireEvent.click(screen.getByTestId("probe-publish-first"));

    // Only the first path (the edit) was sent…
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    expect(mockCommit).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({
        files: [{ path: ".outerlayer/AGENTS.md", content: `${AGENTS_FILE.content}\nedit`, baseBlobSha: "b1" }],
      }),
    );
    // …and the unpublished created file survives.
    await waitFor(() => expect(screen.getByTestId("changes-count")).toHaveTextContent("1 new"));
  });

  it("surfaces per-path conflicts and keeps the drafts when the commit conflicts", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "conflict",
        conflicts: [{ path: ".outerlayer/AGENTS.md", remoteSha: "moved", reason: "modified" }],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );
    expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-count")).toBe("1");
  });

  it("per-row Refresh re-reads the remote base and clears that path's conflict", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "conflict",
        conflicts: [{ path: ".outerlayer/AGENTS.md", remoteSha: "moved", reason: "modified" }],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );

    fireEvent.click(screen.getByTestId("probe-refresh-one"));
    await waitFor(() => expect(mockReadRemote).toHaveBeenCalledWith("app-1", ".outerlayer/AGENTS.md"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(""),
    );
  });

  it("drops the draft when a refresh finds the remote already matches the buffer (no zero-diff publish)", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "conflict",
        conflicts: [{ path: ".outerlayer/AGENTS.md", remoteSha: "moved", reason: "modified" }],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );

    // The remote now holds exactly the buffered content — nothing left to publish.
    mockReadRemote.mockResolvedValueOnce({
      data: { content: `${AGENTS_FILE.content}\nedit`, blobSha: "caught-up-sha", commitSha: "head-sha" },
    });
    fireEvent.click(screen.getByTestId("probe-refresh-one"));
    await waitFor(() => expect(screen.queryByTestId("tree-draft-footer")).toBeNull());
  });

  it("Keep-as-new on a deleted conflict converts the draft to a create and clears the conflict", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "conflict",
        conflicts: [{ path: ".outerlayer/AGENTS.md", remoteSha: null, reason: "deleted" }],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );

    fireEvent.click(screen.getByTestId("probe-restore-new"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(""),
    );
    // The draft is now a create (no base) rather than an edit.
    expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-createpaths")).toBe(
      ".outerlayer/AGENTS.md",
    );
  });
});

describe("<ContextView> — navigation guarding + delete", () => {
  it("gates the History switch behind the discard confirm while drafts exist, and discarding proceeds", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    replaceSpy.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "history" }));
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("view-leave-confirm-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("view-leave-discard"));
    expect(replaceSpy).toHaveBeenCalledWith(
      "/test-path?view=history&file=.outerlayer%2FAGENTS.md",
      { scroll: false },
    );
  });

  it("discards the drafts when the leave confirm proceeds (ephemeral — the footer clears)", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 edited");

    fireEvent.click(screen.getByRole("button", { name: "history" }));
    fireEvent.click(screen.getByTestId("view-leave-discard"));

    // Discard clears the buffer even though router.replace is a spy (view stays).
    expect(screen.queryByTestId("tree-draft-footer")).toBeNull();
    expect(screen.queryByTestId("changes-count")).toBeNull();
  });

  it("staging a delete never commits by itself — only the footer and dialog change until publish", async () => {
    seedContextApi(TREE, [SKILL_FILE]);
    setSelectedFile(SKILL_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));

    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 deleted");
    expect(mockCommit).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalledWith("/test-path?view=files", { scroll: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("publishing a staged delete clears the selection, shows a landing snackbar, and catches the mirror up", async () => {
    seedContextApi(TREE, [SKILL_FILE]);
    setSelectedFile(SKILL_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));
    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    await waitFor(() =>
      expect(mockCommit).toHaveBeenCalledWith("app-1", {
        message: "Publish message",
        files: [{ path: SKILL_FILE.path, content: "", baseBlobSha: "probe-sha", delete: true }],
      }),
    );
    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/test-path?view=files", { scroll: false });
    });
    // The delete lands with the same feedback as any other publish: a snackbar
    // naming where it went…
    await waitFor(() =>
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.stringContaining("Changes pushed to main"),
        { variant: "success" },
      ),
    );
    // …and the direct-commit catch-up (resync + poll) runs so the row drops.
    expect(mockResync).toHaveBeenCalledWith("app-1");
  });

  it("hides the published-delete row from the tree immediately even while the tree response still lists it", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    const tree = await screen.findByRole("tree");
    // Present to start — the seeded tree response includes it.
    expect(within(tree).getByText("AGENTS.md")).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));
    // Staged-but-unpublished: the row is still there (marked for deletion).
    expect(within(tree).getByText("AGENTS.md")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    // The row disappears once published, though the mirror (tree response) still
    // lists AGENTS.md — the client-side hide, not the head advance, drives this.
    await waitFor(() => expect(within(tree).queryByText("AGENTS.md")).toBeNull());
    // The tree response is unchanged: the other entries are still rendered.
    expect(within(tree).getByText("deploy.md")).toBeInTheDocument();

    // Selection released and the landing snackbar shown.
    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith("/test-path?view=files", { scroll: false }),
    );
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.stringContaining("Changes pushed to main"),
      { variant: "success" },
    );
  });

  it("staging a delete over an edited file supersedes the edit, and publish drops the draft with no stale change lingering", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    // Buffer an edit, then stage a delete on the same file.
    fireEvent.click(await screen.findByTestId("probe-edit"));
    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 edited");

    fireEvent.click(screen.getByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));

    // The delete supersedes the edit — one draft, now a deletion, not two.
    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 deleted");

    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    // Once published, the footer clears and no publish row survives.
    await waitFor(() => expect(screen.queryByTestId("tree-draft-footer")).toBeNull());
    expect(screen.queryByTestId("changes-count")).toBeNull();
  });
});

const NEW_CMD = ".outerlayer/commands/new-cmd.md";

describe("<ContextView> — server errors + refresh recovery", () => {
  it("stores server file errors and passes them to the publish dialog on validation_error", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "validation_error",
        fileErrors: [
          { path: ".outerlayer/AGENTS.md", errors: [{ path: "(frontmatter)", code: "server_rejected", message: "nope" }] },
        ],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));

    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-fileerrors")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );
    expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-error")).toContain(
      "validation errors",
    );
  });

  it("surfaces a per-row refresh error when the remote read fails, leaving the conflict intact", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "conflict",
        conflicts: [{ path: ".outerlayer/AGENTS.md", remoteSha: "moved", reason: "modified" }],
      },
    });
    mockReadRemote.mockResolvedValueOnce({ error: "repo_not_connected" });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );

    fireEvent.click(screen.getByTestId("probe-refresh-one"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-refresh-errors")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );
    // The conflict is untouched — a failed read must not clear or corrupt it.
    expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
      ".outerlayer/AGENTS.md",
    );
  });

  it("turns a remote-deleted refresh into a deleted conflict, not a null-base edit", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "conflict",
        conflicts: [{ path: ".outerlayer/AGENTS.md", remoteSha: "moved", reason: "modified" }],
      },
    });
    mockReadRemote.mockResolvedValueOnce({ data: { content: null, blobSha: null, commitSha: "head-sha" } });
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-edit"));
    fireEvent.click(screen.getByTestId("probe-publish"));
    fireEvent.click(screen.getByTestId("probe-publish-direct"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflicts")).toBe(
        ".outerlayer/AGENTS.md",
      ),
    );

    fireEvent.click(screen.getByTestId("probe-refresh-one"));
    await waitFor(() =>
      expect(screen.getByTestId("publish-dialog-probe").getAttribute("data-conflict-reasons")).toBe(
        ".outerlayer/AGENTS.md:deleted",
      ),
    );
  });
});

describe("<ContextView> — pending-PR pane + create-draft selection", () => {
  it("shows a calm pending-PR pane for a create published as a PR (absent from the mirror)", async () => {
    mockCommit.mockResolvedValueOnce({
      data: {
        status: "saved",
        result: {
          landed: "pull_request",
          commitSha: "c1",
          pullRequestNumber: 12,
          pullRequestUrl: "https://github.com/acme/app/pull/12",
          prAction: "created",
          reason: "config",
          branch: "main",
        },
        warnings: [],
      },
    });
    seedContextApi(TREE, [AGENTS_FILE]); // NEW_CMD isn't seeded → 404 at the mirror
    setSelectedFile(NEW_CMD);
    renderView();
    await screen.findByPlaceholderText("Filter files"); // tree loaded → create popover mounted
    createDraftViaUi(NEW_CMD); // selected create draft → editor opens on it
    await screen.findByTestId("editor-probe");
    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    fireEvent.click(screen.getByTestId("probe-publish-pr"));

    const pane = await screen.findByTestId("viewer-pending-pr-pane");
    expect(pane).toHaveTextContent("PR #12");
  });

  it("clears ?file= when the selected create draft is discarded", async () => {
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(NEW_CMD);
    renderView();
    await screen.findByPlaceholderText("Filter files");
    createDraftViaUi(NEW_CMD);
    await screen.findByTestId("editor-probe");
    fireEvent.click(screen.getByTestId("tree-draft-footer"));
    replaceSpy.mockClear();

    fireEvent.click(screen.getByTestId("probe-discard-one"));
    expect(replaceSpy).toHaveBeenCalledWith("/test-path?view=files", { scroll: false });
  });
});

describe("<ContextView> — delete-draft restore pane", () => {
  it("shows a restore pane instead of the editor while the selected file is staged for deletion", async () => {
    seedContextApi(TREE, [SKILL_FILE]);
    setSelectedFile(SKILL_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));

    expect(screen.queryByTestId("editor-probe")).toBeNull();
    expect(await screen.findByTestId("viewer-deleted-pane")).toHaveTextContent("Marked for deletion");
  });

  it("restoring a staged delete drops the draft and reopens the editor on the loaded file", async () => {
    seedContextApi(TREE, [SKILL_FILE]);
    setSelectedFile(SKILL_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));
    await screen.findByTestId("viewer-deleted-pane");

    fireEvent.click(screen.getByTestId("viewer-deleted-restore"));

    expect(screen.queryByTestId("viewer-deleted-pane")).toBeNull();
    expect(await screen.findByTestId("editor-probe")).toBeInTheDocument();
    expect(screen.queryByTestId("changes-count")).toBeNull();
  });
});

describe("<ContextView> — generic folder delete row action", () => {
  it("a tree row's Delete-folder action opens the same staging dialog as the editor overflow", async () => {
    seedContextApi({
      ...TREE,
      entries: [...TREE.entries, { path: ".outerlayer/docs/notes.md", kind: "reference", scopePath: "", blobSha: "b9" }],
    });
    renderView();
    await screen.findByTestId("delete-folder-.outerlayer/docs");

    fireEvent.click(screen.getByTestId("delete-folder-.outerlayer/docs"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));

    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 deleted");
  });

  it("a delete-only role (no insert) still gets the folder-delete row action", async () => {
    hasPermissionMock = (perm) => perm !== Permissions.CONTEXT_INSERT;
    seedContextApi({
      ...TREE,
      entries: [...TREE.entries, { path: ".outerlayer/docs/notes.md", kind: "reference", scopePath: "", blobSha: "b9" }],
    });
    renderView();

    expect(await screen.findByTestId("delete-folder-.outerlayer/docs")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("delete-folder-.outerlayer/docs"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));
    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 deleted");
  });

  it("an insert-only role (no delete) never gets the folder-delete row action", async () => {
    hasPermissionMock = (perm) => perm !== Permissions.CONTEXT_DELETE;
    seedContextApi({
      ...TREE,
      entries: [...TREE.entries, { path: ".outerlayer/docs/notes.md", kind: "reference", scopePath: "", blobSha: "b9" }],
    });
    renderView();
    await screen.findByPlaceholderText("Filter files");

    expect(screen.queryByTestId("delete-folder-.outerlayer/docs")).toBeNull();
  });
});

describe("<ContextView> — discard-dot gating for a delete-only role", () => {
  it("a delete-only role (no publish) still gets a working restore dot on a staged delete", async () => {
    hasPermissionMock = (perm) => perm === Permissions.CONTEXT_DELETE;
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    fireEvent.click(await screen.findByTestId("probe-delete"));
    fireEvent.click(screen.getByTestId("probe-stage-delete"));
    expect(screen.getByTestId("changes-count")).toHaveTextContent("1 deleted");
    // No publish permission — the read-only footer variant renders while dirty.
    expect(screen.getByTestId("tree-draft-footer-readonly")).toBeInTheDocument();

    // Gating this on canPublish alone would leave the dot a plain,
    // non-interactive mark (no "-trigger" testid) for a delete-only role.
    fireEvent.click(screen.getByTestId("tree-deleted-dot-trigger"));
    fireEvent.click(screen.getByTestId("tree-deleted-dot-action"));

    expect(screen.queryByTestId("tree-draft-footer-readonly")).toBeNull();
  });
});

describe("<ContextView> — empty tree keeps the create path reachable", () => {
  it("renders the two-pane shell with the no-context copy in the editor pane", async () => {
    seedContextApi({ ...TREE, entries: [] });
    renderView();
    expect(await screen.findByPlaceholderText("Filter files")).toBeInTheDocument();
    expect(screen.getByTestId("context-new-file")).toBeInTheDocument();
    // The empty-state copy sits in the editor pane, not as a full-page takeover.
    expect(screen.getByText("No context yet")).toBeInTheDocument();
  });

  it("renders a freshly created draft in the tree even with an empty mirror", async () => {
    seedContextApi({ ...TREE, entries: [] });
    renderView();
    await screen.findByPlaceholderText("Filter files");
    createDraftViaUi(NEW_CMD);

    expect(await screen.findByText("new-cmd.md")).toBeInTheDocument();
    expect(screen.getByTestId("tree-new-dot")).toBeInTheDocument();
  });
});

describe("<ContextView> — read-only publish gating", () => {
  it("gives read-only users the plain footer line and no publish affordance", async () => {
    hasPermissionMock = () => false;
    seedContextApi(TREE, [AGENTS_FILE]);
    setSelectedFile(AGENTS_FILE.path);
    renderView();
    await screen.findByTestId("editor-probe");
    // The probe emits a change regardless of read-only, so a draft can exist.
    fireEvent.click(screen.getByTestId("probe-edit"));

    // The footer shows the summary but as a plain line, never the clickable button.
    expect(screen.getByTestId("tree-draft-footer-readonly")).toBeInTheDocument();
    expect(screen.queryByTestId("tree-draft-footer")).toBeNull();

    // The editor's publish handler is unwired, so nothing opens the dialog.
    fireEvent.click(screen.getByTestId("probe-publish"));
    expect(screen.queryByTestId("publish-dialog-probe")).toBeNull();
  });
});

describe("<ContextView> — the Files view carries no usage UI", () => {
  it("a legacy skill-dir deep link renders the select-a-file placeholder, never fetching the dir as a file", async () => {
    seedContextApi(TREE, []);
    setSelectedFile(".outerlayer/skills/deploy");
    renderView();

    expect(await screen.findByText("Select a file to view its contents.")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-probe")).toBeNull();
    // The dir selection must not be treated as a file read.
    expect(vi.mocked(getContextFile)).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: ".outerlayer/skills/deploy" }),
    );
  });

  // AC-058-13
  it("a skill's SKILL.md renders the bare editor — no Usage tab, no usage figures anywhere", async () => {
    seedContextApi(TREE, [SKILL_FILE]);
    setSelectedFile(SKILL_FILE.path);
    renderView();

    expect(await screen.findByTestId("editor-probe")).toHaveAttribute("data-path", SKILL_FILE.path);
    // The old detail-pane tab chrome is gone for good…
    expect(screen.queryByTestId("skill-tab-usage")).toBeNull();
    expect(screen.queryByTestId("skill-detail-pane")).toBeNull();
    // …and no usage strip or figures replaced it: Files is a pure explorer,
    // usage lives in the Overview.
    expect(screen.queryByTestId("context-usage-strip")).toBeNull();
    expect(screen.queryByText(/activations/)).toBeNull();
  });

  it("an mcp.json renders the bare editor with only the inventory server count in the tree", async () => {
    const MCP_PATH = ".outerlayer/mcp.json";
    const mcpTree: ContextTreeResponse = {
      ...TREE,
      entries: [...TREE.entries, { path: MCP_PATH, kind: "mcp", scopePath: "", blobSha: "m1" }],
      mcpServerCounts: [{ path: MCP_PATH, count: 1, servers: ["alpha"] }],
    };
    seedContextApi(mcpTree, [
      {
        path: MCP_PATH,
        kind: "mcp",
        blobSha: "m1",
        commitSha: "head-sha",
        content: "{}",
        oversize: false,
        frontmatter: { parsed: null, issues: [] },
      },
    ]);
    setSelectedFile(MCP_PATH);
    renderView();

    expect(await screen.findByTestId("editor-probe")).toHaveAttribute("data-path", MCP_PATH);
    expect(screen.queryByTestId("mcp-detail-tabs")).toBeNull();
    expect(screen.queryByTestId("context-usage-strip")).toBeNull();
    // The tree keeps the INVENTORY annotation (installed count) — that is
    // repo fact, not usage — while no last-used/never usage marks exist.
    expect(screen.getByText(/·\s*1 server/)).toBeInTheDocument();
    expect(screen.queryByTestId("tree-last-used")).toBeNull();
    expect(screen.queryByTestId("tree-last-used-never")).toBeNull();
  });
});
