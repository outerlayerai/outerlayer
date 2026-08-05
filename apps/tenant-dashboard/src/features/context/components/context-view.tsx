"use client";

/**
 * Context tab: the always-on editor is the file's rendered view, with the rich
 * (Milkdown) surface wired in as the default for markdown kinds. Two-pane
 * shell: a 300px literal file-tree pane (Paper, own scroll) and a flex
 * viewer/editor pane. Below the `md` breakpoint the tree collapses into a
 * Drawer toggled from the header. The selected path lives in the URL
 * (`?file=`) so links are shareable. Picks exactly one empty state from the
 * tree response before showing the panes.
 *
 * Edits across files accumulate in a page-lifetime draft buffer instead of
 * saving one at a time: switching files never loses a buffer, and a persistent
 * changes bar commits every draft as ONE commit through the review dialog. A
 * direct-commit save shows a syncing strip until the mirror catches up; a PR
 * save marks the committed files with a pending-PR chip.
 *
 * App-level surface (no env segment) — context hangs off the repo, not an env.
 * Edit/Delete affordances are permission-hidden.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import LinearProgress from "@mui/material/LinearProgress";
import MuiLink from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { alpha, useTheme } from "@mui/material/styles";
import { Translation, useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import { appPaths } from "@/routes/paths";
import { DEFAULT_ENV_NAME } from "@/context/env-context";
import { useAppPermissions } from "@/lib/adapters/use-app-permissions";
import { Permissions } from "@/utils/permissions";
import { useSnackbar } from "@/components/snackbar";
import { classifyTree, type FieldIssue } from "@repo/context-core";
import {
  useContextFile,
  useContextTree,
  useContextSkillAdoption,
  useContextMcpAdoption,
} from "../hooks";
import { indexSkillActivations } from "./context-skill-adoption";
import { indexMcpUsage } from "./context-mcp-adoption";
import { SkillDetailPane } from "./context-skill-usage-pane";
import { McpDetailTabs } from "./context-mcp-usage-pane";
import { useContextDrafts, type ContextDraft, type ContextDraftChangeType } from "./use-context-drafts";
import ContextTree from "./context-tree";
import { OversizeNotice } from "./file-blocks";
import { ContextHistory } from "./history/context-history";
import { NeverSyncedState, NoContextFoundState, NoGitConnectionState } from "./context-empty-states";
import { providerFileUrl } from "./provider-file-url";
import { ContextEditor, PublishDialog, CreateFilePopover, DeleteContextDialog, useUnsavedChangesGuard } from "./editor";
import type { ContextFileHandle, CreateFileTarget, DeleteTarget, StagedDeleteTarget } from "./editor";
import { buildFolderKeepPath, staleFolderKeepDrafts, type DirDeleteAffordance } from "./context-create";
import type { ContextBatchFileConflict, ContextSaveResult } from "@/lib/adapters/context-save";
import {
  commitContextChangesAction,
  readRemoteContextFileAction,
  checkPendingPullRequestsAction,
  resyncContextAction,
} from "../action-adapters";
import { landingMessage } from "./landing-message";
import type {
  ContextFileResponse,
  ContextTreeResponse,
  McpAdoptionResponse,
  SkillAdoptionResponse,
} from "../types";

const TREE_WIDTH = 300;
// Fixed chrome around this page (no-page-scroll requirement): the 56px app
// header + the layout content wrapper's 24px top / 64px bottom padding.
const PAGE_CHROME_HEIGHT = 144;
// After a direct commit, revalidate the mirror head for this long before falling
// back to a "syncing is taking a while" banner (a webhook may still be in flight).
const SYNC_CONFIRM_TIMEOUT_MS = 15000;

/** The skill directory name for a `.../skills/<name>/…` path (frontmatter `name` must equal it). */
function skillDirNameOf(path: string): string | undefined {
  const segs = path.split("/");
  const idx = segs.lastIndexOf("skills");
  return idx >= 0 && idx + 1 < segs.length ? segs[idx + 1] : undefined;
}

/** `.../skills/<name>` — the directory a whole-skill delete targets. */
function skillDirOf(path: string): string | undefined {
  const segs = path.split("/");
  const idx = segs.lastIndexOf("skills");
  return idx >= 0 && idx + 1 < segs.length ? segs.slice(0, idx + 2).join("/") : undefined;
}

/** Filename stem (no `.md`) — the subagent `name` must equal it. */
function fileStemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/** Builds the editor's file handle from a loaded, non-oversize file response. */
function toFileHandle(file: ContextFileResponse): ContextFileHandle | null {
  if (file.content === null) return null;
  const isSkill = file.kind === "skill" || file.kind === "skill-reference";
  return {
    path: file.path,
    kind: file.kind,
    content: file.content,
    baseBlobSha: file.blobSha,
    baseCommitSha: file.commitSha,
    ...(isSkill ? { skillDirName: skillDirNameOf(file.path) } : {}),
    ...(file.kind === "subagent" ? { fileStem: fileStemOf(file.path) } : {}),
  };
}

/**
 * Editor handle for a `create` draft — the file has no server row yet, so the
 * kind is derived by classifying the path. `content` seeds from the draft;
 * `baseBlobSha` is empty (nothing to base against — a create).
 */
function draftToFileHandle(draft: ContextDraft): ContextFileHandle | null {
  const entry = classifyTree([draft.path]).entries[0];
  if (!entry) return null;
  const isSkill = entry.kind === "skill" || entry.kind === "skill-reference";
  return {
    path: draft.path,
    kind: entry.kind,
    content: draft.content,
    baseBlobSha: "",
    baseCommitSha: "",
    ...(isSkill ? { skillDirName: skillDirNameOf(draft.path) } : {}),
    ...(entry.kind === "subagent" ? { fileStem: fileStemOf(draft.path) } : {}),
  };
}

/**
 * A whole-skill delete when viewing its SKILL.md (kind `skill`), otherwise a
 * single-file delete. The skill target names only the directory — the delete
 * dialog enumerates its files itself and stages each against a freshly-read
 * blob sha, so no per-file sha needs pinning here.
 */
function buildDeleteTarget(file: ContextFileResponse): DeleteTarget {
  if (file.kind === "skill") {
    const dir = skillDirOf(file.path);
    if (dir) return { kind: "skill", skillDir: dir };
  }
  return { kind: "file", path: file.path, baseBlobSha: file.blobSha, content: file.content ?? "" };
}

/** Server-resolved seed for the context surface (React Server Component (RSC) → client subsystem). */
interface ContextViewProps {
  appId: string;
  initialTree: ContextTreeResponse;
  /** The `?file=`-selected file at first render, or `null` when none/stale. */
  initialFile: ContextFileResponse | null;
  initialSkillAdoption: SkillAdoptionResponse;
  initialMcpAdoption: McpAdoptionResponse;
  /** The `?file=` value the RSC seeded `initialFile` for. */
  initialSelectedPath: string | null;
}

export function ContextView({
  appId,
  initialTree,
  initialFile,
  initialSkillAdoption,
  initialMcpAdoption,
  initialSelectedPath,
}: ContextViewProps) {
  const { t } = useTranslate();
  const { orgName, appName } = useParams<{ orgName: string; appName: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const theme = useTheme();
  const isCompact = useMediaQuery(theme.breakpoints.down("md"));
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [staleBanner, setStaleBanner] = useState(false);
  // Non-null opens the delete confirmation dialog — set from either the editor
  // overflow (the selected file) or a directory row's "Delete folder" action.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [pendingPrByPath, setPendingPrByPath] = useState<
    Record<string, { number: number; url: string }>
  >({});
  // Paths a landed delete removed but the mirror may still list (webhook lag).
  // Hidden from the tree and treated as gone by the editor until the head drops
  // them, so the deleted file never lingers as a clickable, viewable row.
  const [deletedPaths, setDeletedPaths] = useState<ReadonlySet<string>>(() => new Set());

  // Multi-file draft buffer, held for the page's lifetime (ephemeral — a full
  // reload / tab close drops it, guarded by the beforeunload prompt). Route-away
  // and the Files|History toggle are guarded off `drafts.size` (tree
  // file-switch is not — the in-memory buffer persists across a switch).
  const drafts = useContextDrafts();
  // Stable per-map-identity array for the publish dialog — a fresh array
  // literal every render would defeat the dialog's own `rows` memoization
  // (full-content diff + validation per draft) even when nothing changed.
  const draftsList = useMemo(() => [...drafts.drafts.values()], [drafts.drafts]);
  // A discard snackbar's Undo closure is created once, at discard time, and
  // notistack holds onto it for as long as the snackbar is visible — it can't
  // see a LATER render's fresh `drafts` object. This ref is reassigned every
  // render so the closure can read the CURRENT draft map instead of the one
  // frozen at discard time (needed to detect a same-path re-edit in between).
  const draftsRef = useRef(drafts.drafts);
  draftsRef.current = drafts.drafts;
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardAllOpen, setDiscardAllOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [commitConflicts, setCommitConflicts] = useState<Record<string, ContextBatchFileConflict>>({});
  // Per-path server validation errors from the last publish attempt.
  const [fileErrors, setFileErrors] = useState<Array<{ path: string; errors: FieldIssue[] }>>([]);
  // Per-path message when a conflict-row Refresh couldn't read the remote.
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
  const [commitError, setCommitError] = useState<string | null>(null);
  const [refreshingPath, setRefreshingPath] = useState<string | null>(null);
  const [createAnchor, setCreateAnchor] = useState<HTMLElement | null>(null);
  // Row-action pre-target for the create popover; null = the global `+` menu.
  const [createTarget, setCreateTarget] = useState<CreateFileTarget | null>(null);

  const { hasPermission } = useAppPermissions(appId);
  const canEdit = hasPermission(Permissions.CONTEXT_UPDATE);
  const canInsert = hasPermission(Permissions.CONTEXT_INSERT);
  const canDelete = hasPermission(Permissions.CONTEXT_DELETE);
  // Any publish affordance (header button, clickable footer) needs one of these.
  const canPublish = canEdit || canInsert;

  const selectedPath = searchParams.get("file");
  const view: "files" | "history" = searchParams.get("view") === "history" ? "history" : "files";

  // A `create` draft has no server file — the editor opens on the draft itself.
  const activeDraft = selectedPath ? drafts.drafts.get(selectedPath) : undefined;
  const isCreateDraft = activeDraft?.changeType === "create";
  // A `delete` draft swaps the editor for a restore pane — its base content is
  // already captured on the draft, so nothing needs re-fetching to show it.
  const isDeleteDraft = activeDraft?.changeType === "delete";

  const dirty = drafts.drafts.size > 0;
  const onBlockedNavigation = useCallback((proceed: () => void) => {
    // Wrap in a getter so React doesn't call the continuation as a state updater.
    setPendingNav(() => proceed);
  }, []);
  // Route-away via a real anchor while drafts exist → the discard confirm.
  useUnsavedChangesGuard({ when: dirty, onBlockedNavigation });

  /** Run `nav` immediately, or park it behind the discard confirm when drafts exist. */
  const guardNav = useCallback(
    (nav: () => void) => {
      if (dirty) setPendingNav(() => nav);
      else nav();
    },
    [dirty],
  );

  const setView = useCallback(
    (next: "files" | "history") => {
      guardNav(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === "history") params.set("view", "history");
        else params.delete("view");
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [guardNav, router, pathname, searchParams],
  );
  const viewSwitch = (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={view}
      onChange={(_e, next: "files" | "history" | null) => next && setView(next)}
      aria-label="context view"
      sx={{ "& .MuiToggleButton-root": { minWidth: 72 } }}
    >
      <ToggleButton value="files" aria-label="files">
        {t("dashboard.context.view.files")}
      </ToggleButton>
      <ToggleButton value="history" aria-label="history">
        {t("dashboard.context.view.history")}
      </ToggleButton>
    </ToggleButtonGroup>
  );

  const { data: tree, error: treeError, isLoading, mutate: mutateTree } = useContextTree(appId, {
    fallbackData: initialTree,
  });
  // Session-usage overlay for the tree's skills, seeded with the tree from the
  // RSC so a slow or absent analytics backend never blocks first paint.
  const { data: skillAdoption } = useContextSkillAdoption(appId, {
    fallbackData: initialSkillAdoption,
  });
  const skillActivations = useMemo(
    () => (skillAdoption ? indexSkillActivations(skillAdoption.skills) : undefined),
    [skillAdoption],
  );
  // Same non-blocking posture for the MCP-server usage overlay, also seeded
  // with the tree from the RSC.
  const { data: mcpAdoption } = useContextMcpAdoption(appId, {
    fallbackData: initialMcpAdoption,
  });
  const mcpUsage = useMemo(
    () => (mcpAdoption ? indexMcpUsage(mcpAdoption.servers) : undefined),
    [mcpAdoption],
  );
  // Skill dirs are selectable tree rows: map each skill's dir path to its
  // name so a dir selection renders the skill's Files/Usage detail pane
  // instead of attempting a file fetch on a directory path.
  const skillDirByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of tree?.entries ?? []) {
      if (entry.skillName === undefined) continue;
      const scopeDir = entry.scopePath === "" ? ".outerlayer" : `${entry.scopePath}/.outerlayer`;
      if (entry.path.startsWith(`${scopeDir}/skills/`)) {
        map.set(`${scopeDir}/skills/${entry.skillName}`, entry.skillName);
      }
    }
    return map;
  }, [tree]);
  const selectedSkillName = selectedPath ? skillDirByPath.get(selectedPath) : undefined;
  const skillFiles = useMemo(() => {
    if (selectedSkillName === undefined || selectedPath === null) return [];
    return (tree?.entries ?? [])
      .filter((entry) => entry.kind !== "folder" && entry.path.startsWith(`${selectedPath}/`))
      .map((entry) => ({ path: entry.path, name: entry.path.slice(selectedPath.length + 1) }));
  }, [tree, selectedPath, selectedSkillName]);
  const {
    data: file,
    error: fileError,
    isLoading: fileLoading,
    mutate: mutateFile,
  } = useContextFile(
    appId,
    // No file read until the tree can classify the selection — a skill DIR
    // path must never be fetched as a file (the pane is behind the tree's
    // loading skeleton regardless, so this defers nothing visible).
    isCreateDraft || isDeleteDraft || tree === undefined || selectedSkillName !== undefined ? null : selectedPath,
    {
      // Seed only the path the RSC rendered for; a switched-to file has no seed
      // and loads through the read action.
      fallbackData:
        !isCreateDraft && selectedPath === initialSelectedPath
          ? (initialFile ?? undefined)
          : undefined,
    },
  );

  // File switching doesn't prompt: the buffer persists in the store.
  const selectFile = useCallback(
    (path: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("file", path);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      setDrawerOpen(false);
      setSyncing(false);
      setStaleBanner(false);
    },
    [router, pathname, searchParams],
  );

  /** Drops `?file=` so the selection never points at a discarded (404) create path. */
  const clearSelectedFile = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("file");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams]);

  // Operation-agnostic landing catch-up shared by publish and delete: a PR
  // landing pins a pending-PR chip on every affected path; a direct commit polls
  // the mirror head until it advances (then a stale banner), so the tree reflects
  // the change without a manual resync.
  const applyCommitOutcome = useCallback(
    async (result: ContextSaveResult, committedPaths: string[]) => {
      if (result.landed === "pull_request") {
        // No sync expectation — the merge happens later. Mark every affected
        // file so it carries a "pending PR #n" chip until the mirror reflects it.
        setPendingPrByPath((m) => {
          const next = { ...m };
          for (const path of committedPaths) {
            next[path] = { number: result.pullRequestNumber, url: result.pullRequestUrl };
          }
          return next;
        });
        return;
      }
      // Direct commit: nudge the mirror then revalidate until head reflects the
      // new commit; timeout → banner.
      setSyncing(true);
      setStaleBanner(false);
      const target = result.commitSha;
      await resyncContextAction(appId).catch(() => {});
      const deadline = Date.now() + SYNC_CONFIRM_TIMEOUT_MS;
      let advanced = false;
      while (Date.now() < deadline) {
        const fresh = await mutateTree();
        if (fresh?.head?.commitSha === target) {
          advanced = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      await mutateFile();
      setSyncing(false);
      if (!advanced) setStaleBanner(true);
    },
    [appId, mutateTree, mutateFile],
  );

  const handlePublish = useCallback(
    async (message: string, paths: string[]) => {
      // Unchecked rows stay drafts — only the checked subset publishes.
      const staged = [...drafts.drafts.values()].filter((d) => paths.includes(d.path));
      if (staged.length === 0) return;
      setPublishing(true);
      setCommitError(null);
      setFileErrors([]);
      let response: Awaited<ReturnType<typeof commitContextChangesAction>>;
      try {
        response = await commitContextChangesAction(appId, {
          message,
          files: staged.map((d) => ({
            path: d.path,
            content: d.content,
            baseBlobSha: d.baseBlobSha,
            ...(d.changeType === "delete" ? { delete: true as const } : {}),
          })),
        });
      } catch (err) {
        // A non-flight response (e.g. a gateway timeout returning HTML) makes
        // the action invocation itself reject rather than resolve to
        // `{ error }` — without this, `publishing` would stay stuck true and
        // the rejection would surface only as an unhandled promise rejection.
        console.error("[context] publish action failed:", err);
        setCommitError(t("dashboard.context.view.errorUnknown"));
        return;
      } finally {
        setPublishing(false);
      }

      if (response.error || !response.data) {
        setCommitError(response.error ?? t("dashboard.context.view.errorUnknown"));
        return;
      }
      const outcome = response.data;
      switch (outcome.status) {
        case "saved": {
          setCommitConflicts({});
          setFileErrors([]);
          setCommitError(null);
          setPublishOpen(false);
          const deleted = staged.filter((d) => d.changeType === "delete").map((d) => d.path);
          // Hide the deleted rows from the tree up front — the mirror lags the
          // commit, and the sync below fires server actions whose implicit route
          // refresh can clobber a bare `router.replace`, so this client-side
          // state (not the URL alone) is what keeps the interim view honest. The
          // clear-selection effect reconciles `?file=` from here.
          if (deleted.length > 0) {
            setDeletedPaths((prev) => {
              const next = new Set(prev);
              for (const path of deleted) next.add(path);
              return next;
            });
          }
          drafts.dropDrafts(staged.map((d) => d.path));
          // Names where the publish landed — a protected-branch PR fallback
          // (which happens even when policy allows direct) is never silent.
          {
            const landing = landingMessage(outcome.result);
            enqueueSnackbar(t(landing.key, landing.params), { variant: "success" });
          }
          await applyCommitOutcome(outcome.result, staged.map((d) => d.path));
          break;
        }
        case "conflict":
          setCommitConflicts(Object.fromEntries(outcome.conflicts.map((c) => [c.path, c])));
          break;
        case "validation_error":
          setCommitError(t("dashboard.context.view.errorValidation"));
          setFileErrors(outcome.fileErrors);
          break;
        case "not_connected":
          setCommitError(t("dashboard.context.view.errorNotConnected"));
          break;
        case "git_error":
          setCommitError(outcome.message);
          break;
      }
    },
    [appId, drafts, applyCommitOutcome, enqueueSnackbar, t],
  );

  // Per-row conflict recovery: adopt the remote's current base for this path
  // (keeping the user's buffered content), which clears the conflict. A read
  // failure surfaces a per-row error rather than corrupting the draft; a remote
  // that no longer has the file becomes a `deleted` conflict (the row's
  // Keep-as-new / discard affordances take over) instead of a null-base edit.
  const onRefreshDraft = useCallback(
    async (path: string) => {
      setRefreshingPath(path);
      const setRefreshError = (message: string) =>
        setRefreshErrors((prev) => ({ ...prev, [path]: message }));
      const clearRefreshError = () =>
        setRefreshErrors((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
      try {
        const res = await readRemoteContextFileAction(appId, path);
        if (!res || res.error || !res.data) {
          setRefreshError(t("dashboard.context.view.errorRefreshRemote"));
          return;
        }
        if (res.data.content === null) {
          // Deleted at head — surface the deleted conflict; leave the draft base.
          setCommitConflicts((prev) => ({ ...prev, [path]: { path, remoteSha: null, reason: "deleted" } }));
          clearRefreshError();
          return;
        }
        const draft = drafts.drafts.get(path);
        if (draft) {
          if (draft.changeType === "edit" && res.data.content === draft.content) {
            // The remote caught up to the buffer — nothing left to publish.
            drafts.dropDraft(path);
          } else {
            drafts.setDraft({
              ...draft,
              baseBlobSha: res.data.blobSha,
              baseContent: res.data.content,
            });
          }
        }
        setCommitConflicts((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
        clearRefreshError();
      } catch {
        setRefreshError(t("dashboard.context.view.errorRefreshRemote"));
      } finally {
        setRefreshingPath(null);
      }
    },
    [appId, drafts, t],
  );

  const onDiscardDraft = useCallback(
    (path: string) => {
      const draft = drafts.drafts.get(path);
      drafts.dropDraft(path);
      setCommitConflicts((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      setRefreshErrors((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      // A discarded create leaves no server file — drop the selection so it
      // doesn't point at a 404 path.
      if (path === selectedPath && draft?.changeType === "create") clearSelectedFile();
    },
    [drafts, selectedPath, clearSelectedFile],
  );

  // The tree's change-dot popover reuses this exact per-path discard path
  // (never a second one), so its side effects — clearing conflicts/refresh
  // errors, releasing a stale selection — match a PublishDialog discard
  // exactly. Undo accompanies any single-path discard — whether it came from
  // a file's own dot or a directory dot whose subtree holds exactly one
  // edit/create draft — since the draft object is still in memory at that
  // point; a multi-path bulk discard already went through the tree's own
  // confirm dialog, so no further undo is offered.
  const onDiscardDrafts = useCallback(
    (paths: string[]) => {
      const single = paths.length === 1 ? drafts.drafts.get(paths[0]!) : undefined;
      for (const path of paths) onDiscardDraft(path);
      if (single && single.changeType !== "delete") {
        const messageKey =
          single.changeType === "create"
            ? "dashboard.context.tree.discardedCreateMessage"
            : "dashboard.context.tree.discardedEditMessage";
        enqueueSnackbar(t(messageKey), {
          action: (key) => (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                // The snackbar can outlive a fresh edit on the same path (the
                // user re-opens the file and types before clicking Undo) — in
                // that case restoring the captured draft would clobber the
                // newer buffer, so Undo only re-adds it while the path is
                // still clean.
                if (!draftsRef.current.has(single.path)) drafts.setDraft(single);
                closeSnackbar(key);
              }}
            >
              {t("dashboard.context.tree.undo")}
            </Button>
          ),
        });
      }
    },
    [drafts, onDiscardDraft, enqueueSnackbar, closeSnackbar, t],
  );

  // "Keep as new file" on a deleted-remote conflict: the file no longer exists
  // at head, so re-commit the buffered content as a fresh create (no base).
  const onRestoreAsNew = useCallback(
    (path: string) => {
      const draft = drafts.drafts.get(path);
      if (draft) {
        drafts.setDraft({ ...draft, changeType: "create", baseBlobSha: null, baseContent: "" });
      }
      setCommitConflicts((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    },
    [drafts],
  );

  const discardAll = useCallback(() => {
    // Clearing every draft drops the selected create's file too — release the
    // selection so it doesn't point at a 404 path.
    const selectedWasCreate = isCreateDraft;
    drafts.clearDrafts();
    setCommitConflicts({});
    setFileErrors([]);
    setRefreshErrors({});
    setCommitError(null);
    setDiscardAllOpen(false);
    setPublishOpen(false);
    if (selectedWasCreate) clearSelectedFile();
  }, [drafts, isCreateDraft, clearSelectedFile]);

  const fileHandle = isCreateDraft && activeDraft
    ? draftToFileHandle(activeDraft)
    : file
      ? toFileHandle(file)
      : null;
  const editorContent = activeDraft?.content ?? fileHandle?.content ?? "";

  const onContentChange = useCallback(
    (next: string) => {
      if (!fileHandle) return;
      const path = fileHandle.path;
      const existing = drafts.drafts.get(path);
      const changeType: ContextDraftChangeType = existing?.changeType ?? "edit";
      // Reverting an edit back to the loaded bytes drops the draft; a create
      // draft is never dropped on content match (the file still needs creating).
      if (changeType === "edit" && next === fileHandle.content) {
        drafts.dropDraft(path);
      } else {
        drafts.setDraft({
          // A create draft keeps its null base; an edit pins the loaded sha
          // and bytes (the publish dialog diffs against them).
          path,
          content: next,
          baseBlobSha: existing ? existing.baseBlobSha : fileHandle.baseBlobSha,
          baseContent: existing ? existing.baseContent : fileHandle.content,
          changeType,
        });
      }
    },
    [fileHandle, drafts],
  );

  // A restored edit draft whose content already equals the mirrored file is
  // clean — drop it. The live editor drops reverts as they happen; this covers
  // a draft restored from storage against a mirror that has since caught up.
  // A draft whose base blob sha drifted stays (surfaced as a publish conflict).
  useEffect(() => {
    if (!file || file.content === null) return;
    const draft = drafts.drafts.get(file.path);
    if (draft && draft.changeType === "edit" && draft.content === file.content) {
      drafts.dropDraft(file.path);
    }
  }, [file, drafts]);

  const handleCreateFile = useCallback(
    ({ path, content }: { path: string; content: string }) => {
      drafts.setDraft({ path, content, baseBlobSha: null, baseContent: "", changeType: "create" });
      setCreateAnchor(null);
      setCreateTarget(null);
      const params = new URLSearchParams(searchParams.toString());
      params.set("file", path);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      setDrawerOpen(false);
    },
    [drafts, router, pathname, searchParams],
  );

  // A directory row's "New file" opens the create popover pre-targeted at that
  // location, anchored to the clicked action.
  const handleNewFile = useCallback((target: CreateFileTarget, anchor: HTMLElement) => {
    setCreateTarget(target);
    setCreateAnchor(anchor);
  }, []);

  // A directory row's "New folder" stages a `.gitkeep` create draft — a real
  // file that rides the existing draft → publish → discard machinery. The tree
  // reconstructs the (empty) folder from the draft path; it's never selectable.
  const handleNewFolder = useCallback(
    (baseDir: string, name: string) => {
      const path = buildFolderKeepPath(baseDir, name);
      drafts.setDraft({ path, content: "", baseBlobSha: null, baseContent: "", changeType: "create" });
    },
    [drafts],
  );

  // The delete dialog only STAGES — it never commits, so this just upserts a
  // `delete` draft per target path. The batch publish (handlePublish) is what
  // actually removes the paths, at which point they join `deletedPaths`.
  const handleStageDelete = useCallback(
    (targets: StagedDeleteTarget[]) => {
      drafts.stageDeletes(targets);
    },
    [drafts],
  );

  // A tree row's "Delete folder" action — the affordance is already shaped
  // like a DeleteTarget (skill-flavored copy for a skill's own root, generic
  // folder copy otherwise), so it opens the same dialog directly.
  const handleDeleteFolder = useCallback((target: DirDeleteAffordance) => {
    setDeleteTarget(target);
  }, []);

  // Release `?file=` whenever it points at a just-deleted path. Done in an effect
  // so it re-fires if a racing route refresh re-commits the stale URL — it
  // converges to a cleared selection either way.
  useEffect(() => {
    if (selectedPath !== null && deletedPaths.has(selectedPath)) clearSelectedFile();
  }, [selectedPath, deletedPaths, clearSelectedFile]);

  // Stop hiding a deleted path once the mirror head no longer lists it: the tree
  // won't render it anyway, and holding it would suppress a same-path re-create.
  useEffect(() => {
    if (deletedPaths.size === 0 || !tree) return;
    const present = new Set(tree.entries.map((e) => e.path));
    const stillMirrored = [...deletedPaths].filter((path) => present.has(path));
    if (stillMirrored.length !== deletedPaths.size) setDeletedPaths(new Set(stillMirrored));
  }, [tree, deletedPaths]);

  // Drop a path's "pending PR" tag once its PR has decided (merged or closed).
  // Checked against the `pull_request` table (kept live by the GitHub
  // webhooks, healed by `backfillPullRequests` on every resync) — NOT the
  // mirror's head advancing, which isn't a safe signal on its own: an
  // unrelated commit can advance head while this specific PR is still open.
  const reconcilePendingPrs = useCallback(
    async (numbers: number[]) => {
      if (numbers.length === 0) return;
      const res = await checkPendingPullRequestsAction(appId, numbers).catch(() => null);
      if (!res || res.error || !res.data || res.data.decided.length === 0) return;
      const decided = new Set(res.data.decided);
      setPendingPrByPath((prev) => {
        const next: typeof prev = {};
        let changed = false;
        for (const [path, pr] of Object.entries(prev)) {
          if (decided.has(pr.number)) {
            changed = true;
          } else {
            next[path] = pr;
          }
        }
        return changed ? next : prev;
      });
    },
    [appId],
  );

  // Passive trigger: a background tree revalidation (or a newly-staged
  // pending PR) re-checks every still-pending PR. SWR only hands back a new
  // `tree` reference when the fetched content actually differs, so this alone
  // would never fire on a resync that finds nothing new (still open) —
  // `runResync` below covers that case explicitly.
  useEffect(() => {
    if (!tree) return;
    const numbers = [...new Set(Object.values(pendingPrByPath).map((pr) => pr.number))];
    void reconcilePendingPrs(numbers);
  }, [tree, pendingPrByPath, reconcilePendingPrs]);

  // Drop a staged folder `.gitkeep` once the directory it would materialize
  // already exists in the server tree (a child file was published first) — else
  // publishing it later commits a stray `.gitkeep` into a non-empty dir.
  useEffect(() => {
    if (!tree) return;
    const present = new Set(tree.entries.map((e) => e.path));
    const folderKeeps = [...drafts.drafts.values()]
      .filter((d) => d.changeType === "create")
      .map((d) => d.path);
    for (const path of staleFolderKeepDrafts(folderKeeps, present)) drafts.dropDraft(path);
  }, [tree, drafts]);

  const runResync = useCallback(async () => {
    setStaleBanner(false);
    setSyncing(true);
    await resyncContextAction(appId).catch(() => {});
    await mutateTree();
    await mutateFile();
    setSyncing(false);
    // Explicit trigger: a resync ALWAYS re-checks every pending PR, even when
    // the tree body comes back unchanged (still open) — the passive effect
    // above only fires on an actual content change.
    const numbers = [...new Set(Object.values(pendingPrByPath).map((pr) => pr.number))];
    await reconcilePendingPrs(numbers);
  }, [appId, mutateTree, mutateFile, pendingPrByPath, reconcilePendingPrs]);

  const draftChangeTypes = useMemo(() => {
    const map = new Map<string, ContextDraftChangeType>();
    for (const [path, draft] of drafts.drafts) map.set(path, draft.changeType);
    return map;
  }, [drafts.drafts]);

  const pendingPrPaths = useMemo(() => new Set(Object.keys(pendingPrByPath)), [pendingPrByPath]);

  const headerControls = (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Tooltip title={t("dashboard.context.view.resync")}>
        <span>
          <IconButton
            size="small"
            onClick={runResync}
            loading={syncing}
            aria-label="Resync context"
          >
            <Iconify icon="mdi:sync" />
          </IconButton>
        </span>
      </Tooltip>
      {viewSwitch}
    </Stack>
  );

  const connectHref = appPaths.developers.general(orgName, appName, DEFAULT_ENV_NAME);

  const leaveConfirm = (
    <Dialog
      open={pendingNav !== null}
      onClose={() => setPendingNav(null)}
      data-testid="view-leave-confirm-dialog"
    >
      <DialogTitle>{t("dashboard.context.view.leaveTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {t("dashboard.context.view.leaveBody", { count: drafts.drafts.size })}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setPendingNav(null)} data-testid="view-leave-stay">
          {t("dashboard.context.view.leaveStay")}
        </Button>
        <Button
          color="error"
          variant="contained"
          data-testid="view-leave-discard"
          onClick={() => {
            const proceed = pendingNav;
            setPendingNav(null);
            drafts.clearDrafts();
            proceed?.();
          }}
        >
          {t("dashboard.context.view.leaveDiscard")}
        </Button>
      </DialogActions>
    </Dialog>
  );

  if (view === "history") {
    return (
      <PageFrame
        repository={tree?.gitConnection?.repository}
        branch={tree?.gitConnection?.branch}
        headerActions={headerControls}
      >
        <ContextHistory appId={appId} />
        {leaveConfirm}
      </PageFrame>
    );
  }

  if (isLoading) {
    return (
      <PageFrame headerActions={headerControls}>
        {/* The real header renders above, so the skeleton reserves only the body. */}
        <PageSkeleton variant="two-pane" header={false} />
      </PageFrame>
    );
  }

  if (treeError || !tree) {
    return (
      <PageFrame headerActions={headerControls}>
        <CenteredPane>
          <ErrorState
            title={t("dashboard.context.view.loadErrorTitle")}
            description={t("dashboard.context.view.loadError")}
            onRetry={() => void mutateTree()}
          />
        </CenteredPane>
      </PageFrame>
    );
  }

  if (!tree.gitConnection) {
    return (
      <PageFrame headerActions={headerControls}>
        <CenteredPane>
          <NoGitConnectionState connectHref={connectHref} />
        </CenteredPane>
      </PageFrame>
    );
  }
  if (!tree.head) {
    return (
      <PageFrame headerActions={headerControls}>
        <CenteredPane>
          <NeverSyncedState onResync={runResync} resyncing={syncing} />
        </CenteredPane>
      </PageFrame>
    );
  }

  // An empty tree still shows the two-pane shell so the first file can be
  // created (and any in-progress create drafts stay reachable in the tree); the
  // editor pane carries the "no context yet" copy instead of a full-page state.
  const isEmptyTree = tree.entries.length === 0;

  const pendingPr = selectedPath ? (pendingPrByPath[selectedPath] ?? null) : null;
  // A just-deleted selection is treated as no selection so the pane never shows
  // the removed file (mirror lag can still 200 its content) before `?file=` clears.
  const selectedIsDeleted = selectedPath !== null && deletedPaths.has(selectedPath);
  const fileUrl = file
    ? providerFileUrl({
        provider: tree.gitConnection.provider,
        repository: tree.gitConnection.repository,
        branch: tree.gitConnection.branch,
        path: file.path,
      })
    : undefined;

  // Create drafts are always editable; existing files honor the write gate.
  const editorReadOnly = isCreateDraft ? false : !canEdit || file?.kind === "external-instructions";

  // Delete is hidden by KIND — external-instructions is never deletable, and a
  // create draft has no server file yet. This is separate from the write gate:
  // a role with `context.delete` but not `context.update` keeps Delete on a
  // normal file (canDelete carries the user-permission gate alone).
  const deleteHidden = isCreateDraft || file?.kind === "external-instructions";

  const openPublish = () => {
    setCommitError(null);
    setPublishOpen(true);
    // Revalidate so the dialog's landing policy (requirePullRequest) and per-file
    // blob shas reflect current server state — an app whose PR policy changed
    // after page load must not show a stale landing. Don't block the open on it.
    void mutateTree();
  };

  const editorEl = fileHandle ? (
    <ContextEditor
      key={fileHandle.path}
      file={fileHandle}
      content={editorContent}
      onContentChange={onContentChange}
      readOnly={editorReadOnly}
      isCreateDraft={isCreateDraft}
      draftCount={drafts.drafts.size}
      // Read-only users (no update/insert) get no publish affordance.
      onPublish={canPublish ? openPublish : undefined}
      // Kind-hidden files (external-instructions / create drafts) offer no delete
      // — dropping both props leaves external-instructions with no overflow at all.
      onDelete={deleteHidden || !file ? undefined : () => setDeleteTarget(buildDeleteTarget(file))}
      canDelete={!deleteHidden && canDelete}
    />
  ) : null;

  // The syncing strip and pending-PR banner ride above the pane content so they
  // stay visible for the selected path even when there is no editor to show
  // (a create published as a PR 404s against the mirror, for instance). When
  // the calm pending-PR pane is the body, it speaks alone — no banner on top.
  const showsPendingPrPane =
    pendingPr !== null &&
    selectedPath !== null &&
    !isCreateDraft &&
    selectedSkillName === undefined &&
    !fileLoading &&
    (Boolean(fileError) || !file);
  // Everything file-shaped: the editor plus its loading/error/oversize states.
  const fileBody =
    selectedPath === null || selectedIsDeleted ? (
      isEmptyTree ? (
        <NoContextFoundState />
      ) : (
        <PlaceholderPane text={t("dashboard.context.view.selectFile")} />
      )
    ) : isDeleteDraft ? (
      <DeletedFilePane onRestore={() => drafts.dropDraft(selectedPath)} />
    ) : isCreateDraft ? (
      (editorEl ?? <PlaceholderPane text={t("dashboard.context.view.unrecognizedPath")} />)
    ) : fileLoading ? (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: 1 }}>
        <CircularProgress />
      </Box>
    ) : fileError || !file ? (
      // A file published as a still-open PR isn't in the mirror yet — say so
      // calmly instead of "could not be loaded".
      pendingPr ? (
        <PendingPrPane number={pendingPr.number} url={pendingPr.url} />
      ) : (
        <PlaceholderPane text={t("dashboard.context.view.fileLoadError")} />
      )
    ) : file.oversize || file.content === null || !fileHandle ? (
      <Box sx={{ p: 3 }}>
        <OversizeNotice providerFileUrl={fileUrl} />
      </Box>
    ) : (
      editorEl
    );
  // A selected skill dir swaps the file pane for the skill's Files/Usage
  // tabs; a selected mcp.json keeps the whole file pane on a Content tab and
  // adds the server Usage tab beside it. Keyed by path so the tab choice
  // resets when the selection moves.
  const selectedMcpServers =
    selectedPath !== null && !selectedIsDeleted && !isCreateDraft && file?.kind === "mcp"
      ? (tree.mcpServerCounts.find((m) => m.path === selectedPath)?.servers ?? [])
      : undefined;
  const paneBody =
    selectedSkillName !== undefined && selectedPath !== null && !selectedIsDeleted ? (
      <SkillDetailPane
        key={selectedPath}
        skillName={selectedSkillName}
        dirPath={selectedPath}
        files={skillFiles}
        activation={skillActivations?.get(selectedSkillName)}
        overlayLoaded={skillActivations !== undefined}
        recentDays={skillAdoption?.recentDays ?? 14}
        lookbackDays={skillAdoption?.lookbackDays ?? 90}
        onSelectFile={selectFile}
      />
    ) : selectedMcpServers !== undefined && selectedPath !== null ? (
      <McpDetailTabs key={selectedPath} servers={selectedMcpServers}>
        {fileBody}
      </McpDetailTabs>
    ) : (
      fileBody
    );
  const editorPane = (
    <Stack sx={{ height: 1, minHeight: 0 }}>
      {syncing && (
        <Box data-testid="viewer-syncing-strip">
          <LinearProgress />
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", px: 2, py: 0.5, display: "block" }}
          >
            {t("dashboard.context.view.syncing")}
          </Typography>
        </Box>
      )}
      {pendingPr && !showsPendingPrPane && (
        <Alert severity="success" sx={{ borderRadius: 0 }} data-testid="viewer-pr-banner">
          <Translation
            t={t}
            i18nKey="dashboard.context.view.changeSubmitted"
            values={{ number: pendingPr.number }}
            components={[
              <MuiLink key="pr" href={pendingPr.url} target="_blank" rel="noopener" />,
            ]}
          />
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{paneBody}</Box>
    </Stack>
  );

  // Distinct `.outerlayer/` scopes and every existing path (tree ∪ drafts) —
  // the create dialog's scope picker + duplicate check. The repo root is always
  // offered so the first file (empty tree) has somewhere to land.
  const scopes = [...new Set(["", ...tree.entries.map((e) => e.scopePath)])].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  );
  const existingPaths = new Set<string>([
    ...tree.entries.map((e) => e.path),
    ...drafts.drafts.keys(),
  ]);

  const editedCount = [...drafts.drafts.values()].filter((d) => d.changeType === "edit").length;
  const newCount = [...drafts.drafts.values()].filter((d) => d.changeType === "create").length;
  const deletedCount = [...drafts.drafts.values()].filter((d) => d.changeType === "delete").length;
  const draftSummary = [
    editedCount > 0 ? t("dashboard.context.view.draftEdited", { n: editedCount }) : null,
    newCount > 0 ? t("dashboard.context.view.draftNew", { n: newCount }) : null,
    deletedCount > 0 ? t("dashboard.context.view.draftDeleted", { n: deletedCount }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Unified dot vocabulary: red whenever a delete is staged (the most consequential
  // change in the batch outranks the rest), green for new outranking a pure edit,
  // orange only for a pure-edit batch. Matches the tree's draft dots.
  const footerDotColor = deletedCount > 0 ? "error.main" : newCount > 0 ? "success.main" : "warning.main";

  const treePane = (
    <Stack sx={{ width: TREE_WIDTH, height: 1, overflow: "hidden" }}>
      <Stack direction="row" spacing={1} sx={{ p: 1.5, alignItems: "center" }}>
        <TextField
          fullWidth
          size="small"
          placeholder={t("dashboard.context.view.filterPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Iconify icon="mdi:magnify" width={18} />
                </InputAdornment>
              ),
            },
          }}
        />
        {canInsert && (
          <Tooltip title={t("dashboard.context.view.newFile")}>
            <IconButton
              onClick={(e) => {
                setCreateTarget(null);
                setCreateAnchor(e.currentTarget);
              }}
              aria-label="New context file"
              data-testid="context-new-file"
              sx={(theme) => ({
                width: 40,
                height: 40,
                flexShrink: 0,
                borderRadius: 1,
                border: "1px solid",
                // Only the GLOBAL create (target === null) lights this button; a
                // row-action open shares the same popover anchor but must not.
                ...(createAnchor && createTarget === null
                  ? {
                      borderColor: "text.primary",
                      bgcolor: "text.primary",
                      color: "background.paper",
                      boxShadow: `0 0 0 3px ${alpha(theme.palette.text.primary, 0.18)}`,
                      "&:hover": { bgcolor: "text.primary" },
                    }
                  : { borderColor: "divider" }),
              })}
            >
              <Iconify icon="mdi:plus" width={20} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      <Box sx={{ overflow: "auto", flexGrow: 1, px: 0.5, pb: 1 }}>
        <ContextTree
          response={tree}
          selectedPath={selectedPath}
          onSelect={selectFile}
          query={query}
          draftChangeTypes={draftChangeTypes}
          pendingPrPaths={pendingPrPaths}
          hiddenPaths={deletedPaths}
          skillActivations={skillActivations}
          mcpUsage={mcpUsage}
          onNewFile={canInsert ? handleNewFile : undefined}
          onNewFolder={canInsert ? handleNewFolder : undefined}
          onDeleteFolder={canDelete ? handleDeleteFolder : undefined}
          // A delete-only role (canDelete without canPublish) can still stage
          // a folder delete via the row action, so it needs the discard dot
          // to restore it — not just a publish-capable role.
          onDiscardDrafts={canPublish || canDelete ? onDiscardDrafts : undefined}
        />
      </Box>
      {dirty &&
        (canPublish ? (
          <Stack
            direction="row"
            spacing={1}
            component="button"
            type="button"
            onClick={openPublish}
            data-testid="tree-draft-footer"
            sx={{
              alignItems: "center",
              px: 1.5,
              py: 1.25,
              border: 0,
              borderTop: "1px solid",
              borderTopColor: "divider",
              bgcolor: "transparent",
              cursor: "pointer",
              textAlign: "left",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: footerDotColor, flexShrink: 0 }} />
            <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-testid="changes-count">
              {draftSummary}
            </Typography>
          </Stack>
        ) : (
          // Read-only users see the draft summary but no publish affordance.
          <Stack
            direction="row"
            spacing={1}
            data-testid="tree-draft-footer-readonly"
            sx={{
              alignItems: "center",
              px: 1.5,
              py: 1.25,
              borderTop: "1px solid",
              borderTopColor: "divider",
            }}
          >
            <Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: footerDotColor, flexShrink: 0 }} />
            <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-testid="changes-count">
              {draftSummary}
            </Typography>
          </Stack>
        ))}
    </Stack>
  );

  return (
    <PageFrame
      repository={tree.gitConnection.repository}
      branch={tree.gitConnection.branch}
      onOpenTree={isCompact ? () => setDrawerOpen(true) : undefined}
      headerActions={headerControls}
    >
      {staleBanner && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          data-testid="mirror-stale-banner"
          action={
            <Button color="inherit" size="small" onClick={runResync}>
              {t("dashboard.context.view.resyncAction")}
            </Button>
          }
        >
          {t("dashboard.context.view.staleBanner")}
        </Alert>
      )}
      <Paper
        variant="outlined"
        sx={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0, overflow: "hidden", borderRadius: 1.5 }}
      >
        {isCompact ? (
          <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
            {treePane}
          </Drawer>
        ) : (
          <Box sx={{ borderRight: "1px solid", borderColor: "divider", flexShrink: 0 }}>
            {treePane}
          </Box>
        )}

        <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden" }}>{editorPane}</Box>
      </Paper>

      <PublishDialog
        open={publishOpen}
        drafts={draftsList}
        branch={tree.gitConnection.branch}
        requirePullRequest={tree.requirePullRequest}
        conflicts={commitConflicts}
        fileErrors={fileErrors}
        refreshErrors={refreshErrors}
        publishing={publishing}
        refreshingPath={refreshingPath}
        errorMessage={commitError}
        onDiscardDraft={onDiscardDraft}
        onRefreshDraft={onRefreshDraft}
        onRestoreAsNew={onRestoreAsNew}
        onDiscardAll={() => setDiscardAllOpen(true)}
        onPublish={handlePublish}
        onClose={() => setPublishOpen(false)}
      />

      <CreateFilePopover
        anchorEl={createAnchor}
        scopes={scopes}
        existingPaths={existingPaths}
        target={createTarget}
        onCreate={handleCreateFile}
        onClose={() => {
          setCreateAnchor(null);
          setCreateTarget(null);
        }}
      />

      <Dialog
        open={discardAllOpen}
        onClose={() => setDiscardAllOpen(false)}
        data-testid="discard-all-dialog"
      >
        <DialogTitle>{t("dashboard.context.view.discardAllTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("dashboard.context.view.discardAllBody", { count: drafts.drafts.size })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscardAllOpen(false)} data-testid="discard-all-cancel">
            {t("dashboard.context.view.discardAllStay")}
          </Button>
          <Button color="error" variant="contained" onClick={discardAll} data-testid="discard-all-confirm">
            {t("dashboard.context.view.discardAllConfirm")}
          </Button>
        </DialogActions>
      </Dialog>

      {deleteTarget && (
        <DeleteContextDialog
          open
          appId={appId}
          target={deleteTarget}
          onStage={handleStageDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {leaveConfirm}
    </PageFrame>
  );
}

function PageFrame({
  children,
  repository,
  branch,
  onOpenTree,
  headerActions,
}: {
  children: React.ReactNode;
  repository?: string;
  branch?: string;
  onOpenTree?: () => void;
  headerActions?: React.ReactNode;
}) {
  const { t } = useTranslate();
  return (
    <Box
      sx={{
        height: `calc(100dvh - ${PAGE_CHROME_HEIGHT}px)`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <PageHeader
        title={t("dashboard.context.title")}
        caption={repository ? `${repository}${branch ? ` · ${branch}` : ""}` : undefined}
        leading={
          onOpenTree && (
            <IconButton size="small" onClick={onOpenTree} aria-label="Open file tree">
              <Iconify icon="mdi:file-tree-outline" />
            </IconButton>
          )
        }
        actions={headerActions}
      />
      <Box sx={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * Centers a page-level card in the shell's column. The empty/error cards are
 * content-height, and this page's column is a fixed `100dvh`-derived height —
 * without this they would pin to the top of a tall void.
 */
function CenteredPane({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Box sx={{ width: 1, maxWidth: 640 }}>{children}</Box>
    </Box>
  );
}

function PlaceholderPane({ text }: { text: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: 1, p: 3 }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {text}
      </Typography>
    </Box>
  );
}

/** Pane for a file staged for deletion — swaps in for the editor until the draft publishes or is restored. */
function DeletedFilePane({ onRestore }: { onRestore: () => void }) {
  const { t } = useTranslate();
  return (
    <Box
      data-testid="viewer-deleted-pane"
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: 1,
        p: 3,
        gap: 1.5,
      }}
    >
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("dashboard.context.view.markedForDeletion")}
      </Typography>
      <Button size="small" variant="outlined" onClick={onRestore} data-testid="viewer-deleted-restore">
        {t("dashboard.context.view.restoreDraft")}
      </Button>
    </Box>
  );
}

/** Calm pane for a file that lives only in a still-open PR (not in the mirror yet). */
function PendingPrPane({ number, url }: { number: number; url: string }) {
  const { t } = useTranslate();
  return (
    <Box
      data-testid="viewer-pending-pr-pane"
      sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: 1, p: 3 }}
    >
      <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", maxWidth: 420 }}>
        <Translation
          t={t}
          i18nKey="dashboard.context.view.pendingPrPane"
          values={{ number }}
          components={[<MuiLink key="pr" href={url} target="_blank" rel="noopener" />]}
        />
      </Typography>
    </Box>
  );
}
