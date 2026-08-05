"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { structuredPatch } from "diff";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import { classifyTree, type ContextKind, type FieldIssue } from "@repo/context-core";
import type { ContextBatchFileConflict } from "@/lib/adapters/context-save";
import type { ContextDraft } from "../use-context-drafts";
import { validateDraftContent } from "../draft-validation";

/** Server caps the commit-message subject at one 200-char line. */
const COMMIT_MESSAGE_MAX = 200;
const DEFAULT_COMMIT_MESSAGE = "Update context files";

const KIND_ICON: Record<ContextKind, string> = {
  instructions: "mdi:file-document-outline",
  "external-instructions": "mdi:file-document-outline",
  skill: "mdi:star-four-points-outline",
  "skill-reference": "mdi:note-text-outline",
  command: "mdi:console-line",
  reference: "mdi:note-text-outline",
  mcp: "mdi:power-plug-outline",
  subagent: "mdi:robot-outline",
  folder: "mdi:folder-outline",
};

export interface PublishDialogProps {
  open: boolean;
  /** Drafts to publish, in list order. */
  drafts: ContextDraft[];
  /** Target branch the direct option lands on. */
  branch: string;
  /**
   * App settings force a pull request. Where changes land is admin policy,
   * not a per-publish choice — the dialog only states the outcome.
   */
  requirePullRequest?: boolean;
  /** Per-path conflict surfaced by the last failed publish attempt. */
  conflicts?: Record<string, ContextBatchFileConflict>;
  /**
   * Server-side validation errors from the last publish attempt, per path.
   * Merged with (and deduped against) the client's own checks so a server-only
   * failure blocks its row exactly like a client one.
   */
  fileErrors?: Array<{ path: string; errors: FieldIssue[] }>;
  /** Per-path message when a conflict-row Refresh failed to read the remote. */
  refreshErrors?: Record<string, string>;
  /** A publish request is in flight. */
  publishing?: boolean;
  /** Path currently being refreshed against the remote (disables that row). */
  refreshingPath?: string | null;
  /** Server error (git failure / permission denial) from the last attempt. */
  errorMessage?: string | null;
  onDiscardDraft: (path: string) => void;
  onRefreshDraft: (path: string) => void;
  /** Convert a draft whose remote file was deleted into a fresh `create`. */
  onRestoreAsNew: (path: string) => void;
  onDiscardAll: () => void;
  /** Publish the checked subset as one commit. */
  onPublish: (message: string, paths: string[]) => void;
  onClose: () => void;
}

/** Dedupes field issues by `path:code`, preserving first-seen order. */
function dedupeIssues(issues: FieldIssue[]): FieldIssue[] {
  const seen = new Set<string>();
  const out: FieldIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** Humanized, publish-as-is copy for a warning-tier issue. */
function warningCopyKey(issue: FieldIssue): string {
  if (issue.path === "description") return "dashboard.context.publish.warnDescription";
  return "dashboard.context.publish.warnGeneric";
}

function conflictTextKey(reason: ContextBatchFileConflict["reason"]): string {
  switch (reason) {
    case "modified":
      return "dashboard.context.publish.conflictModified";
    case "deleted":
      return "dashboard.context.publish.conflictDeleted";
    case "exists":
      return "dashboard.context.publish.conflictExists";
  }
}

interface DiffLine {
  sign: " " | "+" | "-" | "@";
  text: string;
}

/** Unified diff of one draft against its loaded base, flattened for rendering. */
function draftDiff(draft: ContextDraft): { lines: DiffLine[]; adds: number; dels: number } {
  const patch = structuredPatch(draft.path, draft.path, draft.baseContent, draft.content, "", "");
  const lines: DiffLine[] = [];
  let adds = 0;
  let dels = 0;
  for (const hunk of patch.hunks) {
    lines.push({
      sign: "@",
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === "+") adds += 1;
      if (sign === "-") dels += 1;
      lines.push({
        sign: sign === "+" || sign === "-" ? sign : " ",
        text: line.slice(1),
      });
    }
  }
  return { lines, adds, dels };
}

function DiffPanel({ lines }: { lines: DiffLine[] }) {
  return (
    <Box
      data-testid="publish-row-diff"
      sx={{ borderTop: "1px solid", borderColor: "divider", maxHeight: 280, overflow: "auto" }}
    >
      {lines.map((line, i) => (
        <Stack
          key={i}
          direction="row"
          sx={(theme) => ({
            bgcolor:
              line.sign === "@"
                ? alpha(theme.palette.primary.main, 0.08)
                : line.sign === "+"
                  ? alpha(theme.palette.success.main, 0.12)
                  : line.sign === "-"
                    ? alpha(theme.palette.error.main, 0.1)
                    : "transparent",
          })}
        >
          <Typography
            component="span"
            sx={(theme) => ({
              width: 28,
              flexShrink: 0,
              textAlign: "center",
              fontFamily: "monospace",
              fontSize: 12,
              lineHeight: "22px",
              opacity: 0.7,
              color:
                line.sign === "@"
                  ? "primary.main"
                  : line.sign === "+"
                    ? theme.palette.success.dark
                    : line.sign === "-"
                      ? theme.palette.error.dark
                      : "text.secondary",
            })}
          >
            {line.sign === "@" ? "" : line.sign === "-" ? "−" : line.sign.trim()}
          </Typography>
          <Typography
            component="span"
            sx={(theme) => ({
              fontFamily: "monospace",
              fontSize: 12,
              lineHeight: "22px",
              whiteSpace: "pre",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color:
                line.sign === "@"
                  ? "primary.main"
                  : line.sign === "+"
                    ? theme.palette.success.dark
                    : line.sign === "-"
                      ? theme.palette.error.dark
                      : "text.secondary",
            })}
          >
            {line.sign === "@" ? line.text : line.text || " "}
          </Typography>
        </Stack>
      ))}
    </Box>
  );
}

/**
 * Reviews the staged drafts before publishing them as ONE commit: a checkbox
 * row per draft (kind icon · name · new chip · path · +/− stats · expandable
 * diff), and a commit-message field. Where the commit lands is app policy —
 * direct to the connected branch, or a pull request when the app's settings
 * require one (stated, never chosen here). Unchecked rows stay drafts. Invalid
 * and conflicted rows can't be published — they're force-unchecked and say
 * why; conflicted rows offer Refresh (adopt the new remote base) or discard.
 */
export function PublishDialog({
  open,
  drafts,
  branch,
  requirePullRequest = false,
  conflicts = {},
  fileErrors = [],
  refreshErrors = {},
  publishing = false,
  refreshingPath = null,
  errorMessage = null,
  onDiscardDraft,
  onRefreshDraft,
  onRestoreAsNew,
  onDiscardAll,
  onPublish,
  onClose,
}: PublishDialogProps) {
  const { t } = useTranslate();
  const [message, setMessage] = useState(DEFAULT_COMMIT_MESSAGE);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  // Fresh dialog per open: default message, all rows checked.
  useEffect(() => {
    if (open) {
      setMessage(DEFAULT_COMMIT_MESSAGE);
      setUnchecked(new Set());
      setExpandedPath(null);
    }
  }, [open]);

  // Every row drained while open (e.g. a conflict-row Refresh dropped the last
  // draft) — close instead of sitting on "Publish 0 changes".
  useEffect(() => {
    if (open && drafts.length === 0) onClose();
  }, [open, drafts.length, onClose]);

  const serverErrorsByPath = useMemo(() => {
    const map = new Map<string, FieldIssue[]>();
    for (const entry of fileErrors) map.set(entry.path, entry.errors);
    return map;
  }, [fileErrors]);

  const rows = useMemo(() => {
    // A closed dialog still receives a fresh `drafts` array from the parent on
    // every draft edit — the diff/validation work below is pointless while
    // nothing's visible, and rows are always recomputed at open time (see the
    // "Fresh dialog per open" effect above).
    if (!open) return [];
    return drafts.map((draft) => {
      const isDelete = draft.changeType === "delete";
      const { lines, adds, dels } = draftDiff(draft);
      // Two tiers from the shared validator: hard errors block the row;
      // warnings (empty description and other fixable field lints) publish
      // as-is. Server-reported errors are all hard, merged and deduped by
      // code+path so an issue caught on both sides shows once. A delete
      // writes no content, so it's never content-validated — only a conflict
      // can block it.
      const clientResult = isDelete
        ? { errors: [], warnings: [] }
        : validateDraftContent(draft.path, draft.content);
      const errors = dedupeIssues([
        ...clientResult.errors,
        ...(serverErrorsByPath.get(draft.path) ?? []),
      ]);
      const warnings = dedupeIssues(clientResult.warnings);
      const kind = classifyTree([draft.path]).entries[0]?.kind ?? ("reference" as ContextKind);
      // A `.gitkeep` create is a folder, not a file: label it by the folder it
      // keeps (`guides/`) under that folder's parent, never the bare filename.
      const isFolder = kind === "folder";
      const folderDir = draft.path.split("/").slice(0, -1).join("/");
      return {
        draft,
        isDelete,
        isFolder,
        name: isFolder ? `${folderDir.split("/").pop() ?? ""}/` : (draft.path.split("/").pop() ?? draft.path),
        parent: isFolder ? folderDir.split("/").slice(0, -1).join("/") : draft.path.split("/").slice(0, -1).join("/"),
        kind,
        lines,
        adds,
        dels,
        errors,
        warnings,
        conflict: conflicts[draft.path] ?? null,
      };
    });
  }, [open, drafts, conflicts, serverErrorsByPath]);

  const publishable = rows.filter((r) => r.errors.length === 0 && r.conflict === null);
  const checkedPaths = publishable
    .map((r) => r.draft.path)
    .filter((path) => !unchecked.has(path));
  const publishDisabled = publishing || checkedPaths.length === 0;

  const toggleChecked = useCallback((path: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      data-testid="publish-dialog"
      aria-labelledby="publish-dialog-title"
      slotProps={{ paper: { sx: { borderRadius: 1.25, p: 3 } } }}
    >
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
          <Typography id="publish-dialog-title" sx={{ fontSize: 17, fontWeight: 600 }}>{t("dashboard.context.publish.title")}</Typography>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }} data-testid="publish-subtitle">
            {checkedPaths.length < drafts.length
              ? t("dashboard.context.publish.subtitlePartial", {
                  current: checkedPaths.length,
                  total: drafts.length,
                  branch,
                })
              : t("dashboard.context.publish.subtitleAll", {
                  count: checkedPaths.length,
                  branch,
                })}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <IconButton size="small" onClick={onClose} aria-label="Close" data-testid="publish-close">
            <Iconify icon="mdi:close" width={20} />
          </IconButton>
        </Stack>

        {errorMessage && (
          <Alert severity="error" data-testid="publish-error">
            {errorMessage}
          </Alert>
        )}

        <Stack spacing={0.75} data-testid="publish-file-list">
          {rows.map(({ draft, isDelete, isFolder, name, parent, kind, lines, adds, dels, errors, warnings, conflict }) => {
            const blocked = errors.length > 0 || conflict !== null;
            // Unknown-key notes are advisory and stay silent (as before); only
            // actionable field warnings surface amber.
            const shownWarnings = warnings.filter((w) => w.code !== "unknown_key");
            const checked = !blocked && !unchecked.has(draft.path);
            const expanded = expandedPath === draft.path;
            const refreshError = refreshErrors[draft.path];
            return (
              <Box
                key={draft.path}
                data-testid="publish-file-row"
                sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}
              >
                <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", px: 1.5, py: 1.125 }}>
                  <Checkbox
                    size="small"
                    checked={checked}
                    disabled={blocked || publishing}
                    onChange={() => toggleChecked(draft.path)}
                    sx={{ p: 0 }}
                    slotProps={{ input: { "aria-label": `Publish ${draft.path}` } }}
                    data-testid="publish-row-checkbox"
                  />
                  <Iconify icon={KIND_ICON[kind]} width={16} sx={{ color: "text.secondary", flexShrink: 0 }} />
                  <Tooltip title={draft.path}>
                    <Typography
                      sx={{
                        fontSize: 13,
                        fontWeight: 500,
                        flexShrink: 0,
                        // A marked-for-deletion row reads as struck through, matching the tree.
                        ...(isDelete ? { textDecoration: "line-through", color: "text.secondary" } : {}),
                      }}
                    >
                      {name}
                    </Typography>
                  </Tooltip>
                  {draft.changeType === "create" && (
                    <Box
                      component="span"
                      data-testid="publish-row-new-chip"
                      sx={(theme) => ({
                        fontSize: 11,
                        fontWeight: 600,
                        color: "success.main",
                        bgcolor: alpha(theme.palette.success.main, 0.12),
                        borderRadius: 999,
                        px: 1,
                        lineHeight: "18px",
                        flexShrink: 0,
                      })}
                    >
                      {t(isFolder ? "dashboard.context.publish.newFolderChip" : "dashboard.context.publish.newChip")}
                    </Box>
                  )}
                  {isDelete && (
                    <Box
                      component="span"
                      data-testid="publish-row-deleted-chip"
                      sx={(theme) => ({
                        fontSize: 11,
                        fontWeight: 600,
                        color: "error.main",
                        bgcolor: alpha(theme.palette.error.main, 0.12),
                        borderRadius: 999,
                        px: 1,
                        lineHeight: "18px",
                        flexShrink: 0,
                      })}
                    >
                      {t("dashboard.context.publish.deletedChip")}
                    </Box>
                  )}
                  <Tooltip title={draft.path}>
                    <Typography
                      sx={{
                        fontSize: 12,
                        color: "text.disabled",
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {parent}
                    </Typography>
                  </Tooltip>
                  {/* A delete only ever removes lines — the +adds stat is always
                      zero, so it's suppressed and only the −N removal count shows. */}
                  {!isDelete && (
                    <Typography
                      sx={{ fontFamily: "monospace", fontSize: 11, color: "success.main", flexShrink: 0 }}
                      data-testid="publish-row-adds"
                    >
                      +{adds}
                    </Typography>
                  )}
                  <Typography
                    sx={{ fontFamily: "monospace", fontSize: 11, color: "error.main", flexShrink: 0 }}
                    data-testid="publish-row-dels"
                  >
                    −{dels}
                  </Typography>
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => setExpandedPath(expanded ? null : draft.path)}
                    sx={{ fontSize: 12, flexShrink: 0 }}
                    data-testid="publish-row-diff-toggle"
                  >
                    {t("dashboard.context.publish.diff")}
                  </Link>
                  <Tooltip title={t("dashboard.context.publish.discardTooltip")}>
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => onDiscardDraft(draft.path)}
                        disabled={publishing}
                        aria-label={`Discard ${draft.path}`}
                        data-testid="publish-row-discard"
                        sx={{ p: 0.25 }}
                      >
                        <Iconify icon="mdi:close" width={16} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>

                {conflict ? (
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: "center", px: 1.5, pb: 1, mt: -0.5 }}
                    data-testid="publish-row-conflict"
                  >
                    <Typography sx={{ fontSize: 12, color: "warning.main", flexGrow: 1 }}>
                      {isDelete && conflict.reason === "modified"
                        ? t("dashboard.context.publish.conflictDeleteModified")
                        : t(conflictTextKey(conflict.reason))}
                    </Typography>
                    {/* "Keep as new" re-commits the buffer as fresh content — meaningless
                        for a delete draft, which never carries buffered content. */}
                    {conflict.reason === "deleted" && !isDelete && (
                      <Button
                        size="small"
                        onClick={() => onRestoreAsNew(draft.path)}
                        disabled={refreshingPath === draft.path}
                        startIcon={<Iconify icon="mdi:file-plus-outline" width={16} />}
                        data-testid="publish-row-restore-new"
                      >
                        {t("dashboard.context.publish.keepAsNew")}
                      </Button>
                    )}
                    {isDelete && conflict.reason === "modified" && (
                      <Button
                        size="small"
                        onClick={() => onDiscardDraft(draft.path)}
                        disabled={refreshingPath === draft.path}
                        startIcon={<Iconify icon="mdi:file-undo-outline" width={16} />}
                        data-testid="publish-row-restore-delete"
                      >
                        {t("dashboard.context.publish.restoreDraft")}
                      </Button>
                    )}
                    <Button
                      size="small"
                      onClick={() => onRefreshDraft(draft.path)}
                      loading={refreshingPath === draft.path}
                      startIcon={<Iconify icon="mdi:refresh" width={16} />}
                      data-testid="publish-row-refresh"
                    >
                      {isDelete && conflict.reason === "modified"
                        ? t("dashboard.context.publish.confirmDelete")
                        : t("dashboard.context.publish.refresh")}
                    </Button>
                  </Stack>
                ) : errors.length > 0 ? (
                  <Stack spacing={0.25} sx={{ px: 1.5, pb: 1, mt: -0.5 }} data-testid="publish-row-invalid">
                    {errors.map((issue) => (
                      <Typography key={`${issue.path}:${issue.code}`} sx={{ fontSize: 12, color: "error.main" }}>
                        {issue.path}: {issue.message}
                      </Typography>
                    ))}
                  </Stack>
                ) : (
                  shownWarnings.length > 0 && (
                    <Stack spacing={0.25} sx={{ px: 1.5, pb: 1, mt: -0.5 }} data-testid="publish-row-warning">
                      {shownWarnings.map((issue) => (
                        <Stack
                          key={`${issue.path}:${issue.code}`}
                          direction="row"
                          spacing={0.5}
                          sx={{ alignItems: "center" }}
                        >
                          <Iconify
                            icon="mdi:alert-outline"
                            width={14}
                            sx={{ color: "warning.main", flexShrink: 0 }}
                          />
                          <Typography sx={{ fontSize: 12, color: "warning.main" }}>
                            {t(warningCopyKey(issue), { field: issue.path })}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  )
                )}

                {/* Any unchecked row — user choice or blocked — states the consequence plainly. */}
                {!checked && (
                  <Typography
                    sx={{ fontSize: 12, color: "text.secondary", px: 1.5, pb: 1, mt: -0.5 }}
                    data-testid="publish-row-excluded-hint"
                  >
                    {t("dashboard.context.publish.excludedHint")}
                  </Typography>
                )}

                {refreshError && (
                  <Typography
                    data-testid="publish-row-refresh-error"
                    sx={{ fontSize: 12, color: "error.main", px: 1.5, pb: 1, mt: -0.5 }}
                  >
                    {refreshError}
                  </Typography>
                )}

                {expanded && <DiffPanel lines={lines} />}
              </Box>
            );
          })}
        </Stack>

        <TextField
          label={t("dashboard.context.publish.commitMessageLabel")}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          fullWidth
          size="small"
          slotProps={{
            htmlInput: { maxLength: COMMIT_MESSAGE_MAX, "data-testid": "publish-message-input" },
          }}
        />

        {requirePullRequest && (
          <Stack
            direction="row"
            spacing={1}
            data-testid="publish-outcome-pr"
            sx={{ alignItems: "center", color: "text.secondary" }}
          >
            <Iconify icon="mdi:source-pull" width={16} />
            <Typography sx={{ fontSize: 12 }}>
              {t("dashboard.context.publish.outcomePr")}
            </Typography>
          </Stack>
        )}

        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Button
            color="inherit"
            onClick={onDiscardAll}
            disabled={publishing}
            data-testid="publish-discard-all"
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            {t("dashboard.context.publish.discardAll")}
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={onClose} disabled={publishing} data-testid="publish-cancel">
            {t("dashboard.context.publish.cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={() => onPublish(message.trim() || DEFAULT_COMMIT_MESSAGE, checkedPaths)}
            disabled={publishDisabled}
            loading={publishing}
            startIcon={<Iconify icon="mdi:rocket-launch-outline" width={16} />}
            data-testid="publish-submit"
            sx={{ textTransform: "none", fontWeight: 600 }}
          >
            {publishing
              ? t("dashboard.context.publish.publishing")
              : t("dashboard.context.publish.submit", { count: checkedPaths.length })}
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}
