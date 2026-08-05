import { useEffect, useRef } from "react";

/**
 * The id adjacent to `currentId` in `ids`, stepping by `direction` (+1 = next,
 * -1 = previous). Returns null at the list boundaries, when `currentId` is
 * absent from the list, or when there is no selection — keyboard nav is a no-op
 * at the edges rather than wrapping around. Pure + exported so the stepping
 * rules are unit-tested directly rather than through the DOM.
 */
export function getAdjacentId(
  ids: string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (!currentId) return null;
  const index = ids.indexOf(currentId);
  if (index === -1) return null;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= ids.length) return null;
  // Bounds already checked above; `?? null` only satisfies the
  // noUncheckedIndexedAccess `string | undefined` element type.
  return ids[nextIndex] ?? null;
}

/**
 * Whether a keystroke originated in a field where typing "j"/"k" must be left
 * alone (search boxes, annotation text, etc.) rather than hijacked for nav.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

interface UseListKeyboardNavOptions {
  /** Ordered ids of the currently displayed rows. */
  ids: string[];
  /** The id of the open detail view, or null when nothing is open. */
  currentId: string | null;
  /** Bind the shortcuts only while true (e.g. the detail drawer is open). */
  enabled: boolean;
  /** Called with the adjacent id when the user steps to it. */
  onNavigate: (id: string) => void;
}

/**
 * Wires j / k (next / previous) keyboard navigation across a list while a detail
 * view is open. Lets a reviewer step through traces/sessions without returning
 * to the table. Ignores keystrokes typed into form fields, modifier combos, and
 * is a no-op at the list boundaries (no wrap-around).
 */
export function useListKeyboardNav({
  ids,
  currentId,
  enabled,
  onNavigate,
}: UseListKeyboardNavOptions): void {
  // Keep the latest values in a ref so the keydown listener binds once per
  // open/close and always reads fresh state — the list and selected id change
  // on every step, and a stale closure would navigate from the wrong row. The
  // ref is refreshed in an effect (not during render) so a re-render never
  // mutates it mid-render; effects commit before the next user keystroke.
  const latest = useRef({ ids, currentId, onNavigate });
  useEffect(() => {
    latest.current = { ids, currentId, onNavigate };
  });

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      if (isEditableTarget(event.target)) return;

      const { ids, currentId, onNavigate } = latest.current;
      const nextId = getAdjacentId(ids, currentId, key === "j" ? 1 : -1);
      if (nextId === null) return;

      event.preventDefault();
      onNavigate(nextId);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
