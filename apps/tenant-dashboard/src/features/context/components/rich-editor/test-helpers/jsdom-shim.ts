import { JSDOM } from "jsdom";

/**
 * Milkdown/ProseMirror can only initialize against a DOM. The O-2 spike proved
 * out a hand-rolled jsdom global shim (no first-party headless mode exists); this
 * ports it so the round-trip and change-forwarding tests run headless under
 * Vitest's default `node` environment. Idempotent — safe to import from many test
 * files; installs the globals once.
 */
let installed: { window: Window; document: Document } | null = null;

export function installJsdom(): { window: Window; document: Document } {
  if (installed) return installed;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
    writable: true,
  });
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "EventTarget",
    "getComputedStyle",
    "MutationObserver",
    "DOMParser",
    "Range",
  ] as const) {
    const value = (window as unknown as Record<string, unknown>)[key];
    if (value) g[key] = value;
  }
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.addEventListener = window.addEventListener.bind(window);
  g.removeEventListener = window.removeEventListener.bind(window);
  g.dispatchEvent = window.dispatchEvent.bind(window);
  if (!window.document.getSelection) {
    window.document.getSelection = () =>
      ({ removeAllRanges() {}, addRange() {}, rangeCount: 0 }) as unknown as Selection;
  }

  installed = { window: window as unknown as Window, document: window.document as unknown as Document };
  return installed;
}
