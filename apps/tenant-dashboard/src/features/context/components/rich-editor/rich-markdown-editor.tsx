"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { editorViewCtx } from "@milkdown/core";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTranslate } from "@outerlayer/locales";
import { configureRichEditor } from "./create-rich-editor";
import { RichEditorToolbar } from "./rich-editor-toolbar";

/**
 * Frozen props contract (consolidation consumes this — see plan P4).
 *
 * `value` is the markdown *body only*: frontmatter is stripped upstream and never
 * reaches this component. It is applied at mount (Milkdown reads it once); render
 * the component with a React `key` tied to the document identity to reload it.
 *
 * The consumer is responsible for mounting this client-only (e.g. `next/dynamic`
 * with `ssr: false`); the component additionally no-ops on the server.
 */
export interface RichMarkdownEditorProps {
  /** Markdown body to edit. Applied on mount. */
  value: string;
  /** Fired (coalesced, not per-keystroke) with the edited markdown. */
  onChange: (markdown: string) => void;
  /** When true, the surface renders content but rejects user edits. */
  readOnly?: boolean;
  /** Fired once after the editor view has mounted. */
  onReady?: () => void;
  /**
   * Render the fixed formatting toolbar above the surface. With
   * the toolbar the component owns its scroll (flex column: fixed toolbar +
   * scrolling prose); without it, the caller's container scrolls as before.
   */
  toolbar?: boolean;
}

function RichMarkdownEditorInner({
  value,
  onChange,
  readOnly = false,
  onReady,
}: Omit<RichMarkdownEditorProps, "toolbar">): React.JSX.Element {
  // Latest-value refs so prop changes don't tear down and rebuild the editor.
  // The editor factory (below) reads them lazily; `defaultValueCtx` is captured
  // at mount from the initial ref values, later edits read the synced values.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const onReadyRef = useRef(onReady);
  useLayoutEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    readOnlyRef.current = readOnly;
    onReadyRef.current = onReady;
  });

  const { get } = useEditor((root) =>
    configureRichEditor(root, {
      getValue: () => valueRef.current,
      getSource: () => valueRef.current,
      isReadOnly: () => readOnlyRef.current,
      onChange: (markdown) => onChangeRef.current(markdown),
      onReady: () => onReadyRef.current?.(),
    }),
  );

  // ProseMirror reads `editable` during `updateState`; dispatching an empty
  // transaction forces it to re-read after `readOnly` toggles, so the mode
  // switch takes effect without remounting (and losing edit history).
  useEffect(() => {
    const editor = get();
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr);
    });
  }, [readOnly, get]);

  return <Milkdown />;
}

/** Width of the centered prose column — mirrors the rendered viewer. */
const CONTENT_MAX_WIDTH = 880;
const MONO_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * Headless Milkdown themed to mirror the rendered viewer: the same
 * centered 760px prose column, the same `theme.typography` heading scale, code
 * blocks on the `background.neutral` surface, and `divider`-colored table cells.
 * "Looks like the rendered view, but editable." All values are theme tokens
 * (`theme.vars.palette.*`, `theme.typography`, `theme.spacing`) — no hex, no
 * `palette.mode` branching — so light/dark resolve via CSS variables.
 *
 * NOTE: exact heading-scale parity with the viewer is confirmed at consolidation;
 * the viewer ships in a sibling lane, so the mapping below applies the
 * shared theme variants (h1→h4 … h6→subtitle2) rather than reverse-engineering it.
 */
export const buildRichEditorSx = (placeholder: string): SxProps<Theme> => (theme) => ({
  "& .milkdown": {
    color: theme.vars.palette.text.primary,
    ...theme.typography.body1,
  },
  "& .ProseMirror": {
    // The rendered-view prose column: max 880px, centered in the pane.
    maxWidth: CONTENT_MAX_WIDTH,
    marginInline: "auto",
    outline: "none",
    minHeight: theme.spacing(12),
    "&:focus-visible": { outline: "none" },
    "& > :first-of-type": { marginTop: 0 },
    // Ghost placeholder on an empty editable document. An empty ProseMirror
    // doc is exactly one paragraph holding only the trailing <br>, so this
    // matches nothing once real content (or a heading) exists.
    '&[contenteditable="true"] > p:first-of-type:last-of-type:has(> br.ProseMirror-trailingBreak:only-child)::before':
      {
        // JSON.stringify wraps the translated copy in the double-quotes CSS
        // `content` requires and escapes any quotes inside it.
        content: JSON.stringify(placeholder),
        color: theme.vars.palette.text.disabled,
      },
    "& p": { margin: theme.spacing(1.5, 0) },
    "& h1": { ...theme.typography.h4, margin: theme.spacing(3, 0, 1.5) },
    "& h2": { ...theme.typography.h5, margin: theme.spacing(3, 0, 1.5) },
    "& h3": { ...theme.typography.h6, margin: theme.spacing(2.5, 0, 1) },
    "& h4": { ...theme.typography.subtitle1, margin: theme.spacing(2.5, 0, 1) },
    "& h5": { ...theme.typography.subtitle2, margin: theme.spacing(2, 0, 1) },
    "& h6": {
      ...theme.typography.subtitle2,
      color: theme.vars.palette.text.secondary,
      margin: theme.spacing(2, 0, 1),
    },
    "& ul, & ol": { paddingLeft: theme.spacing(3), margin: theme.spacing(1.5, 0) },
    "& li": { margin: theme.spacing(0.5, 0) },
    "& a": { color: theme.vars.palette.primary.main },
    "& blockquote": {
      margin: theme.spacing(1.5, 0),
      paddingLeft: theme.spacing(2),
      borderLeft: `${theme.spacing(0.5)} solid ${theme.vars.palette.divider}`,
      color: theme.vars.palette.text.secondary,
    },
    "& code": {
      fontFamily: MONO_FONT_FAMILY,
      fontSize: "0.8125rem", // 13px, matches the raw/code surface
      backgroundColor: theme.vars.palette.background.neutral,
      padding: theme.spacing(0.25, 0.75),
      // Explicit px: inside sx a bare number is multiplied by shape.borderRadius.
      borderRadius: `${theme.shape.borderRadius}px`,
    },
    // Code blocks share the viewer's code surface.
    "& pre": {
      margin: theme.spacing(1.5, 0),
      padding: theme.spacing(2),
      fontFamily: MONO_FONT_FAMILY,
      fontSize: "0.8125rem",
      backgroundColor: theme.vars.palette.background.neutral,
      borderRadius: `${theme.shape.borderRadius}px`,
      overflowX: "auto",
      "& code": { backgroundColor: "transparent", padding: 0, fontSize: "inherit" },
    },
    "& table": { borderCollapse: "collapse", margin: theme.spacing(1.5, 0) },
    // Subtle cell borders in the divider color.
    "& th, & td": {
      border: `1px solid ${theme.vars.palette.divider}`,
      padding: theme.spacing(0.75, 1.5),
    },
    "& hr": {
      border: "none",
      borderTop: `1px solid ${theme.vars.palette.divider}`,
      margin: theme.spacing(3, 0),
    },
  },
});

/**
 * Client-only rich markdown editor. Renders nothing on the server (and until
 * mounted on the client) to avoid a hydration mismatch, since Milkdown/ProseMirror
 * can only initialize against a real DOM.
 */
export function RichMarkdownEditor({
  toolbar = false,
  ...props
}: RichMarkdownEditorProps): React.JSX.Element | null {
  const { t } = useTranslate();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const richEditorSx = buildRichEditorSx(t("dashboard.context.editor.richPlaceholder"));

  if (toolbar) {
    // Fixed-toolbar layout: the toolbar row never scrolls; only
    // the prose column below it does. The caller provides a flex-column box.
    return (
      <MilkdownProvider>
        <RichEditorToolbar disabled={props.readOnly} />
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", px: 6, py: 4.5 }}>
          <Box sx={richEditorSx}>
            <RichMarkdownEditorInner {...props} />
          </Box>
        </Box>
      </MilkdownProvider>
    );
  }

  return (
    <MilkdownProvider>
      <Box sx={richEditorSx}>
        <RichMarkdownEditorInner {...props} />
      </Box>
    </MilkdownProvider>
  );
}
