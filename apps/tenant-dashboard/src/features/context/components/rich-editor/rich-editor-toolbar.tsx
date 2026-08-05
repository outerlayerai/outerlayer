"use client";

/**
 * Fixed formatting toolbar for the rich (Milkdown) surface. Grouped formatting /
 * heading / list / block / insert actions plus undo/redo, each dispatched
 * through Milkdown's command API (`commandsCtx`) against the editor instance
 * provided by the surrounding `<MilkdownProvider>`. Rich-mode only: the raw
 * CodeMirror surface never renders it.
 *
 * The editor is refocused after every command so a toolbar click doesn't leave
 * the caret stranded in the button.
 *
 * The Link action is special: it opens an anchored URL popover (set / update /
 * remove the link) instead of inserting an empty `[text]()`, and is disabled
 * when there is neither a selection to wrap nor a link under the cursor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import { commandsCtx, editorViewCtx, type CmdKey } from "@milkdown/core";
import { listenerCtx } from "@milkdown/plugin-listener";
import { useInstance } from "@milkdown/react";
import {
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import { redoCommand, undoCommand } from "@milkdown/plugin-history";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import {
  applyLink,
  handleLinkClick,
  isLinkTargetAbsent,
  readLinkContext,
  removeLinkAt,
  type LinkClickHandlers,
  type LinkClickTarget,
  type LinkContext,
} from "./link-command";

interface ToolbarAction {
  /** Literal English, kept as the assistive aria-label (house pattern leaves aria-labels untranslated). */
  label: string;
  /** i18n key for the visible tooltip. */
  labelKey: string;
  icon: string;
  /** Command dispatch for a normal action; absent on the Link action, which opens a popover. */
  run?: (call: <T>(key: CmdKey<T>, payload?: T) => void) => void;
  /** The Link action opens the URL popover instead of dispatching a command. */
  openLink?: boolean;
}

/** Button groups, rendered in order with a divider between groups. */
const GROUPS: ToolbarAction[][] = [
  [
    { label: "Bold", labelKey: "dashboard.context.toolbar.bold", icon: "mdi:format-bold", run: (call) => call(toggleStrongCommand.key) },
    { label: "Italic", labelKey: "dashboard.context.toolbar.italic", icon: "mdi:format-italic", run: (call) => call(toggleEmphasisCommand.key) },
    {
      label: "Strikethrough",
      labelKey: "dashboard.context.toolbar.strikethrough",
      icon: "mdi:format-strikethrough-variant",
      run: (call) => call(toggleStrikethroughCommand.key),
    },
    { label: "Inline code", labelKey: "dashboard.context.toolbar.inlineCode", icon: "mdi:code-tags", run: (call) => call(toggleInlineCodeCommand.key) },
  ],
  [
    { label: "Heading 1", labelKey: "dashboard.context.toolbar.heading1", icon: "mdi:format-header-1", run: (call) => call(wrapInHeadingCommand.key, 1) },
    { label: "Heading 2", labelKey: "dashboard.context.toolbar.heading2", icon: "mdi:format-header-2", run: (call) => call(wrapInHeadingCommand.key, 2) },
    { label: "Heading 3", labelKey: "dashboard.context.toolbar.heading3", icon: "mdi:format-header-3", run: (call) => call(wrapInHeadingCommand.key, 3) },
    { label: "Body text", labelKey: "dashboard.context.toolbar.bodyText", icon: "mdi:format-paragraph", run: (call) => call(turnIntoTextCommand.key) },
  ],
  [
    { label: "Bullet list", labelKey: "dashboard.context.toolbar.bulletList", icon: "mdi:format-list-bulleted", run: (call) => call(wrapInBulletListCommand.key) },
    { label: "Numbered list", labelKey: "dashboard.context.toolbar.numberedList", icon: "mdi:format-list-numbered", run: (call) => call(wrapInOrderedListCommand.key) },
  ],
  [
    { label: "Quote", labelKey: "dashboard.context.toolbar.quote", icon: "mdi:format-quote-close", run: (call) => call(wrapInBlockquoteCommand.key) },
    { label: "Code block", labelKey: "dashboard.context.toolbar.codeBlock", icon: "mdi:code-braces", run: (call) => call(createCodeBlockCommand.key) },
  ],
  [
    { label: "Link", labelKey: "dashboard.context.toolbar.link", icon: "mdi:link-variant", openLink: true },
    { label: "Table", labelKey: "dashboard.context.toolbar.table", icon: "mdi:table", run: (call) => call(insertTableCommand.key, { row: 3, col: 3 }) },
    { label: "Divider", labelKey: "dashboard.context.toolbar.divider", icon: "mdi:minus", run: (call) => call(insertHrCommand.key) },
  ],
  [
    { label: "Undo", labelKey: "dashboard.context.toolbar.undo", icon: "mdi:undo", run: (call) => call(undoCommand.key) },
    { label: "Redo", labelKey: "dashboard.context.toolbar.redo", icon: "mdi:redo", run: (call) => call(redoCommand.key) },
  ],
];

const NO_LINK: LinkContext = { hasSelection: false, existingHref: null };

export function RichEditorToolbar({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslate();
  const [loading, getEditor] = useInstance();

  const [linkAnchor, setLinkAnchor] = useState<HTMLElement | null>(null);
  // A click on a link in the prose anchors the popover to the click coordinates
  // (there is no button element to anchor to); the toolbar Link button uses
  // `linkAnchor` instead. At most one is set at a time.
  const [linkAnchorPosition, setLinkAnchorPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [linkHref, setLinkHref] = useState("");
  // Live selection/link state drives the Link button's disabled state and the
  // popover's Remove affordance. Updated on every selection change.
  const [linkContext, setLinkContext] = useState<LinkContext>(NO_LINK);
  const subscribedRef = useRef(false);

  // Subscribe once per editor instance: the selection listener has no unsubscribe
  // API, and the whole toolbar unmounts with its MilkdownProvider on mode switch,
  // so the listener is discarded with the editor it belongs to.
  useEffect(() => {
    if (subscribedRef.current) return;
    const editor = getEditor();
    if (!editor) return;
    subscribedRef.current = true;
    editor.action((ctx) => {
      ctx.get(listenerCtx).selectionUpdated((selCtx, selection) => {
        // Use the callback's selection: `view.state` is still the pre-change
        // state while this fires (inside the plugin's `state.apply`).
        setLinkContext(readLinkContext(selCtx.get(editorViewCtx).state, selection));
      });

      // Intercept clicks on link marks so they never navigate: a live `<a href>`
      // click (an empty `[text]()` reloads the current page) would otherwise trip
      // the unsaved-changes guard and discard the draft. Plain click opens the
      // editor popover for that link; mod-click opens a real href in a new tab.
      const view = ctx.get(editorViewCtx);
      view.setProps({
        handleDOMEvents: {
          ...(view.props.handleDOMEvents ?? {}),
          click: (v, event) => {
            const mouse = event as MouseEvent;
            if (mouse.button !== 0) return false;
            const at = v.posAtCoords({ left: mouse.clientX, top: mouse.clientY });
            if (!at) return false;
            const linkClickHandlers: LinkClickHandlers = {
              openInNewTab: (href) => window.open(href, "_blank", "noopener,noreferrer"),
              openLinkEditor: (target: LinkClickTarget) => {
                setLinkContext({ hasSelection: false, existingHref: target.href });
                setLinkHref(target.href);
                setLinkAnchor(null);
                setLinkAnchorPosition({ top: mouse.clientY, left: mouse.clientX });
              },
            };
            const handled = handleLinkClick(
              v.state,
              at.pos,
              mouse.metaKey || mouse.ctrlKey,
              linkClickHandlers,
            );
            if (!handled) return false;
            event.preventDefault();
            return true;
          },
        },
      });
    });
  }, [getEditor, loading]);

  const dispatch = useCallback(
    (action: ToolbarAction) => {
      const editor = getEditor();
      if (!editor || !action.run) return;
      editor.action((ctx) => {
        const commands = ctx.get(commandsCtx);
        action.run?.((key, payload) => commands.call(key, payload));
        // Hand focus back to the prose surface so typing continues immediately.
        ctx.get(editorViewCtx).focus();
      });
    },
    [getEditor],
  );

  const openLinkPopover = useCallback(
    (anchor: HTMLElement) => {
      const editor = getEditor();
      if (!editor) return;
      let context: LinkContext = NO_LINK;
      editor.action((ctx) => {
        context = readLinkContext(ctx.get(editorViewCtx).state);
      });
      if (isLinkTargetAbsent(context)) return;
      setLinkContext(context);
      setLinkHref(context.existingHref ?? "");
      setLinkAnchorPosition(null);
      setLinkAnchor(anchor);
    },
    [getEditor],
  );

  const closeLinkPopover = useCallback(() => {
    setLinkAnchor(null);
    setLinkAnchorPosition(null);
  }, []);

  const applyLinkHref = useCallback(() => {
    const editor = getEditor();
    if (editor) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        applyLink(view, ctx.get(commandsCtx), linkHref);
        view.focus();
      });
    }
    closeLinkPopover();
  }, [getEditor, linkHref, closeLinkPopover]);

  const removeLink = useCallback(() => {
    const editor = getEditor();
    if (editor) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        removeLinkAt(view);
        view.focus();
      });
    }
    closeLinkPopover();
  }, [getEditor, closeLinkPopover]);

  return (
    <Stack
      direction="row"
      data-testid="rich-editor-toolbar"
      sx={{
        alignItems: "center",
        flexWrap: "wrap",
        gap: 0.25,
        px: 1,
        py: 0.5,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
      }}
    >
      {GROUPS.map((group, groupIndex) => (
        <Stack key={groupIndex} direction="row" sx={{ alignItems: "center", gap: 0.25 }}>
          {groupIndex > 0 && (
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />
          )}
          {group.map((action) => (
            <Tooltip key={action.label} title={t(action.labelKey)}>
              <span>
                <IconButton
                  size="small"
                  aria-label={action.label}
                  disabled={
                    disabled ||
                    loading ||
                    (action.openLink ? isLinkTargetAbsent(linkContext) : false)
                  }
                  onClick={(e) =>
                    action.openLink ? openLinkPopover(e.currentTarget) : dispatch(action)
                  }
                >
                  <Iconify icon={action.icon} width={18} />
                </IconButton>
              </span>
            </Tooltip>
          ))}
        </Stack>
      ))}

      <Popover
        open={linkAnchor !== null || linkAnchorPosition !== null}
        anchorReference={linkAnchorPosition !== null ? "anchorPosition" : "anchorEl"}
        anchorEl={linkAnchor}
        anchorPosition={linkAnchorPosition ?? undefined}
        onClose={closeLinkPopover}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        data-testid="link-url-popover"
      >
        <Box sx={{ p: 1.5, width: 320 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label={t("dashboard.context.editor.linkUrlLabel")}
            placeholder={t("dashboard.context.editor.linkUrlPlaceholder")}
            value={linkHref}
            onChange={(e) => setLinkHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLinkHref();
              }
            }}
            data-testid="link-url-input"
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, justifyContent: "flex-end" }}>
            {linkContext.existingHref !== null && (
              <Button color="error" onClick={removeLink} data-testid="link-remove">
                {t("dashboard.context.editor.linkRemove")}
              </Button>
            )}
            <Button variant="contained" onClick={applyLinkHref} data-testid="link-apply">
              {t("dashboard.context.editor.linkApply")}
            </Button>
          </Stack>
        </Box>
      </Popover>
    </Stack>
  );
}
