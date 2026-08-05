import type { CmdKey } from "@milkdown/core";
import { toggleLinkCommand, updateLinkCommand } from "@milkdown/preset-commonmark";
import type { EditorState, Selection } from "@milkdown/prose/state";
import type { MarkType } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";

export interface LinkContext {
  /** A non-empty text selection — a target for a brand-new link. */
  hasSelection: boolean;
  /** The href of the link mark under the cursor/selection, or null when none. */
  existingHref: string | null;
}

/** Minimal command surface (`commandsCtx`) — narrowed so the routing is testable. */
interface CommandCaller {
  call: <T>(key: CmdKey<T>, payload?: T) => void;
}

/**
 * The link mark's node range + href covering the selection. Mirrors
 * `updateLinkCommand`'s own scan (first link node in `[from, to)`, extended by
 * one when the selection is a bare cursor) so prefill/remove target exactly the
 * node the Milkdown command will act on.
 */
function linkMarkAt(
  state: EditorState,
  linkType: MarkType,
  selection: Selection,
): { from: number; to: number; href: string } | null {
  const { from, to } = selection;
  // The selection can point past this state's document: the plugin listener
  // fires the post-change selection against the pre-change (smaller) state, so a
  // caret typed at the document's end lands at the old doc's `content.size`. The
  // bare-cursor `to + 1` left-edge probe then overshoots, and `nodesBetween`
  // walks past the last node and dereferences `undefined.nodeSize`. Clamp the
  // scan end to the document so the probe stays in range.
  const scanTo = Math.min(from === to ? to + 1 : to, state.doc.content.size);
  let result: { from: number; to: number; href: string } | null = null;
  state.doc.nodesBetween(from, scanTo, (node, pos) => {
    if (result) return false;
    const mark = node.marks.find((m) => m.type === linkType);
    if (mark) {
      result = { from: pos, to: pos + node.nodeSize, href: (mark.attrs.href as string) ?? "" };
      return false;
    }
    return undefined;
  });
  return result;
}

/**
 * The full contiguous range of the link covering the selection. A link can span
 * several inline nodes — `[**bold** rest](url)` is a strong node and a text node
 * both carrying the same link mark — so removal must cover the whole run, not
 * just the first node `linkMarkAt` reports. Walks the parent block outward from
 * the anchor node across adjacent nodes carrying a link mark with the same href.
 */
function linkRangeAt(
  state: EditorState,
  linkType: MarkType,
  selection: Selection,
): { from: number; to: number } | null {
  const anchor = linkMarkAt(state, linkType, selection);
  if (!anchor) return null;
  const { href } = anchor;
  const $anchor = state.doc.resolve(anchor.from);
  const parent = $anchor.parent;
  let offset = anchor.from - $anchor.parentOffset;
  let from = anchor.from;
  let to = anchor.to;
  let inRun = false;
  let frozen = false;
  parent.forEach((child) => {
    const childFrom = offset;
    offset += child.nodeSize;
    if (frozen) return;
    const mark = child.marks.find((m) => m.type === linkType);
    const matches = !!mark && ((mark.attrs.href as string) ?? "") === href;
    if (matches) {
      if (!inRun) {
        from = childFrom;
        inRun = true;
      }
      to = offset;
    } else if (inRun) {
      // The run ended; keep it if it covered the anchor node, else look further.
      if (from <= anchor.from && to >= anchor.to) frozen = true;
      else inRun = false;
    }
  });
  return { from, to };
}

/**
 * Whether the selection is a target for a new link and/or already sits in one.
 * `selection` is threaded explicitly because the plugin-listener fires its
 * selection callback during `state.apply`, when `view.state` still holds the
 * pre-change selection — the fresh one arrives as the callback argument.
 */
export function readLinkContext(
  state: EditorState,
  selection: Selection = state.selection,
): LinkContext {
  const linkType = state.schema.marks.link;
  if (!linkType) return { hasSelection: !selection.empty, existingHref: null };
  const mark = linkMarkAt(state, linkType, selection);
  return { hasSelection: !selection.empty, existingHref: mark ? mark.href : null };
}

/** No selection to wrap and no link to edit — the Link button has nothing to act on. */
export function isLinkTargetAbsent(ctx: LinkContext): boolean {
  return !ctx.hasSelection && ctx.existingHref === null;
}

/** The link's full range + href at a document position (for a click target). */
export interface LinkClickTarget {
  href: string;
  from: number;
  to: number;
}

/** Effects a link click can trigger — injected so the routing is testable. */
export interface LinkClickHandlers {
  /** Open the clicked href in a new browser tab (mod-click on a non-empty href). */
  openInNewTab: (href: string) => void;
  /** Open the link editor popover prefilled for the clicked link. */
  openLinkEditor: (target: LinkClickTarget) => void;
}

/**
 * The full contiguous link range + href at a document position, or null when the
 * position carries no link mark. An empty href (`""` — an unfinished `[text]()`)
 * still counts as a link so a click can open the editor to complete it.
 */
export function linkAt(state: EditorState, pos: number): LinkClickTarget | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;
  const cursor = { from: pos, to: pos, empty: true } as unknown as Selection;
  const anchor = linkMarkAt(state, linkType, cursor);
  if (!anchor) return null;
  const range = linkRangeAt(state, linkType, cursor) ?? { from: anchor.from, to: anchor.to };
  return { href: anchor.href, from: range.from, to: range.to };
}

/**
 * Whether a link href is safe to hand to `window.open`: http(s), mailto, or a
 * scheme-less relative href. Author-controlled `javascript:`/`data:`/other
 * schemes are refused so a mod-click can never execute them — it opens the
 * editor instead.
 */
function isSafeExternalHref(rawHref: string): boolean {
  const href = rawHref.trim();
  if (href === "") return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  // No scheme = relative link, safe. Otherwise only the allowlisted schemes.
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

/**
 * Route a click that landed on the rich surface. Returns true when the click was
 * on a link and has been handled — the caller MUST then suppress the browser's
 * navigation (an empty-href `[text]()` otherwise reloads the page and traps the
 * draft behind the unsaved-changes dialog). A mod-click on a safe external href
 * opens it in a new tab; every other link click (empty-href, an unsafe scheme,
 * or a plain click) opens the editor popover. A click off any link returns false.
 */
export function handleLinkClick(
  state: EditorState,
  pos: number,
  modKey: boolean,
  handlers: LinkClickHandlers,
): boolean {
  const target = linkAt(state, pos);
  if (!target) return false;
  if (modKey && isSafeExternalHref(target.href)) {
    handlers.openInNewTab(target.href);
  } else {
    handlers.openLinkEditor(target);
  }
  return true;
}

/** Strips the whole link covering the selection — commonmark ships no remove-link command. */
export function removeLinkAt(view: EditorView): void {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return;
  const range = linkRangeAt(view.state, linkType, view.state.selection);
  if (!range) return;
  view.dispatch(view.state.tr.removeMark(range.from, range.to, linkType));
}

/**
 * Sets, updates, or removes the link on the current selection. A blank URL means
 * remove; an existing link updates its href in place; otherwise the selection is
 * wrapped in a fresh link. Focus is the caller's concern.
 */
export function applyLink(view: EditorView, commands: CommandCaller, rawHref: string): void {
  const href = rawHref.trim();
  const { existingHref } = readLinkContext(view.state);
  if (href === "") {
    if (existingHref !== null) removeLinkAt(view);
    return;
  }
  if (existingHref !== null) {
    commands.call(updateLinkCommand.key, { href });
  } else {
    commands.call(toggleLinkCommand.key, { href });
  }
}
