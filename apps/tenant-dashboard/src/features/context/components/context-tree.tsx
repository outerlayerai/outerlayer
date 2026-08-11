"use client";

/**
 * Literal file tree for the Context surface. One collapsible section per
 * scope, labelled by its repo path (`root` / `apps/web`); the `.outerlayer/`
 * directory renders as the wrapper row, then the actual directories/filenames.
 * INVENTORY annotations only: kind icons, missing-SKILL.md warning triangle,
 * a "shadows" chip, the muted "· N servers" mcp suffix, the italic "⋯ N other
 * files in git" line as a skill's last child. No usage figures anywhere —
 * counts, trends, and last-used live in the Overview, never the tree.
 * Search filters over path/name.
 *
 * Icons come from Iconify; no test keys on `data-icon` (runtime emits none).
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { alpha, type SxProps, type Theme } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import type { ContextKind } from "@repo/context-core";
import {
  buildContextTreeModel,
  type ContextTreeModel,
  type TreeNode,
} from "./context-tree-model";
import {
  createLocationFor,
  dirDeleteAffordance,
  folderExists,
  nameError,
  pathLengthErrorKey,
  type DirDeleteAffordance,
} from "./context-create";
import type { CreateFileTarget } from "./editor";
import type { ContextDraftChangeType } from "./use-context-drafts";
import type { ContextTreeResponse } from "../types";

/** The scope path (`""` at repo root) that a `.outerlayer` dir governs. */
function scopeOf(scopeDir: string): string {
  return scopeDir.endsWith("/.outerlayer") ? scopeDir.slice(0, -"/.outerlayer".length) : "";
}

/**
 * Directory-row action affordances, bundled so a single prop threads through the
 * recursive rows. `null` when the caller supplies none of insert/delete hides
 * every row action; each capability is gated INDEPENDENTLY within the bundle —
 * insert (`onNewFile`/create machinery) and delete (`onDeleteFolder`) come from
 * separate permissions (`context.insert` / `context.delete`), so a role with
 * only one of them still sees that one's row action. `pendingFolderDir` is the
 * dir whose inline "new folder" input is open (one at a time); confirm resolves
 * the location's folder base dir.
 */
interface RowActions {
  /** Every path already present (tree ∪ drafts) — the inline folder input's duplicate check. */
  existingPaths: ReadonlySet<string>;
  /** Open the create popover pre-targeted at a directory, anchored to the clicked action. `undefined` hides file/folder row actions (insert permission absent). */
  onNewFile?: (target: CreateFileTarget, anchor: HTMLElement) => void;
  pendingFolderDir: string | null;
  startFolder: (dirPath: string) => void;
  cancelFolder: () => void;
  /** Stage the `.gitkeep` folder draft under `baseDir` (the location's folder base). */
  confirmFolder: (baseDir: string, name: string) => void;
  /** Opens the delete confirmation for a directory's affordance target — `undefined` hides the row action everywhere (delete permission absent). */
  onDeleteFolder?: (target: DirDeleteAffordance) => void;
}

/**
 * Threaded alongside {@link RowActions} — present only when the caller supplies
 * BOTH `draftChangeTypes` and `onDiscardDrafts`, which makes every change dot
 * (file or directory) clickable. `null` renders the dots as plain status marks
 * (a hover tooltip only, no popover).
 */
interface DiscardBundle {
  draftChangeTypes: ReadonlyMap<string, ContextDraftChangeType>;
  onDiscardDrafts: (paths: string[]) => void;
}

/** Every draft path under `dirPath` (its own subtree, not itself), sorted for a deterministic bulk-discard order. */
function draftEntriesUnderDir(
  dirPath: string,
  draftChangeTypes: ReadonlyMap<string, ContextDraftChangeType>,
): Array<[string, ContextDraftChangeType]> {
  const prefix = `${dirPath}/`;
  return [...draftChangeTypes].filter(([path]) => path.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
}

interface DraftCounts {
  edits: number;
  creates: number;
  deletes: number;
}

function summarizeDraftCounts(entries: Array<[string, ContextDraftChangeType]>): DraftCounts {
  const counts: DraftCounts = { edits: 0, creates: 0, deletes: 0 };
  for (const [, type] of entries) {
    if (type === "edit") counts.edits += 1;
    else if (type === "create") counts.creates += 1;
    else counts.deletes += 1;
  }
  return counts;
}

/** "3 edits · 1 new file · 12 deletions" — only the non-zero counts, in a fixed order. */
function formatDraftCounts(t: (key: string, opts?: Record<string, unknown>) => string, counts: DraftCounts): string {
  const parts: string[] = [];
  if (counts.edits > 0) parts.push(t("dashboard.context.tree.countEdits", { count: counts.edits }));
  if (counts.creates > 0) parts.push(t("dashboard.context.tree.countNew", { count: counts.creates }));
  if (counts.deletes > 0) parts.push(t("dashboard.context.tree.countDeletions", { count: counts.deletes }));
  return parts.join(" · ");
}

const KIND_ICON: Record<ContextKind, string> = {
  instructions: "mdi:file-document-outline",
  "external-instructions": "mdi:file-document-outline",
  skill: "mdi:star-four-points-outline",
  "skill-reference": "mdi:note-text-outline",
  command: "mdi:console-line",
  reference: "mdi:note-text-outline",
  mcp: "mdi:power-plug-outline",
  subagent: "mdi:robot-outline",
  // `folder` entries (`.gitkeep` keepers) never render as a file row; the entry
  // reifies the dir. Listed only to keep this map exhaustive over ContextKind.
  folder: "mdi:folder-outline",
};

const INDENT_STEP = 16;
const ROW_HEIGHT = 32;

interface ContextTreeProps {
  response: ContextTreeResponse;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Case-insensitive path/name filter; empty shows the whole tree. */
  query?: string;
  /** Uncommitted drafts keyed by path — drives the per-file dirty/new dot. */
  draftChangeTypes?: ReadonlyMap<string, ContextDraftChangeType>;
  /** Paths committed to a still-open PR — merged into the tree with a muted "PR" tag. */
  pendingPrPaths?: ReadonlySet<string>;
  /**
   * Paths a just-landed delete removed. The mirror can lag the commit, so these
   * are dropped from the tree immediately instead of lingering as clickable rows
   * until the head advances.
   */
  hiddenPaths?: ReadonlySet<string>;
  /** Open the create popover pre-targeted at a directory, anchored to the clicked action. Omit to hide file row actions. */
  onNewFile?: (target: CreateFileTarget, anchor: HTMLElement) => void;
  /** Stage a `.gitkeep` folder draft at `<baseDir>/<name>/.gitkeep`. Omit to hide folder row actions. */
  onNewFolder?: (baseDir: string, name: string) => void;
  /** Opens the delete confirmation for a directory. Omit to hide the folder-delete row action (delete permission absent). */
  onDeleteFolder?: (target: DirDeleteAffordance) => void;
  /**
   * Discards every draft in `paths` in one call. Supplied together with
   * `draftChangeTypes`, this makes every change dot (file or directory)
   * clickable, opening a discard/restore popover. Omit either to leave the
   * dots as plain (non-interactive) status marks.
   */
  onDiscardDrafts?: (paths: string[]) => void;
}

/**
 * Roving-tabindex focus model for the WAI-ARIA tree pattern: exactly one
 * treeitem is tabbable (`activePath`); the container's key handler moves it
 * across visible rows. The recursive rows read it via context so no per-row
 * state has to be lifted.
 */
interface TreeNav {
  activePath: string | null;
  setActivePath: (path: string) => void;
}
const TreeNavContext = createContext<TreeNav>({ activePath: null, setActivePath: () => {} });

/** This row's 1-based position among its rendered siblings, and how many there are. */
interface TreePosition {
  setSize: number;
  posInset: number;
}

/** ARIA/DOM props every focusable tree row spreads so the container can drive keyboard nav. */
function useTreeItemProps(path: string, depth: number, expanded?: boolean, position?: TreePosition) {
  const { activePath, setActivePath } = useContext(TreeNavContext);
  return {
    role: "treeitem" as const,
    tabIndex: activePath === path ? 0 : -1,
    "data-path": path,
    "data-depth": depth,
    // The scope header sits at depth -1 as the tree's top level (WAI-ARIA
    // levels are 1-based), so every level is depth + 2.
    "aria-level": depth + 2,
    ...(expanded === undefined ? {} : { "aria-expanded": expanded }),
    ...(position === undefined
      ? {}
      : { "aria-setsize": position.setSize, "aria-posinset": position.posInset }),
    // Keep the single tab-stop on whatever ROW takes focus (mouse, Tab, arrows);
    // ignore focus bubbling up from a row-action button (target !== the row).
    onFocus: (e: ReactFocusEvent) => {
      if (e.target === e.currentTarget) setActivePath(path);
    },
  };
}

/** A row name is truncated exactly when its rendered text overflows its box. */
export function isOverflowing(el: HTMLElement | null): boolean {
  return el !== null && el.scrollWidth > el.clientWidth;
}

/**
 * A tree row's name that ellipsizes when it's too long and, only then, shows the
 * full name in a hover tooltip. Overflow is measured on hover
 * (`scrollWidth > clientWidth`), so a fully-visible name gets no tooltip.
 */
function TruncatingName({
  name,
  sx,
  variant = "body2",
}: {
  name: string;
  sx?: SxProps<Theme>;
  variant?: "body2" | "caption";
}) {
  const ref = useRef<HTMLElement>(null);
  const [truncated, setTruncated] = useState(false);
  return (
    <Tooltip title={truncated ? name : ""}>
      <Typography
        ref={ref}
        variant={variant}
        onMouseEnter={() => setTruncated(isOverflowing(ref.current))}
        sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...sx }}
      >
        {name}
      </Typography>
    </Tooltip>
  );
}

/** Keyboard outline shared by every focusable tree row (roving-tabindex focus is otherwise invisible). */
const TREE_ROW_FOCUS_SX = {
  "&:focus-visible": {
    outline: "2px solid",
    outlineColor: "primary.main",
    outlineOffset: "-2px",
  },
} as const;

/**
 * WAI-ARIA tree keyboard handling on the container: Up/Down move across the
 * VISIBLE rows (collapsed subtrees aren't in the DOM), Right expands a collapsed
 * dir then descends, Left collapses an open dir else moves to the parent,
 * Enter/Space activates (open a file / select a skill dir / toggle a plain dir),
 * Home/End jump. Activation reuses the row's own click; expand/collapse clicks
 * the row's chevron when it owns the toggle (else the row) — so no row state is
 * lifted. Reads live DOM order, so it needs no flattened model.
 */
function handleTreeKeyDown(
  e: ReactKeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
  activePath: string | null,
  setActivePath: (path: string) => void,
): void {
  if (!container) return;
  const target = e.target as HTMLElement;
  // The inline new-folder TextField (and any future in-tree text input) owns
  // EVERY key while focused — typing, arrow-key caret movement, Enter to
  // confirm — none of it is tree navigation, regardless of which key it is.
  if (target.closest("input, textarea, [contenteditable]")) return;
  // A row action button (new file/folder, delete, a change-dot trigger) sits
  // INSIDE a treeitem row and needs its own native Enter/Space activation —
  // without this the container handler still fires first, preventDefaults
  // the button's own activation, and clicks `items[idx]` (the row itself, or
  // index 0 when nothing is focused) instead. Every OTHER key (arrows,
  // Home/End) still falls through to tree navigation, so focus can move back
  // into the tree from a focused button.
  if (target.closest("button") && (e.key === "Enter" || e.key === " ")) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  if (items.length === 0) return;
  const idx = Math.max(
    0,
    items.findIndex((el) => el.dataset.path === activePath),
  );
  const current = items[idx];
  if (!current) return;
  const focusAt = (target: number): void => {
    const el = items[Math.max(0, Math.min(items.length - 1, target))];
    if (!el) return;
    setActivePath(el.dataset.path ?? "");
    el.focus();
  };
  // A skill dir's row-click selects (its chevron owns expansion), so keyboard
  // expand/collapse clicks the chevron when the row has one; every other row
  // toggles from its own click.
  const toggleExpand = (row: HTMLElement): void => {
    const chevron = row.querySelector<HTMLElement>('[data-testid^="tree-dir-chevron-"]');
    (chevron ?? row).click();
  };
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      focusAt(idx + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      focusAt(idx - 1);
      break;
    case "Home":
      e.preventDefault();
      focusAt(0);
      break;
    case "End":
      e.preventDefault();
      focusAt(items.length - 1);
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      current.click();
      break;
    case "ArrowRight": {
      e.preventDefault();
      const expanded = current.getAttribute("aria-expanded");
      if (expanded === "false") toggleExpand(current);
      else if (expanded === "true") focusAt(idx + 1);
      break;
    }
    case "ArrowLeft": {
      e.preventDefault();
      if (current.getAttribute("aria-expanded") === "true") {
        toggleExpand(current);
      } else {
        const depth = Number(current.dataset.depth ?? "0");
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (Number(items[i]!.dataset.depth ?? "0") < depth) {
            focusAt(i);
            break;
          }
        }
      }
      break;
    }
    default:
      break;
  }
}

export default function ContextTree({ response, selectedPath, onSelect, query = "", draftChangeTypes, pendingPrPaths, hiddenPaths, onNewFile, onNewFolder, onDeleteFolder, onDiscardDrafts }: ContextTreeProps) {
  const { t } = useTranslate();
  // Deleted-but-not-yet-mirrored paths are pruned from the source entries before
  // the tree is built, so a whole-skill delete collapses its directory too.
  const visibleResponse = useMemo(() => {
    if (!hiddenPaths || hiddenPaths.size === 0) return response;
    return { ...response, entries: response.entries.filter((e) => !hiddenPaths.has(e.path)) };
  }, [response, hiddenPaths]);
  const model = useMemo(
    () => buildContextTreeModel(visibleResponse, draftChangeTypes, pendingPrPaths),
    [visibleResponse, draftChangeTypes, pendingPrPaths],
  );
  const filtered = useMemo(() => filterModel(model, query.trim().toLowerCase()), [model, query]);

  const [pendingFolderDir, setPendingFolderDir] = useState<string | null>(null);
  const existingPaths = useMemo(() => {
    const s = new Set<string>();
    for (const e of response.entries) s.add(e.path);
    if (draftChangeTypes) for (const p of draftChangeTypes.keys()) s.add(p);
    return s;
  }, [response.entries, draftChangeTypes]);

  // The bundle exists whenever insert (both create callbacks) or delete
  // (onDeleteFolder) is supplied — each renders its own row action independent
  // of the other, so a delete-only role still gets the folder-delete action
  // with no create affordances, and vice versa.
  const canCreate = Boolean(onNewFile && onNewFolder);
  const actions: RowActions | null =
    canCreate || onDeleteFolder
      ? {
          existingPaths,
          onNewFile: canCreate ? onNewFile : undefined,
          pendingFolderDir,
          startFolder: (dirPath) => setPendingFolderDir(dirPath),
          cancelFolder: () => setPendingFolderDir(null),
          confirmFolder: (baseDir, name) => {
            if (canCreate) onNewFolder!(baseDir, name);
            setPendingFolderDir(null);
          },
          onDeleteFolder,
        }
      : null;

  const discard: DiscardBundle | null =
    draftChangeTypes && onDiscardDrafts ? { draftChangeTypes, onDiscardDrafts } : null;

  // Roving-tabindex focus model: one tabbable row at a time.
  const [activePath, setActivePath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // Keep the tab-stop valid: if the active row unmounts (a collapse, a filter,
  // a delete), fall back to the first visible row so Tab still enters the tree.
  useEffect(() => {
    const container = treeRef.current;
    if (!container) return;
    const paths = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(
      (el) => el.dataset.path ?? "",
    );
    if (paths.length === 0) return;
    if (activePath === null || !paths.includes(activePath)) setActivePath(paths[0]!);
  });
  const nav = useMemo<TreeNav>(() => ({ activePath, setActivePath }), [activePath]);

  const hasAnything = filtered.scopes.some((s) => s.children.length > 0);

  if (!hasAnything) {
    // An active filter with no match says so; an empty tree stays quiet — the
    // create (+) affordance and the editor-pane empty state carry the message.
    if (query.trim() === "") return null;
    return (
      <Typography variant="body2" sx={{ color: "text.secondary", p: 2 }}>
        {t("dashboard.context.tree.noMatch", { query })}
      </Typography>
    );
  }

  return (
    <TreeNavContext.Provider value={nav}>
      <Box
        role="tree"
        aria-label="Context files"
        ref={treeRef}
        onKeyDown={(e) => handleTreeKeyDown(e, treeRef.current, activePath, setActivePath)}
      >
        {(() => {
          const visibleScopes = filtered.scopes.filter((scope) => scope.children.length > 0);
          return visibleScopes.map((scope, index) => (
            <ScopeSection
              key={scope.scopeDir}
              scopeLabel={scope.scopeLabel}
              scopeDir={scope.scopeDir}
              nodes={scope.children}
              selectedPath={selectedPath}
              onSelect={onSelect}
              forceOpen={query.trim() !== ""}
              actions={actions}
              discard={discard}
              position={{ setSize: visibleScopes.length, posInset: index + 1 }}
            />
          ));
        })()}
      </Box>
    </TreeNavContext.Provider>
  );
}

/**
 * The `.outerlayer/` directory itself, wrapping a scope's tree nodes as one
 * more row under the scope header. Pure and side-effect-free so a caller can
 * memoize it on `[scopeDir, nodes]` instead of constructing a fresh object
 * (and defeating a child row's own node-identity memoization) every render.
 */
export function buildOuterlayerNode(
  scopeDir: string,
  nodes: TreeNode[],
): Extract<TreeNode, { type: "dir" }> {
  return {
    type: "dir",
    path: scopeDir,
    name: ".outerlayer",
    badges: [],
    excludedCount: null,
    children: nodes,
  };
}

function ScopeSection({
  scopeLabel,
  scopeDir,
  nodes,
  selectedPath,
  onSelect,
  forceOpen,
  actions,
  discard,
  position,
}: {
  scopeLabel: string;
  scopeDir: string;
  nodes: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  forceOpen: boolean;
  actions: RowActions | null;
  discard: DiscardBundle | null;
  position: TreePosition;
}) {
  const [open, setOpen] = useState(true);
  // Memoized on its actual inputs (not a fresh literal every render) — this
  // root row stays expanded by default, so DirRow's node-identity memoization
  // of the full-subtree draft scans below would otherwise never hit for it.
  const outerlayerNode = useMemo(() => buildOuterlayerNode(scopeDir, nodes), [scopeDir, nodes]);
  return (
    <Box sx={{ mt: 1.5, "&:first-of-type": { mt: 0 } }}>
      <SectionHeader
        label={scopeLabel}
        icon={open ? "mdi:chevron-down" : "mdi:chevron-right"}
        onClick={() => setOpen((v) => !v)}
        // Header actions target the scope's `.outerlayer` root, like its wrapper row.
        actions={actions}
        scopeRoot={scopeDir}
        // A synthetic identity distinct from the `.outerlayer` row below (which
        // carries `scopeDir` itself) so the two rows never share a tab-stop.
        itemPath={`scope:${scopeDir}`}
        expanded={open}
        position={position}
      />
      <Collapse in={open} timeout="auto" unmountOnExit role="group">
        <DirRow
          node={outerlayerNode}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceOpen={forceOpen}
          actions={actions}
          discard={discard}
          scopeDir={scopeDir}
          position={{ setSize: 1, posInset: 1 }}
        />
      </Collapse>
    </Box>
  );
}

function SectionHeader({
  label,
  icon,
  onClick,
  muted = false,
  actions,
  scopeRoot,
  itemPath,
  expanded,
  position,
}: {
  label: string;
  icon: string;
  onClick?: () => void;
  muted?: boolean;
  actions?: RowActions | null;
  /** The scope's `.outerlayer` dir — the header's create actions target it. */
  scopeRoot?: string;
  /** Tree-row identity for keyboard nav — the scope header is the tree's top-level row. */
  itemPath: string;
  /** Whether the scope section is expanded (drives `aria-expanded`). */
  expanded: boolean;
  /** This scope header's position among the tree's top-level treeitems. */
  position: TreePosition;
}) {
  // The scope header sits above `.outerlayer` (depth 0), so its parent-depth is -1.
  const treeItemProps = useTreeItemProps(itemPath, -1, expanded, position);
  return (
    <Stack
      direction="row"
      spacing={0.5}
      {...treeItemProps}
      onClick={onClick}
      sx={{
        alignItems: "center",
        px: 1,
        py: 0.75,
        cursor: onClick ? "pointer" : "default",
        color: muted ? "text.disabled" : "text.secondary",
        "&:hover .row-actions, &:focus-within .row-actions": { opacity: 1 },
        ...TREE_ROW_FOCUS_SX,
      }}
    >
      <Iconify icon={icon} width={16} />
      <Typography variant="overline" sx={{ letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Box sx={{ flexGrow: 1 }} />
      {/* The scope's own .outerlayer root never gets a delete affordance
          (dirDeleteAffordance refuses it), so this header only ever needs the
          create actions — nothing to show for a delete-only role. */}
      {actions?.onNewFile && scopeRoot !== undefined && (
        <RowActionButtons
          showFile
          showFolder
          onFile={(anchor) =>
            actions.onNewFile!({ scope: scopeOf(scopeRoot), baseDir: scopeRoot, presetKind: null }, anchor)
          }
          onFolder={() => actions.startFolder(scopeRoot)}
          testKey={`header-${scopeRoot}`}
        />
      )}
    </Stack>
  );
}

/**
 * A file's change dot as a clickable ≥20px hit target (the dot itself stays
 * its usual 8px) opening a Popover: a one-line status plus a single
 * discard/restore action for that one path. `delete` restores immediately on
 * click (dropping the delete draft loses nothing); `edit`/`create` discard
 * immediately too — the undo affordance lives with the caller that owns the
 * draft store (`onDiscardDrafts`), not here.
 */
function FileDiscardDot({
  testId,
  tooltip,
  size,
  color,
  path,
  changeType,
  discard,
}: {
  testId: string;
  /** Also the trigger's accessible name — one translated string for both, never a separate hardcoded aria-label. */
  tooltip: string;
  size: number;
  color: string;
  path: string;
  changeType: ContextDraftChangeType;
  discard: DiscardBundle;
}) {
  const { t } = useTranslate();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const bodyKey =
    changeType === "delete"
      ? "dashboard.context.tree.discardDeleteBody"
      : changeType === "create"
        ? "dashboard.context.tree.discardCreateBody"
        : "dashboard.context.tree.discardEditBody";
  const actionKey =
    changeType === "delete"
      ? "dashboard.context.tree.restoreFile"
      : changeType === "create"
        ? "dashboard.context.tree.discardNewFile"
        : "dashboard.context.tree.discardChange";
  return (
    <>
      <Tooltip title={tooltip}>
        <IconButton
          size="small"
          aria-label={tooltip}
          data-testid={`${testId}-trigger`}
          onClick={(e) => {
            e.stopPropagation();
            setAnchorEl(e.currentTarget);
          }}
          sx={{
            p: "6px",
            flexShrink: 0,
            "&.Mui-focusVisible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: "-2px",
            },
          }}
        >
          <Box
            component="span"
            data-testid={testId}
            sx={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, bgcolor: color }}
          />
        </IconButton>
      </Tooltip>
      <Popover
        open={anchorEl !== null}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: -6, horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 1.5, maxWidth: 220 } } }}
        data-testid={`${testId}-popover`}
        // The Popover (its content AND its click-away backdrop) is a
        // React-tree descendant of this row even though it portals elsewhere
        // in the DOM — React re-dispatches the synthetic click along the
        // component tree, so without this a click anywhere in the popover
        // (body text, backdrop dismiss) still bubbles into the row's onSelect.
        onClick={(e) => e.stopPropagation()}
      >
        <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1 }}>{t(bodyKey)}</Typography>
        <Button
          size="small"
          onClick={() => {
            discard.onDiscardDrafts([path]);
            setAnchorEl(null);
          }}
          data-testid={`${testId}-action`}
        >
          {t(actionKey)}
        </Button>
      </Popover>
    </>
  );
}

/**
 * A directory's change dot: a clickable hit target opening a Popover that
 * counts the staged changes under this directory by type. A directory whose
 * staged paths are ALL deletes restores the whole folder in one click
 * (nothing destructive is lost); any other mix opens a confirm Dialog first —
 * a bulk discard of edit/create buffers can't be undone.
 */
function DirDiscardDot({
  testId,
  tooltip,
  size,
  color,
  node,
  discard,
}: {
  testId: string;
  /** Also the trigger's accessible name — one translated string for both, never a separate hardcoded aria-label. */
  tooltip: string;
  size: number;
  color: string;
  node: Extract<TreeNode, { type: "dir" }>;
  discard: DiscardBundle;
}) {
  const { t } = useTranslate();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTitleId = `${testId}-confirm-title`;

  // A full draft-map scan + sort, so it's memoized to run once per
  // path/draft-state combination rather than on every render of this row
  // (a dir row re-renders on every keystroke of an unrelated search filter).
  const entries = useMemo(
    () => draftEntriesUnderDir(node.path, discard.draftChangeTypes),
    [node.path, discard.draftChangeTypes],
  );
  const paths = entries.map(([path]) => path);
  const counts = summarizeDraftCounts(entries);
  const allDeletes = entries.length > 0 && counts.deletes === entries.length;
  const summary = formatDraftCounts(t, counts);
  const actionLabel = allDeletes
    ? t("dashboard.context.tree.restoreFolder")
    : t("dashboard.context.tree.discardStagedChanges", { count: entries.length });

  return (
    <>
      <Tooltip title={tooltip}>
        <IconButton
          size="small"
          aria-label={tooltip}
          data-testid={`${testId}-trigger`}
          onClick={(e) => {
            e.stopPropagation();
            setAnchorEl(e.currentTarget);
          }}
          sx={{
            p: "6px",
            flexShrink: 0,
            "&.Mui-focusVisible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: "-2px",
            },
          }}
        >
          <Box
            component="span"
            data-testid={testId}
            sx={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, bgcolor: color }}
          />
        </IconButton>
      </Tooltip>
      <Popover
        open={anchorEl !== null}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: -6, horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 1.5, maxWidth: 260 } } }}
        data-testid={`${testId}-popover`}
        // See FileDiscardDot's Popover — a Popover's content and click-away
        // backdrop bubble through the React tree, not the DOM tree, so
        // without this a click anywhere in it still reaches the row's onClick.
        onClick={(e) => e.stopPropagation()}
      >
        <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1 }}>{summary}</Typography>
        <Button
          size="small"
          onClick={() => {
            setAnchorEl(null);
            if (allDeletes) discard.onDiscardDrafts(paths);
            else setConfirmOpen(true);
          }}
          data-testid={`${testId}-action`}
        >
          {actionLabel}
        </Button>
      </Popover>
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        data-testid={`${testId}-confirm-dialog`}
        aria-labelledby={confirmTitleId}
        // Same React-tree bubbling gotcha as the Popover above.
        onClick={(e) => e.stopPropagation()}
      >
        <DialogTitle id={confirmTitleId}>{t("dashboard.context.tree.discardConfirmTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("dashboard.context.tree.discardConfirmBody", { summary })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setConfirmOpen(false)}
            data-testid={`${testId}-confirm-cancel`}
          >
            {t("dashboard.context.delete.cancel")}
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              discard.onDiscardDrafts(paths);
              setConfirmOpen(false);
            }}
            data-testid={`${testId}-confirm-confirm`}
          >
            {t("dashboard.context.tree.discardConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function NodeRow({
  node,
  depth,
  selectedPath,
  onSelect,
  forceOpen,
  actions,
  discard,
  scopeDir,
  position,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** An active filter shows matches inside default-collapsed dirs. */
  forceOpen: boolean;
  actions: RowActions | null;
  discard: DiscardBundle | null;
  scopeDir: string;
  position: TreePosition;
}) {
  if (node.type === "file") {
    return (
      <FileRow
        node={node}
        depth={depth}
        selectedPath={selectedPath}
        onSelect={onSelect}
        discard={discard}
        position={position}
      />
    );
  }
  return (
    <DirRow
      node={node}
      depth={depth}
      selectedPath={selectedPath}
      onSelect={onSelect}
      forceOpen={forceOpen}
      actions={actions}
      discard={discard}
      scopeDir={scopeDir}
      position={position}
    />
  );
}

/** Hover-revealed "New file" / "New folder" icon buttons for a directory row or scope header. */
function RowActionButtons({
  showFile,
  showFolder,
  onFile,
  onFolder,
  onDelete,
  testKey,
}: {
  showFile: boolean;
  showFolder: boolean;
  onFile: (anchor: HTMLElement) => void;
  onFolder: () => void;
  /** Present only for a dir row with a delete affordance and delete permission. */
  onDelete?: () => void;
  /** Stable per-row suffix for the action test ids (`new-file-<dir>` / `new-folder-<dir>`). */
  testKey: string;
}) {
  const { t } = useTranslate();
  return (
    <Stack
      direction="row"
      spacing={0.25}
      className="row-actions"
      // Revealed on row hover/focus; always visible where hover isn't available (touch).
      sx={{ flexShrink: 0, opacity: 0, transition: "opacity 0.1s", "@media (hover: none)": { opacity: 1 } }}
    >
      {showFile && (
        <Tooltip title={t("dashboard.context.tree.newFile")}>
          <IconButton
            size="small"
            aria-label={t("dashboard.context.tree.newFile")}
            data-testid={`new-file-${testKey}`}
            onClick={(e) => {
              e.stopPropagation();
              onFile(e.currentTarget);
            }}
            sx={{
              p: 0.25,
              "&.Mui-focusVisible": {
                outline: "2px solid",
                outlineColor: "primary.main",
                outlineOffset: "-2px",
              },
            }}
          >
            <Iconify icon="mdi:file-plus-outline" width={16} />
          </IconButton>
        </Tooltip>
      )}
      {showFolder && (
        <Tooltip title={t("dashboard.context.tree.newFolder")}>
          <IconButton
            size="small"
            aria-label={t("dashboard.context.tree.newFolder")}
            data-testid={`new-folder-${testKey}`}
            onClick={(e) => {
              e.stopPropagation();
              onFolder();
            }}
            sx={{
              p: 0.25,
              "&.Mui-focusVisible": {
                outline: "2px solid",
                outlineColor: "primary.main",
                outlineOffset: "-2px",
              },
            }}
          >
            <Iconify icon="mdi:folder-plus-outline" width={16} />
          </IconButton>
        </Tooltip>
      )}
      {onDelete && (
        <Tooltip title={t("dashboard.context.tree.deleteFolder")}>
          <IconButton
            size="small"
            aria-label={t("dashboard.context.tree.deleteFolder")}
            data-testid={`delete-folder-${testKey}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            sx={{
              p: 0.25,
              "&.Mui-focusVisible": {
                outline: "2px solid",
                outlineColor: "primary.main",
                outlineOffset: "-2px",
              },
            }}
          >
            <Iconify icon="mdi:trash-can-outline" width={16} />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}

/**
 * Inline provisional row for naming a new folder. Enter confirms (when valid),
 * Esc cancels. Validates the name with the shared authoring rules and rejects a
 * folder that already exists at the target path.
 */
function NewFolderInput({
  baseDir,
  depth,
  existingPaths,
  onConfirm,
  onCancel,
}: {
  baseDir: string;
  depth: number;
  existingPaths: ReadonlySet<string>;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslate();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const slugKey = nameError(trimmed, { allowSlash: true });
  const pathKey = slugKey === null && trimmed !== "" ? pathLengthErrorKey(`${baseDir}/${trimmed}`) : null;
  const nameKey = slugKey ?? pathKey;
  const duplicate = nameKey === null && trimmed !== "" && folderExists(`${baseDir}/${trimmed}`, existingPaths);
  const errorKey = nameKey ?? (duplicate ? "dashboard.context.create.validation.dupFolder" : null);
  const canConfirm = trimmed !== "" && errorKey === null;

  const showError = trimmed.length > 0 && errorKey !== null;
  return (
    <Box sx={{ pr: 1 }} data-testid="tree-new-folder-input">
      {/* Renders as a directory row: child indent, folder icon in the icon slot,
          a borderless inline input at 13px row typography, 32px tall. */}
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ alignItems: "center", minHeight: 32, pl: `${depth * INDENT_STEP + 24}px` }}
      >
        <Iconify icon="mdi:folder-outline" width={18} sx={{ color: "text.secondary", flexShrink: 0 }} />
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          placeholder={t("dashboard.context.tree.newFolderName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (trimmed === "") onCancel();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) onConfirm(trimmed);
            else if (e.key === "Escape") onCancel();
          }}
          error={showError}
          slotProps={{
            input: { disableUnderline: true, sx: { fontSize: 13 } },
            htmlInput: { "data-testid": "tree-new-folder-name", "aria-label": t("dashboard.context.tree.newFolderName") },
          }}
        />
      </Stack>
      {/* Validation message only when there is an error — no reserved blank line. */}
      {showError && (
        <Typography sx={{ fontSize: 12, color: "error.main", pl: `${depth * INDENT_STEP + 24}px` }}>
          {t(errorKey)}
        </Typography>
      )}
    </Box>
  );
}

/** A skill's own directory — the one holding its SKILL.md. */
function isSkillDir(node: Extract<TreeNode, { type: "dir" }>): boolean {
  return node.children.some((c) => c.type === "file" && c.kind === "skill");
}

/**
 * The strongest draft state anywhere under a dir — bubbles a dot up to the
 * collapsed row (`new` outranks `dirty`: a brand-new skill reads as new).
 */
function descendantDraftType(node: Extract<TreeNode, { type: "dir" }>): "new" | "dirty" | null {
  let found: "new" | "dirty" | null = null;
  for (const child of node.children) {
    const childType =
      child.type === "file"
        ? (child.badges.find((b) => b.type === "dirty" || b.type === "new")?.type ?? null)
        : descendantDraftType(child);
    if (childType === "new") return "new";
    if (childType === "dirty") found = "dirty";
  }
  return found;
}

/**
 * A dir reads as marked-for-deletion only when EVERY file under it is marked —
 * a partially-deleted dir keeps its normal appearance. An empty dir (no file
 * descendants) is not itself a deletion. The dir's own `deleted` badge (a
 * folder-keeper marked for removal) counts as a fully-deleted dir.
 */
function allDescendantsDeleted(node: Extract<TreeNode, { type: "dir" }>): boolean {
  if (node.badges.some((b) => b.type === "deleted")) return true;
  let sawFile = false;
  for (const child of node.children) {
    if (child.type === "file") {
      sawFile = true;
      if (!child.badges.some((b) => b.type === "deleted")) return false;
    } else {
      // A subdir with no files of its own doesn't veto; one with un-deleted
      // files does.
      if (hasFileDescendant(child) && !allDescendantsDeleted(child)) return false;
      if (hasFileDescendant(child)) sawFile = true;
    }
  }
  return sawFile;
}

/** True when the dir has at least one file somewhere in its subtree. */
function hasFileDescendant(node: Extract<TreeNode, { type: "dir" }>): boolean {
  return node.children.some((c) => (c.type === "file" ? true : hasFileDescendant(c)));
}

function DirRow({
  node,
  depth,
  selectedPath,
  onSelect,
  forceOpen,
  actions,
  discard,
  scopeDir,
  position,
}: {
  node: Extract<TreeNode, { type: "dir" }>;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  forceOpen: boolean;
  actions: RowActions | null;
  discard: DiscardBundle | null;
  scopeDir: string;
  position: TreePosition;
}) {
  const { t } = useTranslate();
  // Every directory row — skill dirs included — toggles expansion on click;
  // the editor pane renders only for FILES. (Skill usage lives in the
  // Overview, not behind the dir row.)
  // Skill directories collapse to one row each so a large tree stays scannable.
  const [open, setOpen] = useState(() => !isSkillDir(node));
  // A deep link or a fresh create inside a collapsed dir must be visible: open
  // any dir that holds the selected path when the selection changes (the user
  // can still collapse it again afterward).
  const holdsSelected = selectedPath !== null && selectedPath.startsWith(`${node.path}/`);
  // Re-key on `selectedPath` (not `holdsSelected`) so selecting a different file
  // inside an already-holding-but-collapsed dir re-opens it — while a plain
  // toggle of `holdsSelected` back to the same truthy value would not re-fire.
  useEffect(() => {
    if (holdsSelected) setOpen(true);
  }, [selectedPath]);
  // A search-active filter force-opens every dir so matches stay visible —
  // but that would otherwise make a manual chevron/row click look dead (it
  // toggles `open`, yet `forceOpen` keeps overriding it back open). Once the
  // user manually toggles WHILE a filter is forcing this dir open, that
  // click wins for the rest of this filter session; clearing the filter
  // (forceOpen goes false) resets the override so the NEXT search starts fresh.
  const [manualOverride, setManualOverride] = useState(false);
  useEffect(() => {
    if (!forceOpen) setManualOverride(false);
  }, [forceOpen]);
  // Create rules for this dir; drives which actions show and where a new
  // file/folder lands. Naming a folder here forces the dir open so its input shows.
  const loc = actions ? createLocationFor(node.path, scopeDir) : null;
  const deleteAffordance = actions?.onDeleteFolder ? dirDeleteAffordance(node.path, scopeDir) : null;
  const namingFolder = actions?.pendingFolderDir === node.path;
  const effectiveOpen = open || (forceOpen && !manualOverride) || namingFolder;
  // Toggles what's VISIBLE, not the invisible `open` bit: while a filter is
  // forcing this dir open (`open` itself may still be its collapsed default),
  // a click must flip the state the user actually SEES — otherwise toggling
  // the hidden `open` from false to true is a no-op the user can't tell apart
  // from nothing happening.
  const toggleOpen = () => {
    setOpen(!effectiveOpen);
    setManualOverride(true);
  };
  const missing = node.badges.find((b) => b.type === "missing-skill-md");
  // A dir every one of whose files is marked for deletion reads as deleted
  // itself — struck name + red dot, shown open or collapsed (the whole dir is
  // going away). This outranks the new/dirty bubble below.
  // Both walk this dir's full subtree, so they're memoized on the tree node —
  // recomputed only when the tree model rebuilds (a new draft/tree/filter
  // state), not on every incidental re-render (e.g. an unrelated selection
  // change) of this row.
  const dirDeleted = useMemo(() => allDescendantsDeleted(node), [node]);
  // The dir's OWN draft state (a new empty folder from a `.gitkeep` draft) shows
  // whether open or not; a descendant's state only bubbles up while collapsed
  // — an expanded dir (the common case for the root `.outerlayer` row) skips
  // the subtree walk entirely rather than computing a value the row discards.
  const ownDraft = node.badges.find((b) => b.type === "new" || b.type === "dirty")?.type ?? null;
  const descendantType = useMemo(
    () => (effectiveOpen ? null : descendantDraftType(node)),
    [node, effectiveOpen],
  );
  const bubbledDraft = ownDraft ?? descendantType;
  const treeItemProps = useTreeItemProps(node.path, depth, effectiveOpen, position);
  return (
    <Box>
      <Stack
        direction="row"
        spacing={0.5}
        {...treeItemProps}
        onClick={toggleOpen}
        sx={{
          alignItems: "center",
          pl: `${depth * INDENT_STEP + 24}px`,
          pr: 1,
          minHeight: ROW_HEIGHT,
          borderRadius: 1,
          cursor: "pointer",
          "&:hover": { bgcolor: (theme) => theme.palette.action.hover },
          "&:hover .row-actions, &:focus-within .row-actions": { opacity: 1 },
          ...TREE_ROW_FOCUS_SX,
        }}
      >
        <Box component="span" sx={{ display: "inline-flex", flexShrink: 0 }}>
          <Iconify
            icon={effectiveOpen ? "mdi:chevron-down" : "mdi:chevron-right"}
            width={16}
            sx={{ color: "text.disabled" }}
          />
        </Box>
        <Iconify icon="mdi:folder-outline" width={18} sx={{ color: "text.secondary" }} />
        <TruncatingName
          name={node.name}
          sx={{ fontSize: 13, flexGrow: 1, minWidth: 0, ...(dirDeleted ? { textDecoration: "line-through", color: "text.disabled" } : {}) }}
        />
        {missing && <MissingSkillBadge detail={missing.detail} />}
        {dirDeleted ? (
          discard ? (
            <DirDiscardDot
              testId="tree-dir-deleted-dot"
              tooltip={t("dashboard.context.tree.markedForDeletion")}
              size={7}
              color="error.main"
              node={node}
              discard={discard}
            />
          ) : (
            <Tooltip title={t("dashboard.context.tree.markedForDeletion")}>
              <Box
                component="span"
                data-testid="tree-dir-deleted-dot"
                aria-label="Marked for deletion"
                sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, bgcolor: "error.main" }}
              />
            </Tooltip>
          )
        ) : bubbledDraft ? (
          discard ? (
            <DirDiscardDot
              testId="tree-dir-draft-dot"
              tooltip={
                bubbledDraft === "new"
                  ? t("dashboard.context.tree.containsNew")
                  : t("dashboard.context.tree.containsUnsaved")
              }
              size={7}
              color={bubbledDraft === "new" ? "success.main" : "warning.main"}
              node={node}
              discard={discard}
            />
          ) : (
            <Tooltip
              title={
                bubbledDraft === "new"
                  ? t("dashboard.context.tree.containsNew")
                  : t("dashboard.context.tree.containsUnsaved")
              }
            >
              <Box
                component="span"
                data-testid="tree-dir-draft-dot"
                aria-label={bubbledDraft === "new" ? "Contains a new file" : "Contains unsaved changes"}
                sx={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  bgcolor: bubbledDraft === "new" ? "success.main" : "warning.main",
                }}
              />
            </Tooltip>
          )
        ) : null}
        {actions &&
          loc &&
          !loc.actionsSuppressed &&
          (actions.onNewFile || (deleteAffordance && actions.onDeleteFolder)) && (
            <RowActionButtons
              showFile={Boolean(actions.onNewFile)}
              showFolder={Boolean(actions.onNewFile) && loc.folderAllowed}
              onFile={(anchor) =>
                actions.onNewFile?.(
                  { scope: scopeOf(scopeDir), baseDir: loc.fileBaseDir, presetKind: loc.fileKind },
                  anchor,
                )
              }
              onFolder={() => actions.startFolder(node.path)}
              onDelete={
                deleteAffordance && actions.onDeleteFolder
                  ? () => actions.onDeleteFolder!(deleteAffordance)
                  : undefined
              }
              testKey={node.path}
            />
          )}
      </Stack>
      <Collapse in={effectiveOpen} timeout="auto" unmountOnExit role="group">
        {actions && loc && namingFolder && (
          <NewFolderInput
            baseDir={loc.folderBaseDir}
            depth={depth + 1}
            existingPaths={actions.existingPaths}
            onConfirm={(name) => actions.confirmFolder(loc.folderBaseDir, name)}
            onCancel={actions.cancelFolder}
          />
        )}
        {node.children.map((child, index) => (
          <NodeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            forceOpen={forceOpen}
            actions={actions}
            discard={discard}
            scopeDir={scopeDir}
            position={{ setSize: node.children.length, posInset: index + 1 }}
          />
        ))}
        {node.excludedCount !== null && (
          <Typography
            variant="caption"
            sx={{
              display: "block",
              pl: `${(depth + 1) * INDENT_STEP + 44}px`,
              py: 0.5,
              fontStyle: "italic",
              color: "text.disabled",
            }}
          >
            ⋯ {t("dashboard.context.tree.excludedNote", { count: node.excludedCount })}
          </Typography>
        )}
      </Collapse>
    </Box>
  );
}

function FileRow({
  node,
  depth,
  selectedPath,
  onSelect,
  discard,
  position,
}: {
  node: Extract<TreeNode, { type: "file" }>;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  discard: DiscardBundle | null;
  position: TreePosition;
}) {
  const { t } = useTranslate();
  const treeItemProps = useTreeItemProps(node.path, depth, undefined, position);
  const selected = selectedPath === node.path;
  const shadowed = node.badges.find((b) => b.type === "shadowed");
  const misplaced = node.badges.find((b) => b.type === "misplaced");
  const deletedBadge = node.badges.find((b) => b.type === "deleted");
  const draftBadge = node.badges.find((b) => b.type === "dirty" || b.type === "new");
  const pendingPr = node.badges.find((b) => b.type === "pending-pr");
  return (
    <Box>
    <Stack
      direction="row"
      spacing={0.5}
      {...treeItemProps}
      aria-selected={selected}
      onClick={() => onSelect(node.path)}
      sx={{
        alignItems: "center",
        // +44 (not +42) so a file's label left-edge aligns exactly with a dir's
        // label at the same depth — the folder chevron/icon slots differ by 2px.
        pl: `${depth * INDENT_STEP + 44}px`,
        pr: 1,
        minHeight: ROW_HEIGHT,
        cursor: "pointer",
        borderRadius: 1,
        // Selection is the persistent state: the selected row carries the blue
        // tint AT REST; an unselected row only tints on hover (neutral). A
        // selected row deepens slightly on hover so it still reads as hovered.
        bgcolor: (theme) => (selected ? alpha(theme.palette.primary.main, 0.08) : "transparent"),
        "&:hover": {
          bgcolor: (theme) =>
            selected ? alpha(theme.palette.primary.main, 0.12) : theme.palette.action.hover,
        },
        ...TREE_ROW_FOCUS_SX,
      }}
    >
      <Iconify icon={KIND_ICON[node.kind]} width={18} sx={{ color: "text.secondary", flexShrink: 0 }} />
      {/* Annotations hug the name (left-packed row); the name keeps a 64px floor
          before a badge yields, and only truncates past that. */}
      <TruncatingName
        name={node.name}
        sx={{
          fontSize: 13,
          minWidth: 64,
          ...(deletedBadge ? { textDecoration: "line-through", color: "text.disabled" } : {}),
        }}
      />
      {node.mcpServerCount !== undefined && (
        <Typography variant="caption" sx={{ color: "text.disabled", flexShrink: 0 }}>
          {t("dashboard.context.tree.serverCount", { count: node.mcpServerCount })}
        </Typography>
      )}
      {deletedBadge ? (
        discard ? (
          <FileDiscardDot
            testId="tree-deleted-dot"
            tooltip={t("dashboard.context.tree.markedForDeletion")}
            size={8}
            color="error.main"
            path={node.path}
            changeType="delete"
            discard={discard}
          />
        ) : (
          <Tooltip title={t("dashboard.context.tree.markedForDeletion")}>
            <Box
              component="span"
              data-testid="tree-deleted-dot"
              aria-label="Marked for deletion"
              sx={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, bgcolor: "error.main" }}
            />
          </Tooltip>
        )
      ) : (
        draftBadge &&
        (discard ? (
          <FileDiscardDot
            testId={draftBadge.type === "new" ? "tree-new-dot" : "tree-dirty-dot"}
            tooltip={
              draftBadge.type === "new"
                ? t("dashboard.context.tree.newFile")
                : t("dashboard.context.tree.unsavedChanges")
            }
            size={8}
            color={draftBadge.type === "new" ? "success.main" : "warning.main"}
            path={node.path}
            changeType={draftBadge.type === "new" ? "create" : "edit"}
            discard={discard}
          />
        ) : (
          <Tooltip
            title={
              draftBadge.type === "new"
                ? t("dashboard.context.tree.newFile")
                : t("dashboard.context.tree.unsavedChanges")
            }
          >
            <Box
              component="span"
              data-testid={draftBadge.type === "new" ? "tree-new-dot" : "tree-dirty-dot"}
              aria-label={draftBadge.type === "new" ? "New file" : "Unsaved changes"}
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flexShrink: 0,
                bgcolor: draftBadge.type === "new" ? "success.main" : "warning.main",
              }}
            />
          </Tooltip>
        ))
      )}
      {!draftBadge && !deletedBadge && pendingPr && (
        <Tooltip title={t("dashboard.context.tree.submittedAsPr")}>
          <Typography
            component="span"
            variant="caption"
            data-testid="tree-pending-pr-tag"
            aria-label="Submitted as a pull request"
            sx={{ color: "text.disabled", fontWeight: 600, letterSpacing: 0.3, flexShrink: 0 }}
          >
            PR
          </Typography>
        </Tooltip>
      )}
      {shadowed && (
        <Tooltip title={shadowed.detail}>
          <Chip
            label={t("dashboard.context.tree.shadows")}
            size="small"
            variant="outlined"
            color="warning"
            sx={{ height: 20, flexShrink: 0 }}
          />
        </Tooltip>
      )}
      {misplaced && <MisplacedBadge detail={misplaced.detail} />}
      <Box sx={{ flexGrow: 1 }} />
    </Stack>
    </Box>
  );
}

function MissingSkillBadge({ detail }: { detail: string }) {
  return (
    <Tooltip title={detail}>
      <Box component="span" sx={{ display: "inline-flex", color: "warning.main" }} aria-label="missing SKILL.md">
        <Iconify icon="mdi:alert-outline" width={16} />
      </Box>
    </Tooltip>
  );
}

/** Warning triangle on a misplaced file — a nested subagent or an unnameable command namespace. */
function MisplacedBadge({ detail }: { detail: string }) {
  return (
    <Tooltip title={detail}>
      <Box component="span" sx={{ display: "inline-flex", color: "warning.main" }} aria-label="misplaced file">
        <Iconify icon="mdi:alert-outline" width={16} />
      </Box>
    </Tooltip>
  );
}

/** Prunes the model to files whose path/name contains `query`; keeps ancestor dirs of any match. */
function filterModel(model: ContextTreeModel, query: string): ContextTreeModel {
  if (query === "") return model;

  const pruneNodes = (nodes: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of nodes) {
      if (node.type === "file") {
        if (node.path.toLowerCase().includes(query)) out.push(node);
      } else {
        const kids = pruneNodes(node.children);
        if (kids.length > 0 || node.path.toLowerCase().includes(query)) {
          out.push({ ...node, children: kids });
        }
      }
    }
    return out;
  };

  return {
    scopes: model.scopes.map((s) => ({ ...s, children: pruneNodes(s.children) })),
  };
}
