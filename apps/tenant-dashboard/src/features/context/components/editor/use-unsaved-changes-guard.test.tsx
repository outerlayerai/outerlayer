// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

/**
 * Fires a cancelable `beforeunload` and reports whether a handler prompted.
 * On a plain `Event`, `returnValue` is the legacy alias of `!defaultPrevented`
 * (setting it falsy calls `preventDefault`), so `defaultPrevented` is the
 * observable "the native prompt fires" signal the guard's handler drives.
 */
function dispatchBeforeUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function Harness({
  when,
  onBlocked,
  href = "/somewhere-else",
  target,
  download,
}: {
  when: boolean;
  onBlocked: (proceed: () => void) => void;
  href?: string;
  target?: string;
  download?: boolean;
}) {
  useUnsavedChangesGuard({ when, onBlockedNavigation: onBlocked });
  return (
    <a
      href={href}
      data-testid="link"
      {...(target !== undefined ? { target } : {})}
      {...(download ? { download: "" } : {})}
    >
      go
    </a>
  );
}

afterEach(cleanup);

describe("useUnsavedChangesGuard", () => {
  it("registers a beforeunload listener while armed and removes it when disarmed", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const { rerender } = render(<Harness when onBlocked={vi.fn()} />);
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);

    rerender(<Harness when={false} onBlocked={vi.fn()} />);
    expect(remove.mock.calls.some(([type]) => type === "beforeunload")).toBe(
      true,
    );

    add.mockRestore();
    remove.mockRestore();
  });

  it("never registers a beforeunload listener while clean (armed is the gate, not mount)", () => {
    const add = vi.spyOn(window, "addEventListener");

    render(<Harness when={false} onBlocked={vi.fn()} />);
    expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toEqual(
      [],
    );

    add.mockRestore();
  });

  it("intercepts an in-app navigation while dirty, preventing default and handing back a proceed continuation", () => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(typeof onBlocked.mock.calls[0]![0]).toBe("function");
    // fireEvent.click returns false when a handler called preventDefault.
    expect(notPrevented).toBe(false);
  });

  it("lets in-app navigation through when the editor is clean", () => {
    const onBlocked = vi.fn();
    render(<Harness when={false} onBlocked={onBlocked} />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("does not intercept cross-origin links (a real page load beforeunload already covers)", () => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} href="https://example.com/x" />);

    fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("stops intercepting once disarmed by a rerender (the interceptor tracks `when`, not mount)", () => {
    const onBlocked = vi.fn();
    const { rerender } = render(<Harness when onBlocked={onBlocked} />);
    rerender(<Harness when={false} onBlocked={onBlocked} />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
  ])("lets a %s-click through (open-in-new-tab/window gestures are not in-app navigation)", (_name, init) => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"), init);

    expect(onBlocked).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("lets a non-primary (middle/right) button click through", () => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"), { button: 1 });

    expect(onBlocked).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("lets a target=_blank link through but still intercepts target=_self", () => {
    const onBlocked = vi.fn();
    const { unmount } = render(
      <Harness when onBlocked={onBlocked} target="_blank" />,
    );
    fireEvent.click(screen.getByTestId("link"));
    expect(onBlocked).not.toHaveBeenCalled();
    unmount();

    // `_self` is the same tab — exactly what the guard exists to intercept.
    render(<Harness when onBlocked={onBlocked} target="_self" />);
    const notPrevented = fireEvent.click(screen.getByTestId("link"));
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("lets a download link through", () => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} download />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("lets a same-page hash link through", () => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} href="#section" />);

    const notPrevented = fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("lets an unparseable href through (fail-open to the browser's own handling)", () => {
    const onBlocked = vi.fn();
    render(<Harness when onBlocked={onBlocked} href="http://" />);

    fireEvent.click(screen.getByTestId("link"));

    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("defers to an earlier handler that already prevented the click", () => {
    const onBlocked = vi.fn();
    // Window capture runs before the guard's document-capture interceptor.
    const preventFirst = (e: Event) => e.preventDefault();
    window.addEventListener("click", preventFirst, true);
    try {
      render(<Harness when onBlocked={onBlocked} />);
      fireEvent.click(screen.getByTestId("link"));
      expect(onBlocked).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("click", preventFirst, true);
    }
  });

  it("prompts on a genuine unload while dirty (beforeunload fires when no in-app leave has bypassed it)", () => {
    render(<Harness when onBlocked={vi.fn()} />);

    expect(dispatchBeforeUnload()).toBe(true);
  });

  it("confirm continuation navigates via router.push and then suppresses the native beforeunload prompt", () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    let proceed: (() => void) | null = null;
    const onBlocked = vi.fn((p: () => void) => {
      proceed = p;
    });
    render(<Harness when onBlocked={onBlocked} href="/topics?tab=a#h" />);

    fireEvent.click(screen.getByTestId("link"));
    expect(onBlocked).toHaveBeenCalledTimes(1);

    // Before the user confirms, an unload still prompts (bypass unset).
    expect(dispatchBeforeUnload()).toBe(true);

    proceed!();

    // Confirmed leave routes through the App Router (path portion only, no reload)…
    expect(push).toHaveBeenCalledWith("/topics?tab=a#h");
    // …and the native prompt is now suppressed so it can't double-fire.
    expect(dispatchBeforeUnload()).toBe(false);
  });
});
