"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Breadcrumbs,
  Button,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import dynamic from "next/dynamic";
import { useTranslate } from "@outerlayer/locales";
import type { ContextKind } from "@repo/context-core";
import type { ContextFileHandle } from "./types";
import { CodeEditor } from "./code-editor";
import { conformTrailingNewline, splitFrontmatter, joinFrontmatter } from "./split-frontmatter";
import { McpSummary, scopeBreadcrumb } from "../file-blocks";
import Iconify from "@/components/iconify";

// Milkdown/ProseMirror can only initialize against a real DOM — mount it
// client-only (its frozen contract). The named export needs the .then map.
const RichMarkdownEditor = dynamic(
  () =>
    import("@/features/context/components/rich-editor/rich-markdown-editor").then(
      (m) => m.RichMarkdownEditor,
    ),
  { ssr: false },
);

/**
 * Kinds the rich (Milkdown) surface can edit: the markdown kinds only. `mcp`
 * and `config` are JSON (raw-only); `external-instructions` is never editable.
 */
const RICH_CAPABLE_KINDS = new Set<ContextKind>([
  "instructions",
  "skill",
  "skill-reference",
  "command",
  "reference",
  "subagent",
]);

type EditMode = "raw" | "rich";

export interface ContextEditorProps {
  file: ContextFileHandle;
  /** Current buffered content — the file's draft when one exists, else its loaded bytes. */
  content: string;
  /** Lifts every content change to the draft-store owner (the page). */
  onContentChange: (content: string) => void;
  /**
   * Editor-as-viewer for users without `context.update` (and for kinds that
   * are never editable): same rendering, no dirty state, no edits emitted.
   */
  readOnly?: boolean;
  /** This file is an uncommitted `create` draft — drives the green `new` pill. */
  isCreateDraft?: boolean;
  /** Total staged drafts — the header Publish button's count badge. */
  draftCount?: number;
  /** Opens the publish dialog. The button renders only when drafts exist. */
  onPublish?: () => void;
  /** Open the delete confirm (inside the overflow menu). Rendered only when {@link canDelete}. */
  onDelete?: () => void;
  /** The user holds `context.delete` — gates the Delete affordance. */
  canDelete?: boolean;
}

/** Palette slot behind each kind's tinted mono chip. */
const KIND_CHIP_PALETTE: Record<
  ContextKind,
  "primary" | "info" | "secondary" | "warning" | "success" | "error"
> = {
  instructions: "primary",
  "external-instructions": "primary",
  skill: "info",
  "skill-reference": "info",
  command: "secondary",
  mcp: "warning",
  reference: "primary",
  subagent: "info",
  // `folder` (`.gitkeep` keeper) is never opened in the editor; present only to keep this map exhaustive.
  folder: "primary",
};

/** Mono tinted kind tag (`command`, `skill`, …) — chip-shaped, never interactive. */
function KindChip({ kind }: { kind: ContextKind }) {
  const slot = KIND_CHIP_PALETTE[kind];
  return (
    <Box
      component="span"
      data-testid="editor-kind-chip"
      sx={(theme) => ({
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: "18px",
        px: 1,
        py: "2px",
        borderRadius: 0.75,
        color: `${slot}.main`,
        border: "1px solid",
        borderColor: alpha(theme.palette[slot].main, 0.4),
        bgcolor: alpha(theme.palette[slot].main, 0.06),
        flexShrink: 0,
      })}
    >
      {kind}
    </Box>
  );
}

/** `edited` / `new` state pill: 6px dot + 12px label on a soft tinted track. */
function StatusPill({ variant }: { variant: "edited" | "new" }) {
  const { t } = useTranslate();
  const slot = variant === "new" ? "success" : "warning";
  return (
    <Stack
      direction="row"
      spacing={0.625}
      data-testid={variant === "new" ? "new-indicator" : "unsaved-indicator"}
      sx={(theme) => ({
        alignItems: "center",
        px: 1.25,
        py: "3px",
        borderRadius: 999,
        bgcolor: alpha(theme.palette[slot].main, 0.12),
        flexShrink: 0,
      })}
    >
      <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: `${slot}.main` }} />
      {/* Monospace 12px so the state tag and the kind chip read as one system. */}
      <Typography
        sx={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: `${slot}.main`, lineHeight: 1.4 }}
      >
        {variant === "new"
          ? t("dashboard.context.editor.statusNew")
          : t("dashboard.context.editor.statusEdited")}
      </Typography>
    </Stack>
  );
}

/**
 * Self-contained editor for one context file: a header (breadcrumb · kind chip
 * · edited/new pill · Rich⇄Raw · Publish · overflow) over the Raw/Rich
 * surfaces. Fully controlled — `content` in, `onContentChange` out — so the
 * page owns the multi-file draft buffer; publishing is the page's dialog.
 * Decoupled from the tab behind {@link ContextFileHandle}.
 */
export function ContextEditor({
  file,
  content,
  onContentChange,
  readOnly = false,
  isCreateDraft = false,
  draftCount = 0,
  onPublish,
  onDelete,
  canDelete,
}: ContextEditorProps) {
  // Raw⇄Rich surface swap. `content` is the single source of truth; both
  // surfaces read and write it, so a toggle never loses the buffer. Rich mode
  // is only offered for markdown kinds, and is the DEFAULT for them.
  const { t } = useTranslate();
  const richCapable = RICH_CAPABLE_KINDS.has(file.kind);
  const [editModeState, setEditModeState] = useState<EditMode>(
    richCapable ? "rich" : "raw",
  );
  const mode: EditMode = richCapable ? editModeState : "raw";

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // The rich surface edits the BODY ONLY — frontmatter is peeled off here and
  // re-attached verbatim on every change (its frozen contract; keeps unknown
  // keys intact and lets AGENTS.md never gain frontmatter). Frontmatter is
  // shown and edited only through the Raw surface.
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content), [content]);

  // Milkdown reads `value` once at mount, so we remount (bump the key) when we
  // enter rich mode or when `content` changes from OUTSIDE the rich surface.
  // Self-edits record `lastRichEmit` so they don't remount and lose the cursor.
  const [richKey, setRichKey] = useState(0);
  const lastRichEmitRef = useRef<string | null>(null);

  const enterRich = useCallback(() => {
    lastRichEmitRef.current = content;
    setRichKey((k) => k + 1);
    setEditModeState("rich");
  }, [content]);

  useEffect(() => {
    if (mode === "rich" && content !== lastRichEmitRef.current) {
      lastRichEmitRef.current = content;
      setRichKey((k) => k + 1);
    }
  }, [content, mode]);

  const onRichChange = useCallback(
    (nextBody: string) => {
      // Pin the rich output's trailing newline to the loaded file's so a no-op
      // round-trip of a newline-less file isn't a phantom edit (Milkdown always
      // appends one). Reference the ORIGINAL loaded bytes, not the live content.
      const loadedBody = splitFrontmatter(file.content).body;
      const next = joinFrontmatter(frontmatter, conformTrailingNewline(nextBody, loadedBody));
      lastRichEmitRef.current = next;
      onContentChange(next);
    },
    [frontmatter, file.content, onContentChange],
  );

  const changeMode = useCallback(
    (_e: unknown, next: EditMode | null) => {
      if (!next) return;
      if (next === "rich") enterRich();
      else setEditModeState("raw");
    },
    [enterRich],
  );

  const dirty = !readOnly && !isCreateDraft && content !== file.content;
  const segments = scopeBreadcrumb(file.path);
  const showOverflow = canDelete && onDelete;

  return (
    <Stack sx={{ height: "100%" }} data-testid="context-editor">
      {/* Editor chrome header */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          px: 2,
          minHeight: 52,
          borderBottom: 1,
          borderColor: "divider",
          flexWrap: "nowrap",
          alignItems: "center",
        }}
      >
        <Breadcrumbs
          separator="›"
          // Leaf-priority truncation: a deep path collapses its MIDDLE crumbs
          // to a single "…" rather than mangling every crumb to 1-2 chars — the
          // scope and the last two segments stay legible.
          maxItems={4}
          itemsBeforeCollapse={1}
          itemsAfterCollapse={2}
          sx={{
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            // Keep every segment on one line; let intermediate segments ellipsize
            // rather than wrap the path and push the right-side controls down.
            "& .MuiBreadcrumbs-ol": { flexWrap: "nowrap" },
            "& .MuiBreadcrumbs-li": { minWidth: 0, overflow: "hidden" },
          }}
          data-testid="editor-breadcrumb"
        >
          {segments.map((segment, index) => {
            const isLast = index === segments.length - 1;
            return (
              <Typography
                key={`${segment}-${index}`}
                variant="body2"
                noWrap
                color={isLast ? "text.primary" : "text.secondary"}
                sx={{
                  fontWeight: isLast ? 500 : 400,
                  // The leaf (filename) keeps priority — never shrinks, stays
                  // readable up to ~20ch then ellipsizes; ancestors keep a small
                  // floor so they degrade to a few chars + "…", never 1-2 chars.
                  ...(isLast
                    ? { flexShrink: 0, maxWidth: "20ch" }
                    : { minWidth: 40 }),
                }}
              >
                {segment === "" ? t("dashboard.context.repoRoot") : segment}
              </Typography>
            );
          })}
        </Breadcrumbs>

        <KindChip kind={file.kind} />

        {isCreateDraft ? <StatusPill variant="new" /> : dirty && <StatusPill variant="edited" />}

        <Box sx={{ flex: 1 }} />

        {richCapable && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            onChange={changeMode}
            aria-label="edit mode"
            data-testid="raw-rich-toggle"
            sx={{
              flexShrink: 0,
              // Match the Publish button height so the header controls align.
              "& .MuiToggleButton-root": {
                minWidth: 56,
                height: 34,
                px: 1.5,
                py: 0,
                fontSize: 13,
                fontWeight: 500,
                textTransform: "none",
              },
            }}
          >
            <ToggleButton value="rich" aria-label="rich">
              {t("dashboard.context.editor.rich")}
            </ToggleButton>
            <ToggleButton value="raw" aria-label="raw">
              {t("dashboard.context.editor.raw")}
            </ToggleButton>
          </ToggleButtonGroup>
        )}

        {draftCount > 0 && onPublish && (
          <Button
            variant="contained"
            size="small"
            onClick={onPublish}
            data-testid="editor-publish-button"
            sx={{ height: 34, textTransform: "none", fontSize: 13, fontWeight: 600, px: 1.75, gap: 1, flexShrink: 0 }}
          >
            {t("dashboard.context.editor.publishChanges")}
            <Box
              component="span"
              data-testid="editor-publish-count"
              sx={(theme) => ({
                bgcolor: alpha(theme.palette.primary.contrastText, 0.25),
                borderRadius: 999,
                px: 0.875,
                fontSize: 12,
                lineHeight: "18px",
              })}
            >
              {draftCount}
            </Box>
          </Button>
        )}

        {/* Permission-hiding: no overflow at all without a delete grant. */}
        {showOverflow && (
          <>
            <IconButton
              size="small"
              onClick={(e) => setMenuAnchor(e.currentTarget)}
              aria-label="More actions"
              data-testid="editor-overflow-button"
              sx={{
                width: 32,
                height: 32,
                flexShrink: 0,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Iconify icon="mdi:dots-horizontal" width={18} />
            </IconButton>
            <Menu
              anchorEl={menuAnchor}
              open={menuAnchor !== null}
              onClose={() => setMenuAnchor(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
              transformOrigin={{ vertical: "top", horizontal: "right" }}
            >
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  onDelete();
                }}
                data-testid="context-delete-button"
                sx={{ color: "error.main" }}
              >
                <ListItemIcon sx={{ color: "error.main" }}>
                  <Iconify icon="mdi:trash-can-outline" width={18} />
                </ListItemIcon>
                <ListItemText>{t("dashboard.context.editor.delete")}</ListItemText>
              </MenuItem>
            </Menu>
          </>
        )}
      </Stack>

      {mode === "rich" ? (
        // Body-only rich surface under its fixed formatting toolbar — the
        // editor owns the scroll so the toolbar row never moves. Frontmatter is
        // not rendered here; the Raw surface shows the whole file.
        <Box sx={{ flex: 1, minHeight: 240, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <RichMarkdownEditor
            key={richKey}
            value={body}
            onChange={onRichChange}
            toolbar={!readOnly}
            readOnly={readOnly}
          />
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 240, overflow: "auto" }}>
          {file.kind === "mcp" && (
            <Box sx={{ p: 2, pb: 0 }}>
              <McpSummary content={content} />
            </Box>
          )}
          <CodeEditor
            kind={file.kind}
            value={content}
            onChange={onContentChange}
            readOnly={readOnly}
            lintContext={{ dirName: file.skillDirName, fileStem: file.fileStem }}
          />
        </Box>
      )}
    </Stack>
  );
}
