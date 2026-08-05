import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export interface UnsavedChangesGuardArgs {
  /** Arm the guard — true while the editor has unsaved (dirty) edits. */
  when: boolean;
  /**
   * Called when an in-app navigation is intercepted while armed. Receives a
   * `proceed` continuation the confirm dialog calls to allow the navigation.
   */
  onBlockedNavigation: (proceed: () => void) => void;
}

/** Same-origin, same-tab link that App Router navigation would handle. */
function isInAppNavigation(anchor: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return false;
  // Absolute URLs to another origin are real page loads — beforeunload covers
  // them; only intercept in-app (relative or same-origin) navigations here.
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Dirty-state guard. Two paths, both armed only while `when` is true:
 *  - browser unload (tab close / reload / address-bar / external nav) via
 *    `beforeunload` — the only guard for navigations with no anchor to
 *    intercept;
 *  - same-origin in-app anchor navigation via a capture-phase click
 *    interceptor (App Router exposes no route-change-abort API). The
 *    intercepted navigation is handed to `onBlockedNavigation` as a `proceed`
 *    continuation the confirm dialog invokes once the user chooses to leave.
 *
 * Confirmed in-app leaves navigate through the App Router (`router.push`, a
 * client transition with no page unload) rather than a full-document load, so
 * the native `beforeunload` prompt cannot double-fire on top of the in-app
 * confirm the user already answered. `bypassRef` guards that interim.
 */
export function useUnsavedChangesGuard({
  when,
  onBlockedNavigation,
}: UnsavedChangesGuardArgs): void {
  const router = useRouter();
  // Set by a confirmed in-app leave immediately before it navigates. Consulted
  // at the top of the `beforeunload` handler so the native prompt stays
  // suppressed for the navigation the user just confirmed. It is never set for
  // genuine unloads (tab close / reload), so those still prompt.
  const bypassRef = useRef(false);

  useEffect(() => {
    if (!when) return;
    const handler = (event: BeforeUnloadEvent) => {
      if (bypassRef.current) return;
      event.preventDefault();
      // Legacy Chrome requires a truthy returnValue to trigger the prompt.
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [when]);

  useEffect(() => {
    if (!when) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (!isInAppNavigation(anchor, event)) return;
      const href = anchor.getAttribute("href")!;
      event.preventDefault();
      event.stopPropagation();
      onBlockedNavigation(() => {
        bypassRef.current = true;
        // `isInAppNavigation` guarantees a same-origin href — hand the App
        // Router the path portion so it does a client transition, not a reload.
        const url = new URL(href, window.location.href);
        router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [when, onBlockedNavigation, router]);
}
